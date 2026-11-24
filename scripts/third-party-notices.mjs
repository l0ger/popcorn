// Writes plugin/dist/THIRD_PARTY_NOTICES.md: the license of every npm package esbuild put in the bundle.
// Run by `npm run build` after esbuild, which writes the metafile this reads.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const meta = JSON.parse(readFileSync("plugin/dist/meta.json", "utf8"));
const names = new Set();
for (const input of Object.keys(meta.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) names.add(m[1]);
}
const sections = [...names].sort().map(name => {
  const dir = join("node_modules", name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find(f => /^licen[cs]e/i.test(f));
  if (!file) throw new Error(`${name}: no LICENSE file to copy`);
  return `## ${name} ${pkg.version} (${pkg.license})\n\n\`\`\`\n${readFileSync(join(dir, file), "utf8").trim()}\n\`\`\`\n`;
});
writeFileSync("plugin/dist/THIRD_PARTY_NOTICES.md",
  `# Third-party notices\n\n\`popcorn.mjs\` bundles the following packages. Their licenses follow.\n\n${sections.join("\n")}`);
console.log(`THIRD_PARTY_NOTICES.md: ${[...names].sort().join(", ")}`);
