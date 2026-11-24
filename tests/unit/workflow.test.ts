import { describe, expect, it } from "vitest";
import { fill, nextPhase, outputProblems, parseWorkflow, phaseById, WorkflowError } from "../../src/core/workflow.js";
import { SMALL, TEMPLATE } from "../helpers.js";

const problems = (yaml: string): string[] => {
  try { parseWorkflow(yaml); return []; }
  catch (e) { if (e instanceof WorkflowError) return e.problems; throw e; }
};

describe("parseWorkflow", () => {
  it("accepts the shipped starter template", () => {
    const wf = parseWorkflow(TEMPLATE);
    expect(wf.phases.map(p => p.id)).toEqual(["plan", "design", "build", "test", "publish", "review", "deploy"]);
  });

  it("accepts the small test workflow", () => {
    expect(parseWorkflow(SMALL).name).toBe("small");
  });

  it("reports a YAML syntax error", () => {
    expect(problems("version: 1\nphases: [unclosed")[0]).toMatch(/^YAML:/);
  });

  it("requires version 1, a name and at least one phase", () => {
    const p = problems("version: 2\nphases: []");
    expect(p.join("\n")).toMatch(/version/);
    expect(p.join("\n")).toMatch(/name/);
    expect(p.join("\n")).toMatch(/phases/);
  });

  it("rejects unknown keys, so typos don't silently do nothing", () => {
    expect(problems("version: 1\nname: x\nphases:\n  - id: a\n    goal: g\n    gatez: [x]").join()).toMatch(/additional properties/);
  });

  it("rejects bad phase ids and agent names", () => {
    expect(problems("version: 1\nname: x\nphases:\n  - id: Bad Id\n    goal: g").join()).toMatch(/pattern/);
    expect(problems("version: 1\nname: x\nphases:\n  - id: a\n    goal: g\n    agent: 'x:y'").join()).toMatch(/pattern/);
  });

  it("rejects duplicate phase ids", () => {
    expect(problems("version: 1\nname: x\nphases:\n  - {id: a, goal: g}\n  - {id: a, goal: h}")).toContain('phase "a" is defined twice');
  });

  it("rejects next and on_fail that point to no phase", () => {
    const p = problems("version: 1\nname: x\nphases:\n  - {id: a, goal: g, next: nope}");
    expect(p).toContain('phase "a": next "nope" is not a phase');
  });

  it("requires an outputs schema that exists, and an on_fail", () => {
    const p = problems("version: 1\nname: x\nphases:\n  - id: r\n    goal: g\n    outputs: {schema: missing, required: [a]}");
    expect(p).toContain('phase "r": outputs.schema "missing" is not in schemas');
    expect(p).toContain('phase "r": outputs need on_fail (where to go on a blocking finding)');
  });

  it("requires guarded commands to be declared in policy and unlocked by a before-approval or unlock_after", () => {
    const p = problems("version: 1\nname: x\nphases:\n  - id: d\n    goal: g\n    allow: {guarded: ['git push*']}");
    expect(p).toContain('phase "d": allow.guarded "git push*" is not in policy.guarded_shell or policy.guarded_mcp');
    expect(p.some(x => x.includes("needs approval: before") && x.includes("unlock_after"))).toBe(true);
  });

  it("accepts guarded MCP tools unlocked by an earlier phase", () => {
    expect(problems("version: 1\nname: x\npolicy: {guarded_mcp: ['*:merge_pull_request']}\nphases:\n  - {id: r, goal: g}\n" +
      "  - {id: d, goal: g, unlock_after: r, allow: {guarded: ['*:merge_pull_request']}}")).toEqual([]);
  });

  it("requires unlock_after to name an earlier phase", () => {
    const base = "version: 1\nname: x\nphases:\n  - {id: a, goal: g, unlock_after: X}\n  - {id: b, goal: g}";
    expect(problems(base.replace("X", "nope"))).toContain('phase "a": unlock_after "nope" is not a phase');
    expect(problems(base.replace("X", "b"))).toContain('phase "a": unlock_after "b" must be an earlier phase');
    expect(problems(base.replace("X", "a"))).toContain('phase "a": unlock_after "a" must be an earlier phase');
  });

  it("caps max_attempts_per_phase below Claude Code's stop-hook limit", () => {
    expect(problems("version: 1\nname: x\npolicy: {max_attempts_per_phase: 20}\nphases: [{id: a, goal: g}]").join()).toMatch(/<= 7/);
  });
});

describe("workflow helpers", () => {
  const wf = parseWorkflow(SMALL);

  it("phaseById finds a phase and throws on an unknown one", () => {
    expect(phaseById(wf, "build").goal).toBe("Build it.");
    expect(() => phaseById(wf, "nope")).toThrow(WorkflowError);
  });

  it("nextPhase follows list order, honours next, and ends after the last phase", () => {
    expect(nextPhase(wf, phaseById(wf, "plan"))?.id).toBe("build");
    expect(nextPhase(wf, phaseById(wf, "ship"))).toBeUndefined();
    const jump = parseWorkflow("version: 1\nname: j\nphases:\n  - {id: a, goal: g, next: c}\n  - {id: b, goal: g}\n  - {id: c, goal: g}");
    expect(nextPhase(jump, phaseById(jump, "a"))?.id).toBe("c");
  });

  it("fill substitutes task, phase and round", () => {
    expect(fill("{task}/{phase}-r{round}", { task: "t1", phase: "build", round: 2 })).toBe("t1/build-r2");
  });

  it("outputProblems validates agent output against a named schema", () => {
    expect(outputProblems(wf, "review", { verdict: "approve", findings: [] })).toEqual([]);
    expect(outputProblems(wf, "review", { verdict: "maybe" }).join()).toMatch(/findings|allowed values/);
  });
});
