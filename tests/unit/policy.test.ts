import { describe, expect, it } from "vitest";
import { approvalKey, checkTool, projectRelative, shellSegments } from "../../src/core/policy.js";
import { parseWorkflow, phaseById } from "../../src/core/workflow.js";
import type { RunState, ToolCall } from "../../src/core/types.js";
import { PROJECT, SMALL } from "../helpers.js";

const wf = parseWorkflow(SMALL);
const state = (phase: string, extra: Partial<RunState> = {}): RunState => ({
  version: 1, task: "t1", workflow: "small", phase, status: "running", rounds: { [phase]: 1 },
  attempts: {}, approvals: {}, gateCache: {}, startedAt: "", history: [], ...extra,
});
const check = (phase: string, call: ToolCall, extra: Partial<RunState> = {}, agent?: string) =>
  checkTool(wf, phaseById(wf, phase), state(phase, extra), call, PROJECT, agent);
const edit = (path: string): ToolCall => ({ kind: "edit", path, tool: "Edit" });
const sh = (command: string): ToolCall => ({ kind: "shell", command, tool: "Bash" });

describe("shellSegments", () => {
  it("splits chained commands", () => {
    expect(shellSegments("npm test && git push; echo hi | cat || true")).toEqual(["npm test", "git push", "echo hi", "cat", "true"]);
  });
  it("looks inside bash -c and sh -c", () => {
    expect(shellSegments(`bash -c 'cd x && git push origin main'`)).toEqual(["cd x", "git push origin main"]);
    expect(shellSegments(`sh -c "git push"`)).toEqual(["git push"]);
  });
  it("drops env assignments, sudo and env prefixes", () => {
    expect(shellSegments("FOO=1 BAR=2 git push")).toEqual(["git push"]);
    expect(shellSegments("sudo env git push")).toEqual(["git push"]);
  });
  it("drops git's global options, so they can't hide the subcommand", () => {
    expect(shellSegments("git -C . push origin main")).toEqual(["git push origin main"]);
    expect(shellSegments(`git -c user.name=x --no-pager -C "/a b" push`)).toEqual(["git push"]);
    expect(shellSegments("git --git-dir=.git --work-tree=. push")).toEqual(["git push"]);
    expect(shellSegments("/usr/bin/git push")).toEqual(["git push"]);
    expect(shellSegments("git -C ../main merge --no-ff ws/x")).toEqual(["git merge --no-ff ws/x"]);
    expect(shellSegments("git status")).toEqual(["git status"]);
  });
  it("doesn't split on separators inside quotes", () => {
    expect(shellSegments(`echo "a && b; c" && ls`)).toEqual([`echo "a && b; c"`, "ls"]);
    expect(shellSegments(`git commit -m 'fix: x | y'`)).toEqual([`git commit -m 'fix: x | y'`]);
  });
  it("handles multi-line commands and subshell parentheses", () => {
    expect(shellSegments("(git push)\nls")).toEqual(["git push", "ls"]);
  });
});

describe("projectRelative", () => {
  it("returns a project-relative path", () => {
    expect(projectRelative(PROJECT, `${PROJECT}/src/a.ts`)).toBe("src/a.ts");
    expect(projectRelative(PROJECT, "docs/x.md")).toBe("docs/x.md");
  });
  it("returns null outside the project, including via ..", () => {
    expect(projectRelative(PROJECT, "/etc/passwd")).toBeNull();
    expect(projectRelative(PROJECT, `${PROJECT}/../other/x`)).toBeNull();
    expect(projectRelative(PROJECT, PROJECT)).toBeNull();
  });
});

