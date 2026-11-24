import { join } from "node:path";
import type { Env, RunState, Workflow } from "./types.js";
import { STATE_DIR } from "./policy.js";

export const TASK_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

const activeFile = (projectDir: string) => join(projectDir, ".popcorn", "active");
const stateFile = (projectDir: string, task: string) => join(projectDir, STATE_DIR, task, "state.json");

export { outputsDir } from "./policy.js";

export class StateStore {
  constructor(private readonly env: Env, private readonly projectDir: string) {}

  /** The active run's task name, or null when no run is active. */
  activeTask(): string | null {
    const f = activeFile(this.projectDir);
    if (!this.env.exists(f)) return null;
    const task = this.env.readText(f).trim();
    return TASK_PATTERN.test(task) ? task : null;
  }

  load(task: string): RunState {
    return JSON.parse(this.env.readText(stateFile(this.projectDir, task))) as RunState;
  }

  save(state: RunState): void {
    this.env.writeText(stateFile(this.projectDir, state.task), JSON.stringify(state, null, 2) + "\n");
  }

  setActive(task: string | null): void {
    this.env.writeText(activeFile(this.projectDir), task ? `${task}\n` : "");
  }

  exists(task: string): boolean {
    return this.env.exists(stateFile(this.projectDir, task));
  }

  /** Creates a run at the workflow's first phase and makes it the active one. */
  create(wf: Workflow, task: string, description: string | undefined): RunState {
    if (!TASK_PATTERN.test(task)) throw new Error(`task name "${task}" must be lowercase letters, digits and dashes (2–64)`);
    if (this.exists(task)) throw new Error(`run "${task}" already exists`);
    const first = wf.phases[0]!;
    const now = this.env.now();
    const state: RunState = {
      version: 1, task, description, workflow: wf.name, phase: first.id,
      status: first.approval === "before" ? "awaiting_approval" : "running",
      rounds: { [first.id]: 1 }, attempts: {}, approvals: {}, gateCache: {},
      startedAt: now, history: [{ at: now, event: "start", phase: first.id, detail: description }],
    };
    this.save(state);
    this.setActive(task);
    return state;
  }
}
