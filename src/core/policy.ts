import picomatch from "picomatch";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Phase, RunState, ToolCall, Workflow } from "./types.js";

/** Paths popcorn always protects while a run is active: its run state and the workflow itself. */
export const STATE_DIR = ".popcorn/runs";
export const WORKFLOW_FILE = ".popcorn/workflow.yaml";
/** Directory where agents write their phase outputs (only the named agent may write its own file). */
export function outputsDir(task: string, phase: string, round: number) {
  return `.popcorn/outputs/${task}/${phase}-r${round}`;
}
const ALWAYS_PROTECTED = [`${STATE_DIR}/**`, WORKFLOW_FILE, ".popcorn/active"];

const glob = (patterns: string[]) => picomatch(patterns, { dot: true });

/** Shell patterns: a glob over one command segment, case-sensitive, `*` crossing spaces. */
function shellMatch(pattern: string, segment: string): boolean {
  const re = new RegExp(`^${pattern.trim().replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(segment);
}

/**
 * Splits a shell command into the segments a pattern is checked against: each command joined by
 * ;, &&, ||, | or a newline, and the inside of `bash -c '…'` / `sh -c "…"`. Leading VAR=value
 * assignments and `sudo`/`env` are dropped. This is best effort: a determined agent can hide a
 * command from any pattern matcher, which is why popcorn's state lives outside the agent's reach.
 */
export function shellSegments(command: string): string[] {
  const out: string[] = [];
  const queue = [command];
  while (queue.length) {
    const c = queue.shift()!;
    for (let seg of splitOutsideQuotes(c)) {
      seg = seg.trim().replace(/^\(+|\)+$/g, "").trim();
      const inner = /^(?:ba|z)?sh\s+-c\s+(['"])([\s\S]*)\1$/.exec(seg);
      if (inner) { queue.push(inner[2]!); continue; }
      seg = seg.replace(/^(?:(?:sudo|env|command|exec)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim();
      seg = normalizeGit(seg);
      if (seg) out.push(seg);
    }
  }
  return out;
}

const ARG = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const GIT_GLOBAL = new RegExp(String.raw`^(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)\s+${ARG}|` +
  String.raw`--(?:git-dir|work-tree|namespace|exec-path|config-env|super-prefix)=${ARG}|` +
  String.raw`--no-pager|--paginate|-p|-P|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|` +
  String.raw`--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-lazy-fetch|--no-advice)\s+`);

/** `git -C dir -c k=v --no-pager push` → `git push`, and `/usr/bin/git` → `git`, so `git push*` patterns can't be dodged. */
function normalizeGit(seg: string): string {
  const m = /^(?:\S*\/)?git\s+([\s\S]*)$/.exec(seg);
  if (!m) return seg;
  let rest = m[1]!;
  for (let r = GIT_GLOBAL.exec(rest); r; r = GIT_GLOBAL.exec(rest)) rest = rest.slice(r[0].length);
  return `git ${rest}`;
}

/** Splits on ;, &&, ||, | and newlines that are not inside single or double quotes. */
function splitOutsideQuotes(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) { cur += ch + command[++i]; continue; }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") { parts.push(cur); cur = ""; i++; continue; }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

const matchesAny = (patterns: string[], segments: string[]) =>
  segments.find(s => patterns.some(p => shellMatch(p, s)));

/** The path relative to the project, or null when it is outside the project. */
export function projectRelative(projectDir: string, path: string): string | null {
  const abs = isAbsolute(path) ? resolve(path) : resolve(projectDir, path);
  const rel = relative(resolve(projectDir), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export function approvalKey(phase: string, round: number, when: "before" | "after") {
  return `${phase}#${round}#${when}`;
}

/**
 * Whether the phase's guarded patterns are unlocked: its `before` approval was granted this round (when
 * it has one), and its `unlock_after` phase passed in that phase's current round (when it names one).
 */
export function unlocked(phase: Phase, state: RunState): boolean {
  const byUser = phase.approval === "before";
  const byPhase = phase.unlock_after;
  if (!byUser && byPhase === undefined) return false;
  if (byUser && state.approvals[approvalKey(phase.id, state.rounds[phase.id] ?? 1, "before")] === undefined) return false;
  if (byPhase !== undefined) {
    const passedIn = state.passed?.[byPhase];
    if (passedIn === undefined || passedIn !== (state.rounds[byPhase] ?? 1)) return false;
  }
  return true;
}

function lockedReason(phase: Phase): string {
  const how = [
    phase.approval === "before" ? "after the user approves" : "",
    phase.unlock_after ? `once phase "${phase.unlock_after}" has passed with every reviewer approving` : "",
  ].filter(Boolean).join(" and ");
  return `It is allowed only in a phase that unlocks it, ${how || "after the user approves"}.`;
}

