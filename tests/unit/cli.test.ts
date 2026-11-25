import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../../src/cli/run.js";
import { MemoryEnv, PROJECT, SMALL, TEMPLATE } from "../helpers.js";

const TEMPLATES = "/plugin/templates";

function io(argv: string[], opts: { stdin?: string; fs?: MemoryEnv } = {}): Io & { fs: MemoryEnv } {
  const fs = opts.fs ?? new MemoryEnv();
  if (!fs.exists(join(TEMPLATES, "workflow.yaml"))) fs.writeText(join(TEMPLATES, "workflow.yaml"), TEMPLATE);
  return { argv, stdin: () => opts.stdin ?? "", env: { CLAUDE_PROJECT_DIR: PROJECT }, cwd: PROJECT, fs, templatesDir: TEMPLATES };
}

describe("cli", () => {
  it("prints usage for help and no command", () => {
    expect(run(io([])).stdout).toMatch(/Usage:/);
    expect(run(io(["--help"])).code).toBe(0);
  });

  it("fails with usage on an unknown command", () => {
    const r = run(io(["frobnicate"]));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command "frobnicate"/);
  });

  it("has no approve command: only the user's prompt can approve", () => {
    expect(run(io(["approve"])).code).toBe(2);
  });

  it("init copies the template once, and only overwrites with --force", () => {
    const i = io(["init"]);
    expect(run(i).code).toBe(0);
    expect(i.fs.get(".popcorn/workflow.yaml")).toBe(TEMPLATE);
    expect(i.fs.get(".popcorn/.gitignore")).toMatch(/runs\/\noutputs\/\nactive/);
    expect(run(io(["init"], { fs: i.fs })).code).toBe(1);
    expect(run(io(["init", "--force"], { fs: i.fs })).code).toBe(0);
  });

  it("init refuses to touch the workflow while a run is active", () => {
    const fs = new MemoryEnv().put(".popcorn/workflow.yaml", SMALL);
    run(io(["start", "t1"], { fs }));
    const r = run(io(["init", "--force"], { fs }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/is active/);
    expect(fs.get(".popcorn/workflow.yaml")).toBe(SMALL);
  });

  it("validate reports success and every problem", () => {
    const fs = new MemoryEnv().put(".popcorn/workflow.yaml", SMALL);
    expect(run(io(["validate"], { fs })).stdout).toMatch(/✓ small: 4 phases \(plan → build → review → ship\)/);
    fs.put(".popcorn/workflow.yaml", "version: 1\nname: x\nphases:\n  - {id: a, goal: g, next: zz}");
    const r = run(io(["validate"], { fs }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/next "zz" is not a phase/);
  });

  it("validate explains a missing file", () => {
    expect(run(io(["validate"])).stderr).toMatch(/not found/);
  });

  it("start creates a run and status shows it", () => {
    const fs = new MemoryEnv().put(".popcorn/workflow.yaml", SMALL);
    const r = run(io(["start", "t1", "Add", "login"], { fs }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Run "t1" (Add login)');
    expect(run(io(["status"], { fs })).stdout).toContain('"plan"');
    expect(run(io(["start", "t2"], { fs })).stderr).toMatch(/still active/);
  });

  it("status without a run says so", () => {
    expect(run(io(["status"])).stdout).toMatch(/no active run/);
  });

  it("hook prints nothing when there is no run", () => {
    const r = run(io(["hook", "claude"], { stdin: JSON.stringify({ hook_event_name: "Stop", cwd: PROJECT }) }));
    expect(r).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("hook fails safe on a payload it can't parse", () => {
    const r = run(io(["hook", "claude"], { stdin: "{not json" }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/popcorn hook error/);
  });

  it("hook with an unknown adapter is an error", () => {
    expect(run(io(["hook", "nope"])).code).toBe(1);
  });
});
