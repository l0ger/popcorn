import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeEnv } from "../core/node-env.js";
import { run } from "./run.js";

// The bundle lives in plugin/dist/, so its templates are in plugin/templates/.
const bundle = fileURLToPath(import.meta.url);
const here = dirname(bundle);

const result = run({
  argv: process.argv.slice(2),
  stdin: () => { try { return readFileSync(0, "utf8"); } catch { return ""; } },
  env: process.env,
  cwd: process.cwd(),
  fs: nodeEnv,
  templatesDir: join(here, "..", "templates"),
  // The plugin has no bin/ on PATH: hints name the bundle by its full path, the way the skills run it.
  self: `node "${bundle}"`,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
