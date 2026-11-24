import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentRef, Decision, Env, NormalizedEvent, Phase, RunState, Workflow } from "./types.js";
import { fill, nextPhase, outputProblems, parseWorkflow, phaseById } from "./workflow.js";
import { approvalKey, checkTool, WORKFLOW_FILE } from "./policy.js";
import { outputsDir, StateStore } from "./state.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BLOCKING = ["BLOCKER", "CRITICAL", "HIGH"];
const DEFAULT_GATE_TIMEOUT_S = 900;
const tail = (s: string, n = 3000) => (s.length > n ? `…${s.slice(-n)}` : s);

/** Commands only the human can give, by typing them as a prompt. The agent never sees a way to approve itself. */
const COMMAND = /^\s*\/?popcorn[: \t]+(start|approve|reject|retry|abort|status)\b[ \t]*([^\n]*)/i;

type Check = { ok: true } | { ok: false; reason: string } | { ok: false; fail: string };

/**
 * The workflow engine. Platform-neutral: it receives a NormalizedEvent and returns a Decision.
 * All I/O goes through Env, and naming agents goes through the adapter's AgentRef.
 */
export class Engine {
  constructor(private readonly env: Env, private readonly agentRef: AgentRef) {}

  handle(event: NormalizedEvent): Decision {
    const store = new StateStore(this.env, event.projectDir);
    const task = store.activeTask();
    const command = event.type === "prompt" ? COMMAND.exec(event.prompt) : null;

    // No active run: popcorn stays silent, except for a "popcorn start" the user typed.
    if (!task) {
      if (command?.[1]?.toLowerCase() === "start") return this.start(event.projectDir, store, command[2] ?? "");
      if (command) return { kind: "context", text: "[popcorn] No run is active.", notice: "popcorn: no run is active. Start one with: popcorn start <task-name> <what to build>" };
      return { kind: "pass" };
    }

    let wf: Workflow;
    let state: RunState;
    try {
      wf = this.loadWorkflow(event.projectDir);
      state = store.load(task);
    } catch (e) {
      return this.failSafe(event, (e as Error).message);
    }
    if (state.status === "done" || state.status === "aborted") {
      store.setActive(null);
      return command?.[1]?.toLowerCase() === "start" ? this.start(event.projectDir, store, command[2] ?? "") : { kind: "pass" };
    }

    try {
      const phase = phaseById(wf, state.phase);
      switch (event.type) {
        case "session_start":
          return { kind: "context", text: this.brief(wf, state, phase, event.projectDir) };
        case "prompt":
          return command ? this.command(wf, state, phase, store, event.projectDir, command[1]!.toLowerCase(), (command[2] ?? "").trim())
            : { kind: "context", text: this.brief(wf, state, phase, event.projectDir) };
        case "before_tool": {
          const reason = checkTool(wf, phase, state, event.call, event.projectDir, event.agent);
          return reason ? { kind: "deny", reason } : { kind: "pass" };
        }
        case "stop":
          return this.stop(wf, state, phase, store, event.projectDir);
      }
    } catch (e) {
      return this.failSafe(event, (e as Error).message);
    }
  }

  loadWorkflow(projectDir: string): Workflow {
    const file = join(projectDir, WORKFLOW_FILE);
    if (!this.env.exists(file)) throw new Error(`${WORKFLOW_FILE} is missing`);
    return parseWorkflow(this.env.readText(file));
  }

  /** On an engine error during an active run: refuse tools (never fail open), but let the agent stop. */
  private failSafe(event: NormalizedEvent, message: string): Decision {
    const text = `popcorn engine error: ${message}. Fix it, or type "popcorn abort" to end the run.`;
    if (event.type === "before_tool") return { kind: "deny", reason: text };
    if (event.type === "stop") return { kind: "halt", message: text };
    return { kind: "context", text: `[popcorn] ${text}`, notice: text };
  }

