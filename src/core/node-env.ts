import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Env } from "./types.js";

/** The real side effects: the file system and a shell. */
export const nodeEnv: Env = {
  exists: p => existsSync(p),
  readText: p => readFileSync(p, "utf8"),
  writeText: (p, text) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  },
  run: (command, cwd, timeoutMs) => {
    const r = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      code: r.status ?? 1,
      output: `${r.stdout ?? ""}${r.stderr ?? ""}${timedOut ? `\n(timed out after ${timeoutMs / 1000}s)` : ""}`,
    };
  },
  now: () => new Date().toISOString(),
};
