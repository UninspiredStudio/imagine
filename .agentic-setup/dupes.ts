// bun .agentic-setup/dupes.ts [--write] : copied code (jscpd 5.4.2), new copies only. The duplication a
// repo already has sits in .checks/jscpd-baseline.json (committed, like the lint baseline); a copy that isn't in
// it fails as "file:line: copies other:start-end". --write records the current copies after a deliberate
// change. Tests, generated files and Subframe output don't count; renamed identifiers still match.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitPath, repoRoot, sh } from "./check.ts";

const root = repoRoot();
const bin = join(root, "node_modules/.bin/jscpd");
if (!existsSync(bin)) {
  console.log("dupes: jscpd isn't installed here (it's a devDependency: bun install)");
  process.exit(1);
}
const out = gitPath(root, "jscpd");
const ignore = [
  "**/node_modules/**", "**/dist/**", "**/.agentic-setup/**", "**/worker-configuration.d.ts", "**/*.gen.ts",
  "**/ui/components/**", "**/ui/layouts/**", "packages/components/ui/**",
  "**/*.test.*", "**/*.spec.*", "**/e2e/**", "**/__tests__/**",
].join(",");
const write = process.argv.includes("--write");
const args = [`'${bin}'`, "--no-tips", "--silent", "--reporters", "json", "-o", `'${out}'`, "--format", "typescript,tsx,javascript,jsx",
  "--ignore-identifiers", "--ignore", `'${ignore}'`, "--baseline", ".checks/jscpd-baseline.json", ...(write ? ["--update-baseline"] : []), "."];
const r = await sh(args.join(" "), root, {}, 5 * 60_000);
if (r.code !== 0) {
  console.log(`dupes: jscpd failed\n${r.out.trim().split("\n").slice(-10).join("\n")}`);
  process.exit(r.code);
}
if (write) {
  // The repo's formatter owns JSON layout, as with the lint baseline.
  const fmt = join(root, "node_modules/.bin/oxfmt");
  if (existsSync(fmt)) await sh(`'${fmt}' .checks/jscpd-baseline.json`, root, {});
  console.log(`dupes: baseline written (${r.out.trim().split("\n").at(-1)})`);
  process.exit(r.code);
}
const report = join(out, "jscpd-report.json");
if (!existsSync(report)) {
  console.log(`dupes: jscpd failed\n${r.out.trim().split("\n").slice(-10).join("\n")}`);
  process.exit(1);
}
type Clone = { isNew?: boolean; lines: number; firstFile: { name: string; start: number }; secondFile: { name: string; start: number; end: number } };
const fresh = (JSON.parse(readFileSync(report, "utf8")).duplicates as Clone[]).filter((d) => d.isNew);
for (const d of fresh)
  console.log(`${d.firstFile.name}:${d.firstFile.start}: copies ${d.secondFile.name}:${d.secondFile.start}-${d.secondFile.end} (${d.lines} lines); import or share it instead`);
process.exit(fresh.length ? 1 : 0);