  // ---------- Starting a run ----------
  private start(projectDir: string, store: StateStore, args: string): Decision {
    const [task = "", ...rest] = args.trim().split(/\s+/);
    if (!task) return { kind: "context", text: "[popcorn] Start needs a task name.", notice: "popcorn: usage: popcorn start <task-name> <what to build>" };
    try {
      const wf = this.loadWorkflow(projectDir);
      const state = store.create(wf, task.toLowerCase(), rest.join(" ") || undefined);
      const phase = phaseById(wf, state.phase);
      return { kind: "context", text: this.brief(wf, state, phase, projectDir), notice: `popcorn: started run "${state.task}" (workflow "${wf.name}").` };
    } catch (e) {
      const msg = (e as Error).message;
      return { kind: "context", text: `[popcorn] Could not start the run: ${msg}`, notice: `popcorn: ${msg}` };
    }
  }

  // ---------- Human commands ----------
  private command(wf: Workflow, state: RunState, phase: Phase, store: StateStore, projectDir: string, verb: string, arg: string): Decision {
    const waiting = state.status === "awaiting_approval";
    const when = phase.approval === "before" ? "before" : "after";
    switch (verb) {
      case "start":
        return { kind: "context", text: `[popcorn] Run "${state.task}" is still active.`, notice: `popcorn: run "${state.task}" is active. Finish it or type "popcorn abort" first.` };
      case "status":
        return { kind: "context", text: this.brief(wf, state, phase, projectDir), notice: this.statusLine(wf, state) };
      case "abort":
        this.log(state, "abort", arg);
        state.status = "aborted";
        store.save(state);
        store.setActive(null);
        return { kind: "context", text: `[popcorn] The user aborted run "${state.task}". The workflow no longer applies; stop working on it.`, notice: `popcorn: run "${state.task}" aborted.` };
      case "retry":
        if (state.status !== "escalated") return { kind: "context", text: this.brief(wf, state, phase, projectDir), notice: "popcorn: nothing to retry." };
        state.status = "running";
        state.attempts[phase.id] = 0;
        this.log(state, "retry", arg);
        if (arg) state.feedback = arg;
        store.save(state);
        return { kind: "context", text: this.brief(wf, state, phase, projectDir), notice: `popcorn: retrying phase "${phase.id}".` };
      case "approve": {
        if (!waiting) return { kind: "context", text: this.brief(wf, state, phase, projectDir), notice: "popcorn: nothing is waiting for approval." };
        const round = state.rounds[phase.id] ?? 1;
        state.approvals[approvalKey(phase.id, round, when)] = this.env.now();
        this.log(state, "approve", `${when}${arg ? `: ${arg}` : ""}`);
        if (when === "before") {
          state.status = "running";
          store.save(state);
          return { kind: "context", text: this.brief(wf, state, phase, projectDir), notice: `popcorn: approved. Phase "${phase.id}" may start.` };
        }
        const next = nextPhase(wf, phase);
        if (!next) return this.finish(state, store, "context");
        this.enter(state, next);
        store.save(state);
        return { kind: "context", text: this.brief(wf, state, next, projectDir), notice: `popcorn: approved "${phase.id}". Next: "${next.id}".` };
      }
      case "reject": {
        if (!waiting) return { kind: "context", text: this.brief(wf, state, phase, projectDir), notice: "popcorn: nothing is waiting for approval." };
        state.feedback = arg || "The user rejected this without details; ask what to change.";
        this.log(state, "reject", arg);
        if (when === "after") {
          state.status = "running";
          state.attempts[phase.id] = 0;
        }
        store.save(state);
        const text = when === "after"
          ? this.brief(wf, state, phase, projectDir)
          : `[popcorn] The user declined to start phase "${phase.id}": ${state.feedback}. Don't start it; wait for the user.`;
        return { kind: "context", text, notice: `popcorn: rejected. ${when === "after" ? `Revising "${phase.id}".` : `Phase "${phase.id}" stays on hold.`}` };
      }
    }
    return { kind: "pass" };
  }