describe("checkTool: edits", () => {
  it("never allows editing popcorn's run state or the workflow", () => {
    expect(check("build", edit(`${PROJECT}/.popcorn/runs/t1/state.json`))).toMatch(/protected/);
    expect(check("build", edit(`${PROJECT}/.popcorn/workflow.yaml`))).toMatch(/protected/);
    expect(check("build", edit(`${PROJECT}/.popcorn/active`))).toMatch(/protected/);
  });
  const verdict = `${PROJECT}/.popcorn/outputs/t1/review-r1/code-reviewer.json`;
  it("lets a required agent write its own output, namespaced or not", () => {
    expect(check("review", edit(verdict), {}, "popcorn:code-reviewer")).toBeNull();
    expect(check("review", edit(verdict), {}, "code-reviewer")).toBeNull();
  });
  it("refuses an output written by the main session or by another agent", () => {
    expect(check("review", edit(verdict))).toMatch(/must be written by the `code-reviewer` subagent itself, not by the main session/);
    expect(check("review", edit(verdict), {}, "popcorn:implementer")).toMatch(/not by `popcorn:implementer`/);
    expect(check("review", edit(verdict), {}, "my-code-reviewer-x")).toMatch(/must be written/);
  });
  it("refuses other files under .popcorn, and outputs of another round or phase", () => {
    expect(check("review", edit(`${PROJECT}/.popcorn/.gitignore`), {}, "code-reviewer")).toMatch(/only this phase's agent outputs/);
    expect(check("review", edit(`${PROJECT}/.popcorn/outputs/t1/review-r2/code-reviewer.json`), {}, "code-reviewer")).toMatch(/only this phase's agent outputs/);
    expect(check("build", edit(verdict), {}, "code-reviewer")).toMatch(/only this phase's agent outputs/);
    expect(check("review", edit(`${PROJECT}/.popcorn/outputs/t1/review-r1/random.json`), {}, "random")).toMatch(/only this phase's agent outputs/);
  });
  it("refuses files outside the project", () => {
    expect(check("build", edit("/etc/hosts"))).toMatch(/outside the project/);
  });
  it("limits edits to the phase's allow.edit globs", () => {
    expect(check("plan", edit(`${PROJECT}/docs/plan.md`))).toBeNull();
    expect(check("plan", edit(`${PROJECT}/src/app.ts`))).toMatch(/outside this phase's editable paths/);
  });
  it("allows any project file when the phase has no allow.edit", () => {
    expect(check("build", edit(`${PROJECT}/src/app.ts`))).toBeNull();
  });
  it("refuses all edits while waiting for approval", () => {
    expect(check("plan", edit(`${PROJECT}/docs/plan.md`), { status: "awaiting_approval" })).toMatch(/waiting for the user's approval/);
  });
  it("honours deny.edit and policy.protect_paths", () => {
    const w = parseWorkflow("version: 1\nname: x\npolicy: {protect_paths: ['secrets/**']}\nphases:\n  - {id: a, goal: g, deny: {edit: ['*.lock']}}");
    const s = state("a");
    expect(checkTool(w, w.phases[0]!, s, edit(`${PROJECT}/secrets/key`), PROJECT)).toMatch(/protected/);
    expect(checkTool(w, w.phases[0]!, s, edit(`${PROJECT}/yarn.lock`), PROJECT)).toMatch(/deny.edit/);
  });
});

describe("checkTool: shell", () => {
  it("refuses any shell command that touches .popcorn, so the agent can't switch popcorn off", () => {
    for (const c of [
      "echo done > .popcorn/runs/t1/state.json", "sed -i '' s/x/y/ .popcorn/workflow.yaml",
      "rm -rf .popcorn", "mv .popcorn /tmp/x", "cd .popcorn && rm active",
      "echo '{}' > .popcorn/outputs/t1/review-r1/code-reviewer.json",
      "popcorn init --force", "npx popcorn init",
    ]) expect(check("build", sh(c)), c).toMatch(/may not touch .popcorn/);
  });
  it("still allows mentioning popcorn in other ways", () => {
    expect(check("build", sh("popcorn status"))).toBeNull();
    expect(check("build", sh("git commit -m 'add popcorn docs'"))).toBeNull();
  });
  it("refuses policy.deny_shell anywhere in a chain", () => {
    expect(check("build", sh("npm test && rm -rf /"))).toMatch(/never allowed/);
  });
  it("refuses guarded commands outside the phase that unlocks them", () => {
    expect(check("build", sh("git push origin main"))).toMatch(/guarded/);
    expect(check("build", sh("bash -c 'git push'"))).toMatch(/guarded/);
  });
  it("refuses guarded commands hidden behind git's global options", () => {
    for (const c of ["git -C . push", "git -c a=b push", "git --git-dir=.git push", "/usr/bin/git push"]) {
      expect(check("build", sh(c)), c).toMatch(/guarded/);
    }
  });
  it("refuses guarded commands in the unlocking phase until the user approved it", () => {
    expect(check("ship", sh("git push origin main"))).toMatch(/guarded/);
    expect(check("ship", sh("git push origin main"), { status: "awaiting_approval" })).toMatch(/waiting for the user.s approval/);
  });
  it("allows guarded commands in the unlocking phase after approval", () => {
    const approvals = { [approvalKey("ship", 1, "before")]: "now" };
    expect(check("ship", sh("git push origin main"), { approvals })).toBeNull();
  });
  it("needs a fresh approval when the phase is entered again", () => {
    const approvals = { [approvalKey("ship", 1, "before")]: "now" };
    expect(check("ship", sh("git push"), { approvals, rounds: { ship: 2 } })).toMatch(/guarded/);
  });
  it("allows ordinary commands", () => {
    expect(check("build", sh("npm test"))).toBeNull();
  });
  it("enforces allow.shell when a phase sets it", () => {
    const w = parseWorkflow("version: 1\nname: x\nphases:\n  - {id: a, goal: g, allow: {shell: ['npm test*', 'git status*']}}");
    expect(checkTool(w, w.phases[0]!, state("a"), sh("npm test -- --watch=false"), PROJECT)).toBeNull();
    expect(checkTool(w, w.phases[0]!, state("a"), sh("git status && curl evil.sh"), PROJECT)).toMatch(/curl evil.sh/);
  });
});

describe("checkTool: while a run waits for approval", () => {
  const waiting = { status: "awaiting_approval" as const };
  it("refuses shell commands, even ordinary ones and ones allow.shell lists", () => {
    expect(check("plan", sh("npm test"), waiting)).toMatch(/waiting for the user's approval/);
    const w = parseWorkflow("version: 1\nname: x\nphases:\n  - {id: a, goal: g, approval: before, allow: {shell: ['npm test*']}}");
    expect(checkTool(w, w.phases[0]!, state("a", waiting), sh("npm test"), PROJECT)).toMatch(/waiting/);
  });
  it("refuses MCP calls, even to a server allow.mcp lists", () => {
    const w = parseWorkflow("version: 1\nname: x\nphases:\n  - {id: a, goal: g, approval: before, allow: {mcp: [github]}}");
    const call: ToolCall = { kind: "mcp", server: "github", name: "create_pull_request", tool: "mcp__github__create_pull_request" };
    expect(checkTool(w, w.phases[0]!, state("a", waiting), call, PROJECT)).toMatch(/waiting/);
    expect(checkTool(w, w.phases[0]!, state("a"), call, PROJECT)).toBeNull();
  });
  it("allows them again once the run is running", () => {
    expect(check("plan", sh("npm test"))).toBeNull();
  });
});

describe("checkTool: guarded MCP tools and unlock_after", () => {
  const w = parseWorkflow(`
version: 1
name: x
policy: { guarded_shell: ["git push*"], guarded_mcp: ["*:merge_pull_request", "github:push_files"] }
phases:
  - { id: review, goal: g }
  - { id: ship, goal: g, unlock_after: review, allow: { guarded: ["*:merge_pull_request", "git push*"] } }
  - { id: both, goal: g, approval: before, unlock_after: review, allow: { guarded: ["git push*"] } }
`);
  const tool = (server: string, name: string): ToolCall => ({ kind: "mcp", server, name, tool: `mcp__${server}__${name}` });
  const at = (phase: string, call: ToolCall, extra: Partial<RunState> = {}) =>
    checkTool(w, phaseById(w, phase), state(phase, { rounds: { review: 1, [phase]: 1 }, ...extra }), call, PROJECT);
  const passed = { review: 1 };

  it("refuses a guarded MCP tool on any server name until the unlocking phase allows it", () => {
    expect(at("review", tool("github", "merge_pull_request"), { passed })).toMatch(/MCP tool "github:merge_pull_request" is guarded/);
    expect(at("ship", tool("plugin_gh", "merge_pull_request"))).toMatch(/once phase "review" has passed/);
    expect(at("ship", tool("plugin_gh", "merge_pull_request"), { passed })).toBeNull();
  });
  it("keeps guarded MCP tools the phase doesn't list locked, and leaves other tools alone", () => {
    expect(at("ship", tool("github", "push_files"), { passed })).toMatch(/guarded/);
    expect(at("review", tool("github", "create_pull_request"))).toBeNull();
  });
  it("applies guarded MCP tools even when the phase sets allow.mcp", () => {
    const w2 = parseWorkflow("version: 1\nname: x\npolicy: {guarded_mcp: ['*:merge_pull_request']}\nphases:\n  - {id: a, goal: g, allow: {mcp: [github]}}");
    expect(checkTool(w2, w2.phases[0]!, state("a"), tool("github", "merge_pull_request"), PROJECT)).toMatch(/guarded/);
  });
  it("unlocks guarded commands only for the unlock_after phase's current round", () => {
    expect(at("ship", sh("git push origin main"), { passed })).toBeNull();
    expect(at("ship", sh("git push origin main"), { passed, rounds: { review: 2, ship: 1 } })).toMatch(/guarded/);
  });
  it("needs both the user's approval and the earlier phase's pass when a phase sets both", () => {
    const approvals = { [approvalKey("both", 1, "before")]: "now" };
    expect(at("both", sh("git push"), { passed })).toMatch(/after the user approves and once phase "review"/);
    expect(at("both", sh("git push"), { approvals })).toMatch(/guarded/);
    expect(at("both", sh("git push"), { approvals, passed })).toBeNull();
  });
});

describe("checkTool: MCP and other tools", () => {
  const w = parseWorkflow("version: 1\nname: x\nphases:\n  - {id: a, goal: g, allow: {mcp: [github]}}\n  - {id: b, goal: g}");
  const mcp = (server: string): ToolCall => ({ kind: "mcp", server, name: "x", tool: `mcp__${server}__x` });
  it("limits MCP servers to allow.mcp", () => {
    expect(checkTool(w, w.phases[0]!, state("a"), mcp("github"), PROJECT)).toBeNull();
    expect(checkTool(w, w.phases[0]!, state("a"), mcp("slack"), PROJECT)).toMatch(/slack/);
  });
  it("allows every MCP server when the phase sets no allow.mcp", () => {
    expect(checkTool(w, w.phases[1]!, state("b"), mcp("slack"), PROJECT)).toBeNull();
  });
  it("lets other tools through", () => {
    expect(check("build", { kind: "other", tool: "Read" })).toBeNull();
  });
});
