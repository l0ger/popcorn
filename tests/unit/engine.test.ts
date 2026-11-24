import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine.js";
import type { Decision, NormalizedEvent, RunState } from "../../src/core/types.js";
import { agentRef, MemoryEnv, PROJECT, SMALL } from "../helpers.js";

let env: MemoryEnv;
let engine: Engine;
let gateCode: number;

const prompt = (text: string): NormalizedEvent => ({ type: "prompt", projectDir: PROJECT, prompt: text });
const stop: NormalizedEvent = { type: "stop", projectDir: PROJECT, stopHookActive: false };
const tool = (command: string): NormalizedEvent => ({ type: "before_tool", projectDir: PROJECT, call: { kind: "shell", command, tool: "Bash" } });
const state = (): RunState => JSON.parse(env.get(".popcorn/runs/t1/state.json")!) as RunState;
const handle = (e: NormalizedEvent): Decision => engine.handle(e);
const text = (d: Decision) => ("text" in d ? d.text : "reason" in d ? d.reason : "message" in d ? d.message : "");

beforeEach(() => {
  gateCode = 0;
  env = new MemoryEnv(cmd => (cmd.startsWith("git rev-parse") ? { code: 0, output: "abc\n" } : { code: gateCode, output: `ran ${cmd}` }));
  env.put(".popcorn/workflow.yaml", SMALL);
  engine = new Engine(env, agentRef);
});

/** Runs a fresh t1 through Plan (artifact + approval) into Build. */
function toBuild() {
  handle(prompt("popcorn start t1 Add login"));
  env.put("docs/t1.md");
  handle(stop);
  handle(prompt("popcorn approve"));
}

describe("without an active run", () => {
  it("passes every event silently", () => {
    expect(handle(stop)).toEqual({ kind: "pass" });
    expect(handle(tool("git push"))).toEqual({ kind: "pass" });
    expect(handle(prompt("hello"))).toEqual({ kind: "pass" });
    expect(handle({ type: "session_start", projectDir: PROJECT })).toEqual({ kind: "pass" });
  });

  it("answers a popcorn command with a notice", () => {
    const d = handle(prompt("popcorn approve"));
    expect(d.kind).toBe("context");
    expect(d.kind === "context" && d.notice).toMatch(/no run is active/);
  });

  it("explains when the workflow file is missing", () => {
    env.files.delete(`${PROJECT}/.popcorn/workflow.yaml`);
    const d = handle(prompt("popcorn start t1"));
    expect(d.kind === "context" && d.notice).toMatch(/workflow.yaml is missing/);
  });

  it("rejects an invalid task name", () => {
    const d = handle(prompt("popcorn start Bad_Name"));
    expect(d.kind === "context" && d.notice).toMatch(/lowercase/);
  });
});

describe("starting a run", () => {
  it("creates the run at the first phase and briefs the agent", () => {
    const d = handle(prompt("popcorn start t1 Add login"));
    expect(d.kind).toBe("context");
    expect(text(d)).toContain('phase 1/4 "plan"');
    expect(text(d)).toContain("`popcorn:product-manager`");
    expect(text(d)).toContain("Write the plan for t1.");
    expect(env.get(".popcorn/active")?.trim()).toBe("t1");
    expect(state()).toMatchObject({ task: "t1", phase: "plan", status: "running", description: "Add login" });
  });

  it("accepts the slash-command form and ignores the lines after the command", () => {
    handle(prompt("/popcorn:start t1 Add login\n\nIf the context above already shows ..."));
    expect(state().description).toBe("Add login");
  });

  it("refuses a second start while a run is active", () => {
    handle(prompt("popcorn start t1"));
    const d = handle(prompt("popcorn start t2"));
    expect(d.kind === "context" && d.notice).toMatch(/is active/);
  });

  it("briefs the agent again on session start and on ordinary prompts", () => {
    handle(prompt("popcorn start t1"));
    expect(text(handle({ type: "session_start", projectDir: PROJECT }))).toContain('"plan"');
    expect(text(handle(prompt("what next?")))).toContain('"plan"');
  });
});

