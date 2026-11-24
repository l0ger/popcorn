import { describe, expect, it } from "vitest";
import { createClaudeAdapter, normalizeTool } from "../../src/adapters/claude/index.js";
import { getAdapter, adapterNames } from "../../src/adapters/registry.js";
import type { NormalizedEvent } from "../../src/core/types.js";
import { adapterContract } from "./adapter-contract.js";

// Payload shapes as documented in https://code.claude.com/docs/en/hooks.md
const base = { session_id: "abc123", transcript_path: "/t.jsonl", cwd: "/work/app", permission_mode: "default" };
const fx = {
  sessionStart: { ...base, hook_event_name: "SessionStart", source: "startup" },
  prompt: { ...base, hook_event_name: "UserPromptSubmit", prompt: "popcorn approve" },
  beforeTool: { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push", description: "push" }, tool_use_id: "toolu_1" },
  stop: { ...base, hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "done" },
  unknown: { ...base, hook_event_name: "SubagentStop", agent_type: "Explore" },
};
const claudeBlocks = (code: number, stdout: string) =>
  code === 2 || (code === 0 && JSON.parse(stdout || "{}").hookSpecificOutput?.permissionDecision === "deny");

adapterContract(createClaudeAdapter(() => false), { ...fx, blockingExit: claudeBlocks });

describe("claude adapter: parse", () => {
  const a = createClaudeAdapter(() => false);

  it("reads the prompt, the stop flag and the tool call", () => {
    expect(a.parse(fx.prompt, {})).toEqual({ type: "prompt", projectDir: "/work/app", prompt: "popcorn approve" });
    expect(a.parse(fx.stop, {})).toEqual({ type: "stop", projectDir: "/work/app", stopHookActive: true });
    expect(a.parse(fx.beforeTool, {})).toEqual({
      type: "before_tool", projectDir: "/work/app", call: { kind: "shell", command: "git push", tool: "Bash" },
    });
  });

  it("passes the calling subagent's name along", () => {
    const ev = a.parse({ ...fx.beforeTool, agent_id: "a1", agent_type: "popcorn:code-reviewer" }, {});
    expect(ev).toMatchObject({ type: "before_tool", agent: "popcorn:code-reviewer" });
    expect(a.parse(fx.beforeTool, {})).not.toHaveProperty("agent");
  });

  it("prefers CLAUDE_PROJECT_DIR over the payload's cwd", () => {
    expect(a.parse(fx.stop, { projectDir: "/repo" })?.projectDir).toBe("/repo");
  });

  it("ignores payloads without a project directory or event name", () => {
    expect(a.parse({ hook_event_name: "Stop" }, {})).toBeNull();
    expect(a.parse(null, {})).toBeNull();
    expect(a.parse({ cwd: "/x" }, {})).toBeNull();
  });
});

describe("claude adapter: normalizeTool", () => {
  it("maps file-editing tools to edits", () => {
    expect(normalizeTool("Edit", { file_path: "/a/b.ts" })).toEqual({ kind: "edit", path: "/a/b.ts", tool: "Edit" });
    expect(normalizeTool("Write", { file_path: "/a/c.ts", content: "x" })).toMatchObject({ kind: "edit", path: "/a/c.ts" });
    expect(normalizeTool("MultiEdit", { file_path: "/a/d.ts" })).toMatchObject({ kind: "edit" });
    expect(normalizeTool("NotebookEdit", { notebook_path: "/a/n.ipynb" })).toMatchObject({ kind: "edit", path: "/a/n.ipynb" });
  });
  it("treats an edit without a path as an ordinary tool", () => {
    expect(normalizeTool("Edit", {})).toEqual({ kind: "other", tool: "Edit" });
  });
  it("maps Bash and PowerShell to shell", () => {
    expect(normalizeTool("Bash", { command: "ls" })).toEqual({ kind: "shell", command: "ls", tool: "Bash" });
    expect(normalizeTool("PowerShell", { command: "dir" })).toMatchObject({ kind: "shell", command: "dir" });
  });
  it("splits MCP tool names into server and tool", () => {
    expect(normalizeTool("mcp__github__create_issue")).toEqual({ kind: "mcp", server: "github", name: "create_issue", tool: "mcp__github__create_issue" });
    expect(normalizeTool("mcp__plugin_popcorn_docs__search")).toMatchObject({ kind: "mcp", server: "plugin_popcorn_docs", name: "search" });
  });
  it("passes other tools through", () => {
    expect(normalizeTool("Read", { file_path: "/x" })).toEqual({ kind: "other", tool: "Read" });
  });
});

describe("claude adapter: render", () => {
  const a = createClaudeAdapter(() => false);
  const ev = (p: unknown) => a.parse(p, {}) as NormalizedEvent;
  const out = (p: unknown, d: Parameters<typeof a.render>[1]) => JSON.parse(a.render(ev(p), d).stdout);

  it("denies a tool with PreToolUse permissionDecision", () => {
    expect(out(fx.beforeTool, { kind: "deny", reason: "guarded" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "guarded" },
    });
  });
  it("blocks a stop with decision block and the reason as the next instruction", () => {
    expect(out(fx.stop, { kind: "continue", reason: "next phase" })).toEqual({ decision: "block", reason: "next phase" });
  });
  it("lets the agent stop with a message for the user on halt", () => {
    expect(out(fx.stop, { kind: "halt", message: "approve?" })).toEqual({ systemMessage: "approve?" });
  });
  it("adds context to the right event, with an optional notice", () => {
    expect(out(fx.prompt, { kind: "context", text: "brief", notice: "approved" })).toEqual({
      systemMessage: "approved", hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "brief" },
    });
    expect(out(fx.sessionStart, { kind: "context", text: "brief" })).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "brief" },
    });
  });
  it("never emits context JSON on events that can't carry it", () => {
    expect(a.render(ev(fx.stop), { kind: "context", text: "brief" }).stdout).toBe("");
  });
  it("renders a crash outside PreToolUse as a message, never a block", () => {
    expect(JSON.parse(a.renderCrash(fx.stop, "boom").stdout)).toEqual({ systemMessage: "popcorn hook error: boom" });
  });
});

describe("claude adapter: agentRef", () => {
  it("uses the plugin's namespaced agent by default", () => {
    expect(createClaudeAdapter(() => false).agentRef("code-reviewer", "/p")).toBe("popcorn:code-reviewer");
  });
  it("uses the project's own agent when .claude/agents/<name>.md exists", () => {
    const a = createClaudeAdapter(p => p === "/p/.claude/agents/code-reviewer.md");
    expect(a.agentRef("code-reviewer", "/p")).toBe("code-reviewer");
    expect(a.agentRef("architect", "/p")).toBe("popcorn:architect");
  });
});

describe("adapter registry", () => {
  it("lists claude and builds it by name", () => {
    expect(adapterNames()).toContain("claude");
    expect(getAdapter("claude").name).toBe("claude");
  });
  it("throws on an unknown adapter", () => {
    expect(() => getAdapter("nope")).toThrow(/unknown adapter "nope"/);
  });
});
