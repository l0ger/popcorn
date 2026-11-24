/**
 * End to end: the bundled plugin/dist/popcorn.mjs (what Claude Code actually runs), fed real hook
 * payloads on stdin, inside a temporary git repository. Run `npm run build` first.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "../helpers.js";

const BUNDLE = join(ROOT, "plugin/dist/popcorn.mjs");
let dir: string;

// The starter template with its placeholder gates swapped for a file check the test controls.
const workflow = () => readFileSync(join(ROOT, "plugin/templates/workflow.yaml"), "utf8")
  .replace(/- "npm test".*$/gm, '- "test -f gate-ok"');

function hook(payload: Record<string, unknown>) {
  const r = spawnSync("node", [BUNDLE, "hook", "claude"], {
    input: JSON.stringify({ session_id: "s", transcript_path: "/t", cwd: dir, permission_mode: "default", ...payload }),
    encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, raw: r.stdout, err: r.stderr };
}
const prompt = (text: string) => hook({ hook_event_name: "UserPromptSubmit", prompt: text });
const stop = () => hook({ hook_event_name: "Stop", stop_hook_active: false });
const bash = (command: string) => hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const write = (file: string, agent?: string) => hook({
  hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(dir, file), content: "x" },
  ...(agent ? { agent_id: "a1", agent_type: agent } : {}),
});
const denied = (r: ReturnType<typeof hook>) => r.out?.hookSpecificOutput?.permissionDecision === "deny";
const put = (file: string, text = "x") => { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), text); };
const state = () => JSON.parse(readFileSync(join(dir, ".popcorn/runs/t1/state.json"), "utf8"));
const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

beforeAll(() => {
  if (!existsSync(BUNDLE)) throw new Error("plugin/dist/popcorn.mjs is missing: run `npm run build` first");
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "popcorn-e2e-"));
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  put(".popcorn/workflow.yaml", workflow());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Drives t1 from start to the Build phase. */
function toBuild() {
  prompt("popcorn start t1 Add login");
  put("docs/plans/t1.md");
  expect(stop().out.decision).toBe("block");  // plan done → design brief
  expect(stop().out.systemMessage).toMatch(/waiting for your approval/);
  prompt("popcorn approve");
}

