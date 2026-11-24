/**
 * Platform-neutral types. Nothing in src/core knows which coding agent is driving:
 * adapters translate a platform's hook payloads into NormalizedEvent and render a Decision back.
 */

// ---------- Workflow (what a team writes in .popcorn/workflow.yaml) ----------
export type Approval = "none" | "before" | "after";

export interface PhaseAllow {
  /** Globs (relative to the project) the agent may edit in this phase. Default: everything. */
  edit?: string[];
  /** Shell patterns allowed in this phase. Default: anything not denied. */
  shell?: string[];
  /** MCP servers whose tools may be used in this phase. Default: all. */
  mcp?: string[];
  /** Guarded commands (policy.guarded_shell) this phase unlocks, once its approval is granted. */
  guarded?: string[];
}

export interface PhaseDeny {
  edit?: string[];
  shell?: string[];
}

export interface PhaseOutputs {
  /** Name of a schema in workflow.schemas that each output file must match. */
  schema: string;
  /** Agents that must each write an output file before the phase can complete. */
  required: string[];
}

export interface Phase {
  id: string;
  title?: string;
  goal: string;
  instructions?: string;
  /** The agent that does this phase's work. */
  agent?: string;
  /** Files that must exist before the phase can complete ({task} is substituted). */
  artifacts?: string[];
  outputs?: PhaseOutputs;
  /** Shell commands that must exit 0 before the phase can complete. */
  gates?: string[];
  /** "before": a human approves before work starts; "after": before the run moves on. */
  approval?: Approval;
  allow?: PhaseAllow;
  deny?: PhaseDeny;
  /** Phase to return to when an output carries a blocking finding. */
  on_fail?: string;
  /** Next phase. Default: the next one in the list. */
  next?: string;
}

export interface Policy {
  /** Shell patterns that are never allowed. */
  deny_shell?: string[];
  /** Shell patterns allowed only in a phase that lists them in allow.guarded, after its approval. */
  guarded_shell?: string[];
  /** Paths the agent may never edit (in addition to popcorn's own state). */
  protect_paths?: string[];
  /** How many times the agent may try to stop before a phase is complete. Then the run escalates. */
  max_attempts_per_phase?: number;
  /** Finding severities that send a phase back to its on_fail phase. */
  blocking_severities?: string[];
  /** Timeout for each gate command, in seconds. */
  gate_timeout_seconds?: number;
}

export interface Workflow {
  version: 1;
  name: string;
  description?: string;
  policy?: Policy;
  phases: Phase[];
  schemas?: Record<string, Record<string, unknown>>;
}

// ---------- Run state (.popcorn/runs/<task>/state.json, never editable by the agent) ----------
export type RunStatus = "running" | "awaiting_approval" | "done" | "escalated" | "aborted";

export interface HistoryEntry { at: string; event: string; phase: string; detail?: string }

export interface RunState {
  version: 1;
  task: string;
  description?: string;
  workflow: string;
  phase: string;
  status: RunStatus;
  /** How many times each phase has been entered (review rounds, fix loops). */
  rounds: Record<string, number>;
  /** Stop attempts in the current round of each phase. */
  attempts: Record<string, number>;
  /** Approvals, keyed "<phase>#<round>#<before|after>". */
  approvals: Record<string, string>;
  /** Feedback the human gave with a rejection, shown once. */
  feedback?: string;
  /** Last gate results by "<phase>#<command>". */
  gateCache: Record<string, { key: string; code: number; output: string }>;
  startedAt: string;
  history: HistoryEntry[];
}

// ---------- Events and decisions (the adapter boundary) ----------
export type ToolCall =
  | { kind: "edit"; path: string; tool: string }
  | { kind: "shell"; command: string; tool: string }
  | { kind: "mcp"; server: string; name: string; tool: string }
  | { kind: "other"; tool: string };

export type NormalizedEvent =
  | { type: "session_start"; projectDir: string }
  | { type: "prompt"; projectDir: string; prompt: string }
  /** `agent` names the subagent making the call, when the platform says (absent for the main session). */
  | { type: "before_tool"; projectDir: string; call: ToolCall; agent?: string }
  | { type: "stop"; projectDir: string; stopHookActive: boolean };

export type Decision =
  /** No opinion: let the platform do what it would do anyway. */
  | { kind: "pass" }
  /** Add text to the agent's context, and optionally show the human a short notice. */
  | { kind: "context"; text: string; notice?: string }
  /** Refuse a tool call. */
  | { kind: "deny"; reason: string }
  /** Refuse to stop; the reason is the agent's next instruction. */
  | { kind: "continue"; reason: string }
  /** Let the agent stop, and tell the human something. */
  | { kind: "halt"; message: string };

// ---------- Side effects the engine needs (injected, so the engine is testable) ----------
export interface Env {
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, text: string): void;
  /** Runs a shell command in the project directory. */
  run(command: string, cwd: string, timeoutMs: number): { code: number; output: string };
  now(): string;
}

/** How an adapter names an agent for its platform (e.g. a plugin namespace). */
export type AgentRef = (agent: string, projectDir: string) => string;