  // ---------- Stop: the deterministic part ----------
  private stop(wf: Workflow, state: RunState, phase: Phase, store: StateStore, projectDir: string): Decision {
    if (state.status === "awaiting_approval") {
      return { kind: "halt", message: this.waitingMessage(phase, state) };
    }
    if (state.status === "escalated") {
      return { kind: "halt", message: `popcorn: run "${state.task}" is stuck in phase "${phase.id}". Type "popcorn retry [hint]" to try again or "popcorn abort".` };
    }

    const check = this.checkPhase(wf, state, phase, projectDir);
    if (!check.ok && "fail" in check) {
      const back = phaseById(wf, phase.on_fail!);
      this.log(state, "fail", check.fail);
      state.feedback = check.fail;
      this.enter(state, back);
      store.save(state);
      return { kind: "continue", reason: `${check.fail}\n\nBack to phase "${back.id}".\n${this.brief(wf, state, back, projectDir)}` };
    }
    if (!check.ok) {
      const attempts = (state.attempts[phase.id] ?? 0) + 1;
      state.attempts[phase.id] = attempts;
      const max = wf.policy?.max_attempts_per_phase ?? DEFAULT_MAX_ATTEMPTS;
      if (attempts > max) {
        state.status = "escalated";
        this.log(state, "escalate", check.reason);
        store.save(state);
        return { kind: "halt", message: `popcorn: phase "${phase.id}" is still not complete after ${max} attempts: ${check.reason}\nType "popcorn retry [hint]" or "popcorn abort".` };
      }
      store.save(state);
      return { kind: "continue", reason: `[popcorn] Phase "${phase.id}" is not complete (attempt ${attempts}/${max}): ${check.reason}\nKeep working on it, then end your turn again.` };
    }

    // The phase is complete.
    state.feedback = undefined;
    this.log(state, "complete");
    if (this.allApproved(state, phase, projectDir)) state.passed = { ...state.passed, [phase.id]: state.rounds[phase.id] ?? 1 };
    if (phase.approval === "after") {
      state.status = "awaiting_approval";
      store.save(state);
      return { kind: "halt", message: this.waitingMessage(phase, state) };
    }
    const next = nextPhase(wf, phase);
    if (!next) return this.finish(state, store, "halt");
    this.enter(state, next);
    store.save(state);
    if (next.approval === "before") return { kind: "halt", message: this.waitingMessage(next, state) };
    return { kind: "continue", reason: this.brief(wf, state, next, projectDir) };
  }

