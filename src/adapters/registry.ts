import type { Adapter } from "./types.js";
import { createClaudeAdapter } from "./claude/index.js";

/** Every platform popcorn can drive. A new platform is a new entry here, and nothing in src/core changes. */
const FACTORIES: Record<string, () => Adapter> = {
  claude: () => createClaudeAdapter(),
};

export const adapterNames = () => Object.keys(FACTORIES);

export function getAdapter(name: string): Adapter {
  const make = FACTORIES[name];
  if (!make) throw new Error(`unknown adapter "${name}" (available: ${adapterNames().join(", ")})`);
  return make();
}
