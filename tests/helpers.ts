import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/core/types.js";

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
export const TEMPLATE = readFileSync(join(ROOT, "plugin/templates/workflow.yaml"), "utf8");
export const PROJECT = "/work/app";

export type RunFn = (command: string, cwd: string) => { code: number; output: string };

/** An in-memory Env: files in a Map, shell commands answered by `runner`, a fixed clock. */
export class MemoryEnv implements Env {
  files = new Map<string, string>();
  commands: string[] = [];
  private tick = 0;
  constructor(public runner: RunFn = () => ({ code: 0, output: "" })) {}

  exists(p: string) { return this.files.has(p); }
  readText(p: string) {
    const t = this.files.get(p);
    if (t === undefined) throw new Error(`ENOENT: ${p}`);
    return t;
  }
  writeText(p: string, text: string) { this.files.set(p, text); }
  run(command: string, cwd: string) {
    this.commands.push(command);
    return this.runner(command, cwd);
  }
  now() { return `2026-01-01T00:00:${String(this.tick++ % 60).padStart(2, "0")}Z`; }

  /** Writes a file relative to the test project. */
  put(rel: string, text = "x") { this.files.set(join(PROJECT, rel), text); return this; }
  get(rel: string) { return this.files.get(join(PROJECT, rel)); }
}

/** A minimal three-phase workflow used by many engine tests. */
export const SMALL = `
version: 1
name: small
policy:
  deny_shell: ["rm -rf /*"]
  guarded_shell: ["git push*"]
  max_attempts_per_phase: 2
phases:
  - id: plan
    agent: product-manager
    goal: Write the plan for {task}.
    artifacts: ["docs/{task}.md"]
    approval: after
    allow: { edit: ["docs/**"] }
  - id: build
    agent: implementer
    goal: Build it.
    gates: ["make test"]
  - id: review
    goal: Review it.
    outputs: { schema: review, required: [code-reviewer] }
    on_fail: build
  - id: ship
    goal: Ship it.
    approval: before
    allow: { guarded: ["git push*"] }
schemas:
  review:
    type: object
    required: [verdict, findings]
    properties:
      verdict: { enum: [approve, changes_requested] }
      findings: { type: array, items: { type: object, required: [severity, title] } }
`;

export const agentRef = (a: string) => `popcorn:${a}`;
