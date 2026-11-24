import { describe, expect, it } from "vitest";
import type { Adapter } from "../../src/adapters/types.js";
import type { NormalizedEvent } from "../../src/core/types.js";

/** Platform payloads an adapter's contract test needs: one per normalized event, plus an unknown one. */
export interface ContractFixtures {
  sessionStart: unknown;
  prompt: unknown;
  beforeTool: unknown;
  stop: unknown;
  unknown: unknown;
  /** Exit codes the platform treats as "this tool call is refused". */
  blockingExit: (code: number, stdout: string) => boolean;
}

/**
 * The contract every adapter must meet, whatever its platform. A new adapter gets these tests for free:
 * import this and call it with the platform's real hook payloads.
 */
export function adapterContract(adapter: Adapter, fx: ContractFixtures) {
  describe(`adapter contract: ${adapter.name}`, () => {
    const parse = (p: unknown) => adapter.parse(p, {});

    it("maps each platform event to the matching normalized event", () => {
      expect(parse(fx.sessionStart)?.type).toBe("session_start");
      expect(parse(fx.prompt)?.type).toBe("prompt");
      expect(parse(fx.beforeTool)?.type).toBe("before_tool");
      expect(parse(fx.stop)?.type).toBe("stop");
    });

    it("ignores events popcorn doesn't handle", () => {
      expect(parse(fx.unknown)).toBeNull();
    });

    it("prints nothing for pass, so popcorn is invisible without a run", () => {
      for (const p of [fx.sessionStart, fx.prompt, fx.beforeTool, fx.stop]) {
        const out = adapter.render(parse(p)!, { kind: "pass" });
        expect(out).toEqual({ stdout: "", exitCode: 0 });
      }
    });

    it("refuses the tool call on deny", () => {
      const out = adapter.render(parse(fx.beforeTool)!, { kind: "deny", reason: "nope" });
      expect(fx.blockingExit(out.exitCode, out.stdout)).toBe(true);
      expect(out.stdout).toContain("nope");
    });

    it("refuses the tool call when the engine crashed (never fails open)", () => {
      const out = adapter.renderCrash(fx.beforeTool, "boom");
      expect(fx.blockingExit(out.exitCode, out.stdout)).toBe(true);
    });

    it("carries the next instruction on continue, and a message on halt", () => {
      const ev = parse(fx.stop) as NormalizedEvent;
      expect(adapter.render(ev, { kind: "continue", reason: "do phase 2" }).stdout).toContain("do phase 2");
      expect(adapter.render(ev, { kind: "halt", message: "waiting" }).stdout).toContain("waiting");
    });

    it("delivers context text to the agent", () => {
      expect(adapter.render(parse(fx.prompt)!, { kind: "context", text: "brief" }).stdout).toContain("brief");
      expect(adapter.render(parse(fx.sessionStart)!, { kind: "context", text: "brief" }).stdout).toContain("brief");
    });

    it("names agents with a non-empty reference", () => {
      expect(adapter.agentRef("code-reviewer", "/nowhere")).toMatch(/code-reviewer/);
    });
  });
}