  /** Checks the phase's done-conditions in order: artifacts, agent outputs, then gates. */
  checkPhase(wf: Workflow, state: RunState, phase: Phase, projectDir: string): Check {
    const vars = { task: state.task, phase: phase.id, round: state.rounds[phase.id] ?? 1 };
    const missing = (phase.artifacts ?? []).map(a => fill(a, vars)).filter(a => !this.env.exists(join(projectDir, a)));
    if (missing.length) return { ok: false, reason: `missing artifacts: ${missing.join(", ")}` };

    if (phase.outputs) {
      const dir = outputsDir(state.task, phase.id, vars.round);
      const problems: string[] = [];
      const blocking: string[] = [];
      const severities = wf.policy?.blocking_severities ?? DEFAULT_BLOCKING;
      for (const agent of phase.outputs.required) {
        const file = join(projectDir, dir, `${agent}.json`);
        if (!this.env.exists(file)) { problems.push(`${dir}/${agent}.json is missing`); continue; }
        let data: unknown;
        try { data = JSON.parse(this.env.readText(file)); }
        catch { problems.push(`${dir}/${agent}.json is not valid JSON`); continue; }
        const bad = outputProblems(wf, phase.outputs.schema, data);
        if (bad.length) { problems.push(`${dir}/${agent}.json does not match schema "${phase.outputs.schema}": ${bad.join("; ")}`); continue; }
        const verdict = (data as { verdict?: unknown })?.verdict;
        if (typeof verdict === "string" && (wf.policy?.blocking_verdicts ?? []).includes(verdict)) {
          blocking.push(`${agent}: verdict ${verdict}`);
        }
        for (const f of findings(data)) {
          if (severities.includes(String(f.severity).toUpperCase())) blocking.push(`${agent}: [${f.severity}] ${f.title ?? f.problem ?? JSON.stringify(f)}`);
        }
      }
      if (problems.length) return { ok: false, reason: problems.join("; ") };
      if (blocking.length) return { ok: false, fail: `[popcorn] Blocking findings in phase "${phase.id}":\n- ${blocking.join("\n- ")}` };
    }

    const timeout = (wf.policy?.gate_timeout_seconds ?? DEFAULT_GATE_TIMEOUT_S) * 1000;
    const key = this.treeKey(projectDir);
    for (const cmd of (phase.gates ?? []).map(g => fill(g, vars))) {
      const cacheId = `${phase.id}#${vars.round}#${cmd}`;
      const cached = state.gateCache[cacheId];
      // Only a pass is reused: a gate can depend on more than the tree (e.g. what was pushed to a remote).
      const r = key && cached?.key === key && cached.code === 0 ? cached : { key: key ?? "", ...this.env.run(cmd, projectDir, timeout) };
      state.gateCache[cacheId] = { key: r.key, code: r.code, output: tail(r.output, 2000) };
      if (r.code !== 0) return { ok: false, reason: `gate \`${cmd}\` failed (exit ${r.code}):\n${tail(r.output)}` };
    }
    return { ok: true };
  }

  /** A key for the working tree (HEAD + uncommitted changes), so an unchanged tree doesn't rerun gates. */
  private treeKey(projectDir: string): string | null {
    // HEAD, the content of every uncommitted change, and the content of untracked files; popcorn's own files excluded.
    const r = this.env.run(
      "git rev-parse HEAD && git diff HEAD --binary -- . ':(exclude).popcorn' && " +
      "git ls-files --others --exclude-standard -- . ':(exclude).popcorn' | while IFS= read -r f; do echo \"$f $(git hash-object -- \"$f\")\"; done",
      projectDir, 30_000);
    if (r.code !== 0) return null;
    return createHash("sha256").update(r.output).digest("hex").slice(0, 16);
  }

  /** Whether every output of a completed phase says `verdict: "approve"` (trivially true without outputs). */
  private allApproved(state: RunState, phase: Phase, projectDir: string): boolean {
    if (!phase.outputs) return true;
    const dir = outputsDir(state.task, phase.id, state.rounds[phase.id] ?? 1);
    return phase.outputs.required.every(agent => {
      try { return (JSON.parse(this.env.readText(join(projectDir, dir, `${agent}.json`))) as { verdict?: unknown }).verdict === "approve"; }
      catch { return false; }
    });
  }

  // ---------- Helpers ----------
  private enter(state: RunState, phase: Phase) {
    state.phase = phase.id;
    state.rounds[phase.id] = (state.rounds[phase.id] ?? 0) + 1;
    state.attempts[phase.id] = 0;
    state.status = phase.approval === "before" ? "awaiting_approval" : "running";
    this.log(state, "enter");
  }

  private finish(state: RunState, store: StateStore, as: "halt" | "context"): Decision {
    state.status = "done";
    this.log(state, "done");
    store.save(state);
    store.setActive(null);
    const message = `popcorn: run "${state.task}" is complete. Every phase passed.`;
    return as === "halt" ? { kind: "halt", message } : { kind: "context", text: `[popcorn] ${message}`, notice: message };
  }

  private log(state: RunState, event: string, detail?: string) {
    state.history.push({ at: this.env.now(), event, phase: state.phase, ...(detail ? { detail } : {}) });
  }

  private waitingMessage(phase: Phase, state: RunState): string {
    const what = phase.approval === "before" ? `to start phase "${phase.id}"` : `phase "${phase.id}" (review its result first)`;
    return `popcorn: run "${state.task}" is waiting for your approval ${what}. Type "popcorn approve" or "popcorn reject <feedback>".`;
  }