describe("bundled hook, Claude Code payloads", () => {
  it("is silent in a project without an active run", () => {
    for (const r of [stop(), bash("git push"), prompt("hello")]) expect(r).toMatchObject({ code: 0, raw: "" });
  });

  it("is silent in a project without .popcorn at all", () => {
    rmSync(join(dir, ".popcorn"), { recursive: true });
    expect(bash("rm -rf /")).toMatchObject({ code: 0, raw: "" });
  });

  it("starts a run from the user's prompt and briefs the agent", () => {
    const r = prompt("popcorn start t1 Add login");
    expect(r.out.hookSpecificOutput.additionalContext).toContain("`popcorn:product-manager`");
    expect(state().phase).toBe("plan");
  });

  it("denies edits outside the phase's paths", () => {
    prompt("popcorn start t1");
    expect(denied(write("src/app.ts"))).toBe(true);
    expect(denied(write("docs/plans/t1.md"))).toBe(false);
  });

  it("denies the agent writing popcorn's state, by tool or by shell", () => {
    prompt("popcorn start t1");
    expect(denied(write(".popcorn/runs/t1/state.json"))).toBe(true);
    expect(denied(bash(`echo '{}' > .popcorn/runs/t1/state.json`))).toBe(true);
  });

  it("denies switching popcorn off from the shell", () => {
    prompt("popcorn start t1");
    for (const c of ["rm -rf .popcorn", "mv .popcorn x", "popcorn init --force"]) expect(denied(bash(c)), c).toBe(true);
  });

  it("only the reviewer subagent itself may file its verdict", () => {
    toBuild();
    put("gate-ok");
    stop(); stop();                                 // → review
    const f = ".popcorn/outputs/t1/review-r1/code-reviewer.json";
    expect(denied(write(f))).toBe(true);                         // main session
    expect(denied(write(f, "popcorn:implementer"))).toBe(true);  // another agent
    expect(denied(write(f, "popcorn:code-reviewer"))).toBe(false);
  });

  it("reruns a gate when a tracked file's content changes", () => {
    put("app.txt", "broken");
    git("add", "app.txt");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "app");
    put(".popcorn/workflow.yaml", workflow().replace(/test -f gate-ok/g, "grep -q fixed app.txt"));
    toBuild();
    put("app.txt", "still broken");
    expect(stop().out.reason).toContain("failed");
    put("app.txt", "fixed");                       // same `git status` line, different content
    expect(stop().out.reason).toContain('phase 4/6 "Test"');
  });

  it("denies git push before the deploy approval", () => {
    prompt("popcorn start t1");
    expect(denied(bash("git push origin main"))).toBe(true);
    expect(denied(bash("git -C . push origin main"))).toBe(true);
  });

  it("blocks stopping until the phase's gate passes", () => {
    toBuild();
    const r = stop();
    expect(r.out.decision).toBe("block");
    expect(r.out.reason).toContain("gate `test -f gate-ok` failed");
    put("gate-ok");
    expect(stop().out.reason).toContain('phase 4/6 "Test"');   // build → test
  });

  it("sends a blocking review finding back to Build", () => {
    toBuild();
    put("gate-ok");
    stop(); stop();                                 // build → test → review
    expect(state().phase).toBe("review");
    const out = join(".popcorn/outputs/t1/review-r1");
    put(`${out}/code-reviewer.json`, JSON.stringify({ verdict: "changes_requested", findings: [{ severity: "HIGH", title: "missing auth check" }] }));
    put(`${out}/quality-reviewer.json`, JSON.stringify({ verdict: "approve", findings: [] }));
    put(`${out}/security-reviewer.json`, JSON.stringify({ verdict: "approve", findings: [] }));
    const r = stop();
    expect(r.out.reason).toContain("[HIGH] missing auth check");
    expect(state()).toMatchObject({ phase: "build", rounds: { build: 2 } });
  });

  it("only the user's prompt approves; then the push is allowed", () => {
    toBuild();
    put("gate-ok");
    stop(); stop();
    for (const a of ["code-reviewer", "quality-reviewer", "security-reviewer"]) {
      put(`.popcorn/outputs/t1/review-r1/${a}.json`, JSON.stringify({ verdict: "approve", findings: [] }));
    }
    expect(stop().out.systemMessage).toMatch(/approval to start phase "deploy"/);
    expect(denied(bash("popcorn approve"))).toBe(false); // harmless: the CLI has no approve command
    expect(spawnSync("node", [BUNDLE, "approve"], { cwd: dir, encoding: "utf8" }).status).toBe(2);
    expect(denied(bash("git push origin main"))).toBe(true);
    prompt("popcorn approve");
    expect(denied(bash("git push origin main"))).toBe(false);
    expect(denied(bash("git push --force origin main"))).toBe(true);
  });

  it("fails safe: an engine error mid-run denies tools and lets the agent stop", () => {
    prompt("popcorn start t1");
    put(".popcorn/workflow.yaml", "version: [broken");
    const r = bash("ls");
    expect(denied(r)).toBe(true);
    expect(r.out.hookSpecificOutput.permissionDecisionReason).toMatch(/popcorn engine error/);
    expect(stop().out.systemMessage).toMatch(/popcorn engine error/);
  });

  it("the CLI validates the starter template and runs init", () => {
    rmSync(join(dir, ".popcorn"), { recursive: true });
    const init = spawnSync("node", [BUNDLE, "init"], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    expect(init.status).toBe(0);
    const v = spawnSync("node", [BUNDLE, "validate"], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    expect(v.stdout).toMatch(/✓ agile-6-phase: 6 phases/);
  });
});