/** Whether a platform's agent name refers to the workflow's agent (plugin agents may be namespaced, e.g. "popcorn:x"). */
export function isAgent(actual: string | undefined, expected: string): boolean {
  return actual === expected || (actual?.endsWith(`:${expected}`) ?? false);
}

/**
 * Writes under .popcorn/ other than the protected state: only a required agent's own output file for the
 * current phase and round, written by that agent. So the main session can't file a reviewer's verdict.
 */
function outputWrite(phase: Phase, state: RunState, rel: string, agent: string | undefined, where: string): string | null {
  const dir = outputsDir(state.task, phase.id, state.rounds[phase.id] ?? 1);
  const name = rel.startsWith(`${dir}/`) ? rel.slice(dir.length + 1).replace(/\.json$/, "") : null;
  const required = phase.outputs?.required ?? [];
  if (!name || !rel.endsWith(".json") || !required.includes(name)) {
    return `${where}: under .popcorn/ only this phase's agent outputs can be written (${dir}/<${required.join("|") || "none"}>.json).`;
  }
  if (!isAgent(agent, name)) {
    return `${where}: ${rel} must be written by the \`${name}\` subagent itself${agent ? `, not by \`${agent}\`` : ", not by the main session"}. Delegate to that subagent.`;
  }
  return null;
}

/** Returns a reason to refuse the call, or null to allow it. Pure: no I/O. */
export function checkTool(wf: Workflow, phase: Phase, state: RunState, call: ToolCall, projectDir: string, agent?: string): string | null {
  const where = `popcorn: phase "${phase.id}" of run "${state.task}"`;
  const waiting = state.status === "awaiting_approval";
  const waitMsg = `${where} is waiting for the user's approval. Don't act until then; ask the user to type "popcorn approve" or "popcorn reject <feedback>".`;

  if (call.kind === "edit") {
    const rel = projectRelative(projectDir, call.path);
    if (rel === null) return `${where}: ${call.path} is outside the project.`;
    if (glob(ALWAYS_PROTECTED)(rel)) {
      return `${where}: ${rel} is protected. The run state and the workflow can't be changed during a run.`;
    }
    if (wf.policy?.protect_paths?.length && glob(wf.policy.protect_paths)(rel)) {
      return `${where}: ${rel} is protected by the workflow's policy.protect_paths and can't be edited by the agent.`;
    }
    if (rel.startsWith(".popcorn/")) return outputWrite(phase, state, rel, agent, where);
    if (waiting) return waitMsg;
    if (phase.deny?.edit?.length && glob(phase.deny.edit)(rel)) return `${where}: ${rel} matches deny.edit.`;
    const allowed = phase.allow?.edit ?? ["**"];
    if (!glob(allowed)(rel)) return `${where}: ${rel} is outside this phase's editable paths (${allowed.join(", ")}).`;
    return null;
  }

  if (call.kind === "shell") {
    if (/\.popcorn\b|\bpopcorn\s+init\b/.test(call.command)) {
      return `${where}: shell commands may not touch .popcorn/ (run state, workflow, agent outputs). Read files with the Read tool; agents write their outputs with the Write tool.`;
    }
    // An approval gate holds every action, not just edits: no shell command runs before the user decides.
    if (waiting) return waitMsg;
    const segments = shellSegments(call.command);
    const denied = matchesAny([...(wf.policy?.deny_shell ?? []), ...(phase.deny?.shell ?? [])], segments);
    if (denied) return `${where}: "${denied}" is never allowed in this phase.`;
    const guarded = matchesAny(wf.policy?.guarded_shell ?? [], segments);
    if (guarded) {
      const lockedFor = (wf.policy?.guarded_shell ?? []).find(g => shellMatch(g, guarded))!;
      const ok = (phase.allow?.guarded ?? []).includes(lockedFor) && unlocked(phase, state) && !waiting;
      if (!ok) return `${where}: "${guarded}" is guarded. ${lockedReason(phase)}`;
    }
    if (phase.allow?.shell) {
      const outside = segments.find(s => !phase.allow!.shell!.some(p => shellMatch(p, s)));
      if (outside) return `${where}: "${outside}" is not in this phase's allowed commands.`;
    }
    return null;
  }

  if (call.kind === "mcp") {
    if (waiting) return waitMsg;
    const id = `${call.server}:${call.name}`;
    const lockedFor = (wf.policy?.guarded_mcp ?? []).find(g => shellMatch(g, id));
    if (lockedFor) {
      const ok = (phase.allow?.guarded ?? []).includes(lockedFor) && unlocked(phase, state) && !waiting;
      if (!ok) return `${where}: MCP tool "${id}" is guarded. ${lockedReason(phase)}`;
    }
    if (phase.allow?.mcp && !phase.allow.mcp.includes(call.server)) {
      return `${where}: MCP server "${call.server}" is not allowed in this phase (${phase.allow.mcp.join(", ") || "none"}).`;
    }
    return null;
  }
  return null;
}