  private statusLine(wf: Workflow, state: RunState): string {
    const i = wf.phases.findIndex(p => p.id === state.phase);
    return `popcorn: run "${state.task}", phase ${i + 1}/${wf.phases.length} "${state.phase}" (round ${state.rounds[state.phase] ?? 1}), ${state.status}.`;
  }

  /** The instruction the agent gets for the current phase. */
  brief(wf: Workflow, state: RunState, phase: Phase, projectDir: string): string {
    const round = state.rounds[phase.id] ?? 1;
    const vars = { task: state.task, phase: phase.id, round };
    const i = wf.phases.indexOf(phase);
    const lines = [
      `[popcorn] Run "${state.task}"${state.description ? ` (${state.description})` : ""}: phase ${i + 1}/${wf.phases.length} "${phase.title ?? phase.id}", round ${round}, ${state.status}.`,
      `Goal: ${fill(phase.goal, vars)}`,
    ];
    if (state.status === "awaiting_approval") lines.push(this.waitingMessage(phase, state).replace(/^popcorn: /, "") + " Don't start the work; wait for the user.");
    if (phase.agent) lines.push(`Agent: delegate this phase's work to the \`${this.agentRef(phase.agent, projectDir)}\` subagent.`);
    if (phase.instructions) lines.push(`Instructions: ${fill(phase.instructions, vars).trim()}`);
    if (state.feedback) lines.push(`Feedback to address first: ${state.feedback}`);

    const done: string[] = [];
    if (phase.artifacts?.length) done.push(`these files exist: ${phase.artifacts.map(a => fill(a, vars)).join(", ")}`);
    if (phase.outputs) {
      const dir = outputsDir(state.task, phase.id, round);
      done.push(`each of ${phase.outputs.required.map(a => `\`${this.agentRef(a, projectDir)}\``).join(", ")} wrote its result as JSON matching schema "${phase.outputs.schema}" to ${dir}/<agent-name>.json (findings with severity ${(wf.policy?.blocking_severities ?? DEFAULT_BLOCKING).join("/")} send the run back to "${phase.on_fail}")`);
      if (wf.schemas?.[phase.outputs.schema]) done.push(`schema "${phase.outputs.schema}": ${JSON.stringify(wf.schemas[phase.outputs.schema])}`);
    }
    if (phase.gates?.length) done.push(`these commands pass: ${phase.gates.map(g => `\`${fill(g, vars)}\``).join(", ")}`);
    if (phase.approval === "after") done.push("the user approves the result");
    if (done.length) lines.push(`Done when: ${done.join("; ")}.`);

    const rules: string[] = [];
    if (phase.allow?.edit) rules.push(`you may edit only ${phase.allow.edit.join(", ")}`);
    if (phase.allow?.mcp) rules.push(`MCP servers allowed: ${phase.allow.mcp.join(", ") || "none"}`);
    if (phase.allow?.guarded?.length) {
      const by = [phase.approval === "before" ? "the user's approval" : "", phase.unlock_after ? `phase "${phase.unlock_after}" passing with every reviewer approving` : ""].filter(Boolean).join(" and ");
      rules.push(`unlocked by ${by}: ${phase.allow.guarded.join(", ")}`);
    }
    if (rules.length) lines.push(`Rules: ${rules.join("; ")}.`);
    lines.push("When the phase's work is done, end your turn: popcorn checks it and tells you what comes next. Never edit .popcorn/runs or the workflow file, and never claim an approval: only the user can approve.");
    return lines.join("\n");
  }
}

type FindingLike = { severity?: unknown; title?: string; problem?: string };
/** Findings in an agent output: a top-level `findings` array, if there is one. */
function findings(data: unknown): FindingLike[] {
  const f = (data as { findings?: unknown })?.findings;
  return Array.isArray(f) ? (f as FindingLike[]).filter(x => x && typeof x === "object") : [];
}