describe("stop: completing phases", () => {
  it("blocks stopping while artifacts are missing, and counts attempts", () => {
    handle(prompt("popcorn start t1"));
    const d = handle(stop);
    expect(d.kind).toBe("continue");
    expect(text(d)).toContain("missing artifacts: docs/t1.md");
    expect(text(d)).toContain("attempt 1/2");
    expect(state().attempts.plan).toBe(1);
  });

  it("escalates to the user after max attempts, then retry resets", () => {
    handle(prompt("popcorn start t1"));
    handle(stop); handle(stop);
    const d = handle(stop);
    expect(d.kind).toBe("halt");
    expect(state().status).toBe("escalated");
    expect(handle(stop).kind).toBe("halt");
    handle(prompt("popcorn retry try harder"));
    expect(state()).toMatchObject({ status: "running", feedback: "try harder" });
    expect(state().attempts.plan).toBe(0);
  });

  it("waits for approval after a phase with approval: after", () => {
    handle(prompt("popcorn start t1"));
    env.put("docs/t1.md");
    const d = handle(stop);
    expect(d.kind).toBe("halt");
    expect(text(d)).toMatch(/waiting for your approval/);
    expect(state().status).toBe("awaiting_approval");
    expect(handle(stop).kind).toBe("halt");
  });

  it("approve moves on to the next phase", () => {
    toBuild();
    expect(state()).toMatchObject({ phase: "build", status: "running" });
    expect(Object.keys(state().approvals)).toEqual(["plan#1#after"]);
  });

  it("reject keeps the phase, with the user's feedback in the brief", () => {
    handle(prompt("popcorn start t1"));
    env.put("docs/t1.md");
    handle(stop);
    const d = handle(prompt("popcorn reject cover password reset too"));
    expect(state()).toMatchObject({ phase: "plan", status: "running", feedback: "cover password reset too" });
    expect(text(d)).toContain("Feedback to address first: cover password reset too");
  });

  it("approve and reject do nothing when nothing is waiting", () => {
    handle(prompt("popcorn start t1"));
    const d = handle(prompt("popcorn approve"));
    expect(d.kind === "context" && d.notice).toMatch(/nothing is waiting/);
    expect(state().approvals).toEqual({});
  });

  it("blocks stopping while a gate fails, showing its output", () => {
    toBuild();
    gateCode = 1;
    const d = handle(stop);
    expect(d.kind).toBe("continue");
    expect(text(d)).toContain("gate `make test` failed (exit 1)");
    expect(text(d)).toContain("ran make test");
  });

  it("fills {task} and {round} into gate commands", () => {
    env.put(".popcorn/workflow.yaml", SMALL.replace('"make test"', '"make test T={task} R={round}"'));
    toBuild();
    const d = handle(stop);
    expect(env.commands).toContain("make test T=t1 R=1");
    expect(text(d)).not.toContain("{task}");
  });

  it("doesn't rerun a gate when the working tree hasn't changed", () => {
    toBuild();
    gateCode = 1;
    handle(stop);
    handle(stop);
    expect(env.commands.filter(c => c === "make test")).toHaveLength(1);
  });

  it("moves on when the gate passes, and continues the agent with the next brief", () => {
    toBuild();
    const d = handle(stop);
    expect(d.kind).toBe("continue");
    expect(text(d)).toContain('"review"');
    expect(text(d)).toContain(".popcorn/outputs/t1/review-r1/<agent-name>.json");
    expect(state().phase).toBe("review");
  });
});

