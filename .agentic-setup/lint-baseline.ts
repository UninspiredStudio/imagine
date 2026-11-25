// bun .agentic-setup/lint-baseline.ts --write | --check
// --write: lints the whole repo without the baseline, records the findings per file and rule in
//   .checks/oxlint.baseline.counts.json, and writes .checks/oxlint.baseline.json, which turns each rule off for
//   exactly the files that have findings, so `check` stays green while stage 2 fixes them.
// --check: lints again without the baseline. Fails when a file has more findings for a rule than
//   recorded; reports lower counts without writing. --write explicitly refreshes the baseline.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { caps } from "./caps.ts";
import { loadConfig, repoRoot } from "./check.ts";

type Counts = Record<string, Record<string, number>>;
type Finding = { file: string; rule: string; line: number; col: number; message: string };

const root = repoRoot();
const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") throw new Error("usage: lint-baseline.ts --write | --check");
const targets = (await loadConfig(root)).lint ?? [{}];
let cwd = root;
let lint: { cwd?: string; args?: string[] } = {};
let countsPath = "";
let baselinePath = "";

/** Lints with the baseline left out: a JSON root gets a temporary copy without it in `extends`,
 *  a TS root reads AGENTIC_NO_BASELINE and leaves the baseline's overrides out. */
function lintWithoutBaseline(): Finding[] {
  let config = ["oxlint.config.ts", ".oxlintrc.json"].find((f) => existsSync(join(cwd, f)));
  if (!config) throw new Error(`no oxlint config in ${cwd}`);
  let temp: string | undefined;
  if (config.endsWith(".json")) {
    // By text, since root configs may be JSONC (comments): drop the baseline from `extends`.
    const text = readFileSync(join(cwd, config), "utf8").replace(/,?\s*"\.\/\.checks\/oxlint\.baseline\.json"/, "");
    temp = join(cwd, ".oxlintrc.nobaseline.json");
    writeFileSync(temp, text);
    config = ".oxlintrc.nobaseline.json";
  }
  try {
    // The lint folder's own oxlint first (workspaces may not hoist it), then the root's.
    const ox = [join(cwd, "node_modules/.bin/oxlint"), join(root, "node_modules/.bin/oxlint")].find(existsSync);
    if (!ox) throw new Error(`no oxlint in ${cwd} or ${root}: run bun install`);
    const r = spawnSync(ox, ["-c", config, "-f", "json", "--ignore-pattern", ".agentic-setup/**", ...(lint.args ?? ["."])], {
      cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: { ...process.env, AGENTIC_NO_BASELINE: "1", GOMAXPROCS: caps().GOMAXPROCS },
    });
    if (r.error || r.signal || (r.status !== 0 && r.status !== 1))
      throw new Error(`oxlint failed (exit ${r.status}, signal ${r.signal}): ${r.error?.message ?? r.stderr.slice(0, 2000)}`);
    const start = r.stdout.indexOf("{");
    if (start < 0) throw new Error(`oxlint printed no JSON (exit ${r.status}):\n${r.stderr.slice(0, 2000)}`);
    const all = JSON.parse(r.stdout.slice(start)).diagnostics;
    if (!Array.isArray(all) || (r.status !== 0 && !all.length))
      throw new Error(`oxlint failed without classifiable diagnostics (exit ${r.status}): ${r.stderr.slice(0, 2000)}`);
    // No rule code (an unused disable directive) or tsgolint's tsconfig-error (a file no tsconfig
    // covers): an override can't turn these off, so they are fixed by hand.
    const held = (d: any) => typeof d?.code === "string" && /^([\w-]+)\((.+)\)$/.test(d.code)
      && !d.code.endsWith("(tsconfig-error)") && typeof d.filename === "string";
    const unclassified = all.filter((d: any) => !held(d));
    if (unclassified.length)
      throw new Error(`oxlint has ${unclassified.length} unclassifiable/configuration diagnostic(s); fix by hand: ${unclassified.map((d: any) => d?.message ?? "unknown diagnostic").join("; ")}`);
    return all.map((d: any) => {
      const m = /^([\w-]+)\((.+)\)$/.exec(d.code)!;
      const span = d.labels?.[0]?.span ?? {};
      return {
        file: relative(cwd, join(cwd, d.filename)),
        rule: m[1] === "eslint" ? m[2] : `${m[1]}/${m[2]}`,
        line: span.line ?? 1, col: span.column ?? 1, message: d.message,
      };
    });
  } finally {
    if (temp) rmSync(temp, { force: true });
  }
}

