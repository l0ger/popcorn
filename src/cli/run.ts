import { join, resolve } from "node:path";
import { Engine } from "../core/engine.js";
import { StateStore } from "../core/state.js";
import { parseWorkflow, phaseById, WorkflowError } from "../core/workflow.js";
import { WORKFLOW_FILE } from "../core/policy.js";
import type { Env } from "../core/types.js";
import { adapterNames, getAdapter } from "../adapters/registry.js";

export interface Io {
  argv: string[];
  stdin: () => string;
  env: Record<string, string | undefined>;
  cwd: string;
  fs: Env;
  /** Where the bundled templates live (plugin/templates). */
  templatesDir: string;
  /** The shell command that runs this CLI, e.g. node "/…/plugin/dist/popcorn.mjs", for the hints it prints. */
  self: string;
}
export interface Result { stdout: string; stderr: string; code: number }

const USAGE = `popcorn: deterministic, YAML-defined workflows for coding agents

Usage:
  popcorn init [--force]            copy the starter workflow to ${WORKFLOW_FILE}
  popcorn validate [file]           check a workflow file (default: ${WORKFLOW_FILE})
  popcorn start <task> [goal...]    start a run (the user can also type "popcorn start …" as a prompt)
  popcorn status                    show the active run
  popcorn hook <adapter>            handle one hook event from stdin (adapters: ${adapterNames().join(", ")})

Only the user can approve, reject, retry or abort a run, by typing "popcorn approve",
"popcorn reject <feedback>", "popcorn retry" or "popcorn abort" as a prompt.`;

const ok = (stdout: string): Result => ({ stdout, stderr: "", code: 0 });
const err = (stderr: string, code = 1): Result => ({ stdout: "", stderr, code });

export function run(io: Io): Result {
  const [cmd, ...rest] = io.argv;
  const projectDir = resolve(io.env.CLAUDE_PROJECT_DIR || io.cwd);
  try {
    switch (cmd) {
      case "hook": return hook(io, rest[0] ?? "");
      case "init": return init(io, projectDir, rest.includes("--force"));
      case "validate": return validate(io, rest[0] ? resolve(io.cwd, rest[0]) : join(projectDir, WORKFLOW_FILE));
      case "start": return start(io, projectDir, rest);
      case "status": return status(io, projectDir);
      case undefined: case "help": case "--help": case "-h": return ok(USAGE + "\n");
      default: return err(`popcorn: unknown command "${cmd}"\n\n${USAGE}\n`, 2);
    }
  } catch (e) {
    return err(`popcorn: ${(e as Error).message}\n`);
  }
}

/** One hook event: stdin payload → adapter → engine → adapter → stdout. Never exits non-zero. */
function hook(io: Io, adapterName: string): Result {
  const adapter = getAdapter(adapterName);
  let payload: unknown = null;
  try {
    payload = JSON.parse(io.stdin() || "null");
    const event = adapter.parse(payload, { projectDir: io.env.CLAUDE_PROJECT_DIR });
    if (!event) return ok("");
    const decision = new Engine(io.fs, adapter.agentRef).handle(event);
    const out = adapter.render(event, decision);
    return { stdout: out.stdout, stderr: "", code: out.exitCode };
  } catch (e) {
    const out = adapter.renderCrash(payload, (e as Error).message);
    return { stdout: out.stdout, stderr: "", code: out.exitCode };
  }
}

function init(io: Io, projectDir: string, force: boolean): Result {
  const target = join(projectDir, WORKFLOW_FILE);
  const active = new StateStore(io.fs, projectDir).activeTask();
  if (active) return err(`popcorn: run "${active}" is active; the workflow can't change during a run\n`);
  if (io.fs.exists(target) && !force) return err(`popcorn: ${WORKFLOW_FILE} already exists (use --force to overwrite)\n`);
  const text = io.fs.readText(join(io.templatesDir, "workflow.yaml"));
  parseWorkflow(text);
  io.fs.writeText(target, text);
  const ignore = join(projectDir, ".popcorn", ".gitignore");
  if (!io.fs.exists(ignore)) io.fs.writeText(ignore, "# popcorn run state: keep it out of commits and review diffs\nruns/\noutputs/\nactive\n");
  return ok(`Created ${WORKFLOW_FILE} and .popcorn/.gitignore. Edit the workflow's phases, gates and agents, then run: ${io.self} validate\n`);
}

function validate(io: Io, file: string): Result {
  if (!io.fs.exists(file)) return err(`popcorn: ${file} not found (run: ${io.self} init)\n`);
  try {
    const wf = parseWorkflow(io.fs.readText(file));
    return ok(`✓ ${wf.name}: ${wf.phases.length} phases (${wf.phases.map(p => p.id).join(" → ")})\n`);
  } catch (e) {
    if (e instanceof WorkflowError) return err(`✗ ${file}\n- ${e.problems.join("\n- ")}\n`);
    throw e;
  }
}

function start(io: Io, projectDir: string, args: string[]): Result {
  const [task, ...goal] = args;
  if (!task) return err("popcorn: usage: popcorn start <task> [goal...]\n", 2);
  const engine = new Engine(io.fs, getAdapter("claude").agentRef);
  const wf = engine.loadWorkflow(projectDir);
  const store = new StateStore(io.fs, projectDir);
  const active = store.activeTask();
  if (active && !["done", "aborted"].includes(store.load(active).status)) {
    return err(`popcorn: run "${active}" is still active; the user can type "popcorn abort" to end it\n`);
  }
  const state = store.create(wf, task, goal.join(" ") || undefined);
  return ok(engine.brief(wf, state, phaseById(wf, state.phase), projectDir) + "\n");
}

function status(io: Io, projectDir: string): Result {
  const store = new StateStore(io.fs, projectDir);
  const task = store.activeTask();
  if (!task) return ok("popcorn: no active run\n");
  const engine = new Engine(io.fs, getAdapter("claude").agentRef);
  const wf = engine.loadWorkflow(projectDir);
  const state = store.load(task);
  return ok(engine.brief(wf, state, phaseById(wf, state.phase), projectDir) + "\n");
}
