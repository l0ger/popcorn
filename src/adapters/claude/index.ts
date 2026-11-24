import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Decision, NormalizedEvent, ToolCall } from "../../core/types.js";
import type { Adapter, Rendered } from "../types.js";

/** The plugin's name, which namespaces its agents (`popcorn:<agent>`). */
export const PLUGIN_NAME = "popcorn";

type Payload = {
  hook_event_name?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  /** Set when the call comes from a subagent (documented for tool events). */
  agent_type?: string;
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Claude Code's tool call → popcorn's ToolCall. */
export function normalizeTool(name: string, input: Record<string, unknown> = {}): ToolCall {
  if (EDIT_TOOLS.has(name)) {
    const path = input.file_path ?? input.notebook_path;
    return typeof path === "string" && path ? { kind: "edit", path, tool: name } : { kind: "other", tool: name };
  }
  if (SHELL_TOOLS.has(name)) return { kind: "shell", command: String(input.command ?? ""), tool: name };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { kind: "mcp", server: mcp[1]!, name: mcp[2]!, tool: name };
  return { kind: "other", tool: name };
}

const json = (o: unknown): Rendered => ({ stdout: JSON.stringify(o), exitCode: 0 });
const nothing: Rendered = { stdout: "", exitCode: 0 };

/** Claude Code adapter: hooks in plugin/hooks/hooks.json call `popcorn hook claude`. */
export function createClaudeAdapter(exists: (p: string) => boolean = existsSync): Adapter {
  return {
    name: "claude",

    parse(raw, env) {
      const p = (raw ?? {}) as Payload;
      const projectDir = env.projectDir || p.cwd;
      if (!projectDir) return null;
      switch (p.hook_event_name) {
        case "SessionStart": return { type: "session_start", projectDir };
        case "UserPromptSubmit": return { type: "prompt", projectDir, prompt: String(p.prompt ?? "") };
        case "PreToolUse": return {
          type: "before_tool", projectDir, call: normalizeTool(String(p.tool_name ?? ""), p.tool_input),
          ...(typeof p.agent_type === "string" && p.agent_type ? { agent: p.agent_type } : {}),
        };
        case "Stop": return { type: "stop", projectDir, stopHookActive: p.stop_hook_active === true };
        default: return null;
      }
    },

    render(event, d: Decision) {
      switch (d.kind) {
        case "pass":
          return nothing;
        case "deny":
          if (event.type === "before_tool") {
            return json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } });
          }
          return json({ systemMessage: d.reason });
        case "continue":
          return event.type === "stop" ? json({ decision: "block", reason: d.reason }) : json({ systemMessage: d.reason });
        case "halt":
          return json({ systemMessage: d.message });
        case "context": {
          const hookEventName = event.type === "session_start" ? "SessionStart" : event.type === "prompt" ? "UserPromptSubmit" : null;
          if (!hookEventName) return d.notice ? json({ systemMessage: d.notice }) : nothing;
          return json({ ...(d.notice ? { systemMessage: d.notice } : {}), hookSpecificOutput: { hookEventName, additionalContext: d.text } });
        }
      }
    },

    renderCrash(raw, message) {
      const event = (raw as Payload | null)?.hook_event_name;
      const text = `popcorn hook error: ${message}`;
      if (event === "PreToolUse") {
        return json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${text}. Tool calls are refused until this is fixed.` } });
      }
      return json({ systemMessage: text });
    },

    /** A project agent in .claude/agents/<name>.md overrides the plugin's agent of the same name. */
    agentRef(agent, projectDir) {
      return exists(join(projectDir, ".claude", "agents", `${agent}.md`)) ? agent : `${PLUGIN_NAME}:${agent}`;
    },
  };
}