describe("stop: review outputs", () => {
  const out = (round: number, data: unknown) => env.put(`.popcorn/outputs/t1/review-r${round}/code-reviewer.json`, JSON.stringify(data));
  beforeEach(() => { toBuild(); handle(stop); });

  it("blocks while a required output is missing or invalid", () => {
    expect(text(handle(stop))).toContain("code-reviewer.json is missing");
    env.put(".popcorn/outputs/t1/review-r1/code-reviewer.json", "{not json");
    expect(text(handle(stop))).toContain("is not valid JSON");
    out(1, { verdict: "maybe", findings: [] });
    expect(text(handle(stop))).toContain('does not match schema "review"');
  });

  it("sends the run back to on_fail on a blocking finding, in a new round", () => {
    out(1, { verdict: "changes_requested", findings: [{ severity: "HIGH", title: "SQL injection in login" }] });
    const d = handle(stop);
    expect(d.kind).toBe("continue");
    expect(text(d)).toContain("[HIGH] SQL injection in login");
    expect(text(d)).toContain('Back to phase "build"');
    expect(state()).toMatchObject({ phase: "build", rounds: { build: 2 } });
  });

  it("needs a fresh output in the next review round", () => {
    out(1, { verdict: "changes_requested", findings: [{ severity: "BLOCKER", title: "x" }] });
    handle(stop);           // → build r2
    handle(stop);           // build gate passes → review r2
    expect(state()).toMatchObject({ phase: "review", rounds: { review: 2 } });
    expect(text(handle(stop))).toContain("review-r2/code-reviewer.json is missing");
  });

  it("moves on with only non-blocking findings, and waits before a phase with approval: before", () => {
    out(1, { verdict: "approve", findings: [{ severity: "LOW", title: "naming" }] });
    const d = handle(stop);
    expect(d.kind).toBe("halt");
    expect(text(d)).toMatch(/approval to start phase "ship"/);
    expect(state()).toMatchObject({ phase: "ship", status: "awaiting_approval" });
  });
});

describe("guarded commands and finishing", () => {
  beforeEach(() => {
    toBuild();
    handle(stop);
    env.put(".popcorn/outputs/t1/review-r1/code-reviewer.json", JSON.stringify({ verdict: "approve", findings: [] }));
    handle(stop);
  });

  it("refuses the push until the user approves the phase, then allows it", () => {
    expect(handle(tool("git push origin main")).kind).toBe("deny");
    handle(prompt("popcorn approve"));
    expect(state().status).toBe("running");
    expect(handle(tool("git push origin main"))).toEqual({ kind: "pass" });
  });

  it("finishes the run after the last phase and clears the active run", () => {
    handle(prompt("popcorn approve"));
    const d = handle(stop);
    expect(d.kind).toBe("halt");
    expect(text(d)).toMatch(/complete/);
    expect(state().status).toBe("done");
    expect(env.get(".popcorn/active")).toBe("");
    expect(handle(tool("git push"))).toEqual({ kind: "pass" });
  });
});

describe("other commands", () => {
  it("abort ends the run and stops enforcing", () => {
    handle(prompt("popcorn start t1"));
    handle(prompt("popcorn abort"));
    expect(state().status).toBe("aborted");
    expect(handle(tool("git push"))).toEqual({ kind: "pass" });
  });

  it("status shows the phase", () => {
    handle(prompt("popcorn start t1"));
    const d = handle(prompt("popcorn status"));
    expect(d.kind === "context" && d.notice).toMatch(/phase 1\/4 "plan".*running/);
  });

  it("a finished run lets a new one start", () => {
    handle(prompt("popcorn start t1"));
    handle(prompt("popcorn abort"));
    handle(prompt("popcorn start t2"));
    expect(env.get(".popcorn/active")?.trim()).toBe("t2");
  });

  it("records every step in the run's history", () => {
    toBuild();
    expect(state().history.map(h => h.event)).toEqual(["start", "complete", "approve", "enter"]);
  });
});

describe("fail safe", () => {
  it("denies tools and lets the agent stop when the workflow breaks mid-run", () => {
    handle(prompt("popcorn start t1"));
    env.put(".popcorn/workflow.yaml", "version: [broken");
    const t = handle(tool("ls"));
    expect(t.kind).toBe("deny");
    expect(text(t)).toMatch(/popcorn engine error/);
    expect(handle(stop).kind).toBe("halt");
    expect(handle(prompt("hi")).kind).toBe("context");
  });

  it("denies tools when the state file is corrupt", () => {
    handle(prompt("popcorn start t1"));
    env.put(".popcorn/runs/t1/state.json", "{");
    expect(handle(tool("ls")).kind).toBe("deny");
  });

  it("denies tools when the run's phase is no longer in the workflow", () => {
    handle(prompt("popcorn start t1"));
    env.put(".popcorn/workflow.yaml", SMALL.replace("id: plan", "id: planning"));
    expect(handle(tool("ls")).kind).toBe("deny");
  });
});
