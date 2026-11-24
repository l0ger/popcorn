import type { AgentRef, Decision, NormalizedEvent } from "../core/types.js";

/** What a platform adapter must print and exit with, after the engine decided. */
export interface Rendered {
  stdout: string;
  exitCode: number;
}

/**
 * The boundary between popcorn's engine and one coding-agent platform (Claude Code today).
 * An adapter only translates: the platform's hook payload into a NormalizedEvent, and a
 * Decision back into the output the platform expects. It holds no workflow logic.
 */
export interface Adapter {
  /** Used on the command line: `popcorn hook <name>`. */
  readonly name: string;
  /** The platform's hook payload (parsed JSON from stdin) → a NormalizedEvent, or null to ignore it. */
  parse(payload: unknown, env: { projectDir?: string }): NormalizedEvent | null;
  /** A Decision → the platform's output. `event` is the event it answers. */
  render(event: NormalizedEvent, decision: Decision): Rendered;
  /** How this platform names an agent from the workflow (e.g. a plugin namespace). */
  agentRef: AgentRef;
  /** What to print when the engine itself crashed, so the platform fails safe. */
  renderCrash(payload: unknown, message: string): Rendered;
}