function tally(findings: Finding[]): Counts {
  const c: Counts = {};
  for (const f of findings) (c[f.file] ??= {})[f.rule] = (c[f.file]?.[f.rule] ?? 0) + 1;
  return c;
}

function write(counts: Counts) {
  mkdirSync(dirname(countsPath), { recursive: true });
  const sorted = Object.fromEntries(Object.keys(counts).sort().map((f) => [f, Object.fromEntries(Object.entries(counts[f]).sort())]));
  writeFileSync(countsPath, JSON.stringify(sorted, null, 2) + "\n");
  const byRule: Record<string, string[]> = {};
  for (const [file, rules] of Object.entries(sorted)) for (const rule of Object.keys(rules)) (byRule[rule] ??= []).push(file);
  // Paths are globs to oxlint, so brackets and other glob characters are matched literally.
  const literal = (f: string) => f.replace(/[[\]*?{}!]/g, (c) => `[${c}]`);
  const overrides = Object.keys(byRule).sort().map((rule) => ({ files: byRule[rule].map(literal), rules: { [rule]: "off" } }));
  writeFileSync(baselinePath, JSON.stringify({ overrides }, null, 2) + "\n");
  // In the repo's own formatting, so its format check passes on the generated files.
  const oxfmt = join(root, "node_modules/.bin/oxfmt");
  if (existsSync(oxfmt)) spawnSync(oxfmt, [countsPath, baselinePath], { cwd: root });
}

let failed = false;
for (const target of targets) {
  lint = target;
  cwd = join(root, target.cwd ?? ".");
  countsPath = join(cwd, ".checks/oxlint.baseline.counts.json");
  baselinePath = join(cwd, ".checks/oxlint.baseline.json");
  const where = target.cwd ?? ".";
  if (mode === "--check" && !existsSync(countsPath)) {
    console.log(`lint-baseline: ${where}: no baseline yet (bun .agentic-setup/lint-baseline.ts --write)`);
    continue;
  }
  const findings = lintWithoutBaseline();
  const now = tally(findings);
  if (mode === "--write") {
    write(now);
    console.log(`lint-baseline: ${where}: recorded ${findings.length} findings in ${Object.keys(now).length} files`);
    continue;
  }
  const recorded: Counts = JSON.parse(readFileSync(countsPath, "utf8"));
  const over = new Set<string>();
  for (const [file, rules] of Object.entries(now))
    for (const [rule, n] of Object.entries(rules)) if (n > (recorded[file]?.[rule] ?? 0)) over.add(`${file}\0${rule}`);
  if (over.size) {
    for (const f of findings.filter((f) => over.has(`${f.file}\0${f.rule}`)))
      console.log(`${join(where, f.file)}:${f.line}:${f.col}: ${f.rule}: ${f.message}`);
    console.log(`lint-baseline: ${where}: ${over.size} file and rule pair${over.size === 1 ? " has" : "s have"} more findings than the baseline allows`);
    failed = true;
    continue;
  }
  const lowered = Object.keys(recorded).some((f) => Object.keys(recorded[f]).some((r) => (now[f]?.[r] ?? 0) < recorded[f][r]));
  console.log(`lint-baseline: ${where}: ok, ${findings.length} known findings${lowered ? " (counts fell; use --write to update the baseline)" : ""}`);
}
process.exit(failed ? 1 : 0);
