// bun .agentic-setup/e2e.ts [spec…] | --changed : browser specs in the lane, with a 3-minute budget
// that starts once the lane is ours. While another job holds the lane it waits (heavy gives up after
// 20 minutes) and says who holds it as that changes. --changed takes the changes since its own last
// green run (not check's: a commit followed by a green check would leave it nothing), maps them
// through e2e.map, adds the changed specs themselves, and runs the smoke set for a UI file no glob
// matches.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CAPS, git, gitPath, loadConfig, problems, repoRoot, scope, sh } from "./check.ts";

const root = repoRoot();
const config = await loadConfig(root);
if (!config.e2e) {
  console.log("e2e: this repo has no browser tests");
  process.exit(0);
}
const { run, smoke, map } = config.e2e;
const args = process.argv.slice(2);
let specs = args.filter((a) => a !== "--changed");
let grep: string | undefined;
const changed = args.includes("--changed");
// The mark a green run leaves is the HEAD its scope was taken from: a commit made during the lane wait
// or the run is the next run's to cover.
const head = git(root, "rev-parse", "HEAD");
if (changed) {
  const s = scope(root, config.base, "agentic-e2e");
  const hits = Object.entries(map).filter(([glob]) => s.files.some((f) => new Bun.Glob(glob).match(f)));
  // An edited spec runs itself, whatever its folder maps to: a spec in a folder the map or the smoke
  // set already names (so a GPU spec never joins a ui run), by its repo path, which Playwright
  // matches against the file's full path.
  const specDirs = [...new Set([...Object.values(map).flat(), ...(typeof smoke === "string" ? [] : smoke)].map((p) => p.replace(/\/[^/]*$/, "")))];
  const edited = s.files.filter((f) => /\.spec\.[cm]?[jt]sx?$/.test(f) && existsSync(join(root, f)) && specDirs.some((d) => `/${f}`.includes(`/${d}/`)));
  specs = [...new Set([...hits.flatMap(([, list]) => list), ...edited])];
  // Markup, styles and source (a store or a handler no glob names can break a screen); not tests,
  // specs or declarations.
  const ui = s.files.filter((f) => /\.(tsx|jsx|css|html|vue|astro|svelte|mdx|[cm]?[jt]s)$/.test(f) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(f));
  const unmapped = ui.some((f) => !hits.some(([glob]) => new Bun.Glob(glob).match(f)));
  if (unmapped || (s.all && !specs.length)) {
    if (typeof smoke === "string") grep = smoke;
    else specs = [...new Set([...specs, ...smoke])];
  }
  if (!specs.length && !grep) {
    console.log("e2e: nothing to run (no UI change in scope)");
    process.exit(0);
  }
}
const quote = (a: string) => `'${a.replace(/'/g, "'\\''")}'`;
// Mapped specs run whole; a smoke tag runs as its own command, so it never filters them.
const build = (s: string[], g?: string) =>
  typeof run === "function" ? run(s, g) : [run, ...(g ? ["--grep", quote(g)] : []), ...s.map(quote)].join(" ");
const cmd = grep && specs.length ? `${build(specs)} && ${build([], grep)}` : build(specs, grep);
const holderFile = join(homedir(), "Library/Caches/uninspired/lane-0.holder");
const holder = () => (existsSync(holderFile) ? readFileSync(holderFile, "utf8").trim() : "") || "unknown";
let since = 0, heard = "", said = 0, ticker: ReturnType<typeof setInterval> | undefined;
const waited = () => `${Math.round((Date.now() - since) / 1000)} s`;
// Live lines (the summary comes at the end): who holds the lane now, when it changes or every 2 minutes.
const onLane = (state: "waiting" | "got") => {
  if (state === "waiting" && !ticker) {
    since = said = Date.now();
    heard = holder();
    console.log(`e2e: waiting for the browser lane, held by: ${heard}`);
    ticker = setInterval(() => {
      const now = holder();
      if (now === heard && Date.now() - said < 120_000) return;
      heard = now;
      said = Date.now();
      console.log(`e2e: still waiting for the browser lane (${waited()}), held by: ${now}`);
    }, 15_000);
  } else if (state === "got" && ticker) {
    clearInterval(ticker);
    console.log(`e2e: got the browser lane after ${waited()}; its ${budget / 1000} s budget starts now`);
  }
};
// The run's budget (UNINSPIRED_E2E_MS moves it for the setup's own tests).
const budget = Number(process.env.UNINSPIRED_E2E_MS ?? 180_000);
const r = await sh('sh .agentic-setup/heavy sh -c "$E2E_CMD"', root, { ...CAPS, E2E_CMD: cmd }, budget, true, onLane);
if (ticker) clearInterval(ticker);
const last = r.out.trimEnd().split("\n").at(-1);
if (r.code !== 0) {
  for (const l of problems("e2e", r.out)) console.log(l);
  if (r.out.includes("gave up on the browser lane")) {
    console.log(`e2e: still queued for the browser lane after 20 minutes (held by ${holder()}); run it again later`);
    process.exit(1);
  }
  console.log(`e2e: red in ${(r.ms / 1000).toFixed(1)} s`);
  process.exit(1);
}
// The next --changed starts here.
if (changed) writeFileSync(gitPath(root, "agentic-e2e"), head + "\n");
console.log(`e2e: green in ${(r.ms / 1000).toFixed(1)} s (${last})`);
