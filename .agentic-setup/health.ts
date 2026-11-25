// bun .agentic-setup/health.ts : warns (never fails) when a repo drifts from the shared setup.
// `check` runs it first, so it has to stay under 0.2 s.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);
const hash = (p: string) => new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
const git = (root: string, ...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";

export function health(root: string): string[] {
  const w: string[] = [];
  const setup = join(root, ".agentic-setup");
  const manifest = JSON.parse(read(join(setup, "manifest.json")) ?? "{}");
  for (const [file, h] of Object.entries<string>(manifest.files ?? {})) {
    const p = join(setup, file);
    if (!existsSync(p)) w.push(`.agentic-setup/${file} is missing: re-run sync`);
    else if (hash(p) !== h) w.push(`.agentic-setup/${file} was edited by hand: change it in agentic-setup and re-sync`);
  }
  const block = read(join(setup, "agents-block.md"))?.trim();
  if (block && !read(join(root, "AGENTS.md"))?.includes(block)) w.push("AGENTS.md: the agentic-setup block differs from .agentic-setup/agents-block.md: re-run sync");

  const scripts = JSON.parse(read(join(root, "package.json")) ?? "{}").scripts ?? {};
  for (const [name, file] of [["check", "check.ts"], ["verify", "verify.ts"]])
    if (!String(scripts[name] ?? "").includes(`.agentic-setup/${file}`)) w.push(`package.json: "${name}" doesn't run .agentic-setup/${file}`);
  if (existsSync(join(root, "dev.config.ts")) && !String(scripts.dev ?? "").includes(".agentic-setup/dev.ts"))
    w.push(`package.json: "dev" doesn't run .agentic-setup/dev.ts, though there's a dev.config.ts: re-run sync`);

  const launch = read(join(root, ".claude/launch.json"));
  if (launch && !/"autoVerify"\s*:\s*false/.test(launch)) w.push(`.claude/launch.json: set "autoVerify": false`);
  for (const d of [".claude/skills/verify", ".agents/skills/verify"])
    if (existsSync(join(root, d))) w.push(`${d}: a project skill named "verify" shadows bun run verify`);

  // check's secret scan: Betterleaks 1.10.0 on this Mac, else a narrower regex (CI has neither need nor binary).
  const leaks = process.env.CI ? "1.10.0" : spawnSync("sh", ["-c", "betterleaks version 2>/dev/null"], { encoding: "utf8" }).stdout.trim();
  if (leaks !== "1.10.0") w.push(leaks ? `betterleaks ${leaks} is installed; the setup is tested with 1.10.0` : "betterleaks isn't installed, so check's secret scan falls back to a regex: brew install betterleaks");

  // The last Chrome launch check failed (playwright.ts writes it, a passing launch clears it).
  const broken = process.env.CI ? undefined : read(join(homedir(), "Library/Caches/uninspired/browser-broken"))?.trim();
  if (broken) w.push(`browser lane, last Chrome check ${broken}`);

  const tracked = git(root, "ls-files", "*playwright.config.*", "*oxlintrc*.json", "*oxlint.config.ts", "*oxlint.repo.json").split("\n").filter(Boolean);
  for (const f of tracked.filter((f) => f.includes("playwright.config")))
    // A config that only re-exports another one is checked through that one.
    if (!/e2eConfig\(|export \{ default \} from/.test(read(join(root, f)) ?? "")) w.push(`${f}: doesn't use e2eConfig() from .agentic-setup/playwright.ts`);

  const lintRoot = ["oxlint.config.ts", ".oxlintrc.json"].find((f) => existsSync(join(root, f)));
  if (lintRoot && !read(join(root, lintRoot))!.includes(".agentic-setup/oxlint/base.json")) w.push(`${lintRoot}: doesn't extend .agentic-setup/oxlint/base.json`);
  // A shared rule switched off or to warn needs an EXEMPT reason that names it in the same file.
  const shared = Object.keys(JSON.parse(read(join(setup, "oxlint/base.json")) ?? "{}").rules ?? {});
  for (const f of tracked.filter((f) => /oxlint/.test(f) && !f.includes("baseline"))) {
    const text = read(join(root, f)) ?? "";
    for (const rule of shared) {
      const re = new RegExp(`["']${rule.replace(/[/.]/g, "\\$&")}["']\\s*:\\s*\\[?\\s*["'](off|warn)["']`);
      if (re.test(text) && !new RegExp(`EXEMPT[^\\n]*${rule.replace(/[/.]/g, "\\$&")}`).test(text))
        w.push(`${f}: shared rule ${rule} is off or warn without an EXEMPT reason`);
    }
  }

  // Subframe-generated files changed by hand and not yet committed.
  // shortcut: committed hand edits aren't traced to their commit; add a git log check if they slip through.
  for (const sync of git(root, "ls-files", "*.subframe/sync.json").split("\n").filter(Boolean)) {
    const dir = join(dirname(dirname(sync)), JSON.parse(read(join(root, sync))!).directory ?? ".");
    const changed = git(root, "status", "--porcelain", "--", dir).split("\n").filter(Boolean).map((l) => l.slice(3));
    for (const f of changed.filter((f) => /\/[A-Z][^/]*\.tsx$/.test(f) && !read(join(root, f))?.includes("@subframe/sync-disable")))
      w.push(`${f}: Subframe-generated file edited by hand: change it in Subframe and re-sync, or edit its index.tsx wrapper`);
  }
  return w;
}

if (import.meta.main) {
  const root = git(process.cwd(), "rev-parse", "--show-toplevel") || process.cwd();
  const w = health(root);
  for (const l of w) console.log(`health: ${l}`);
  if (!w.length) console.log("health: ok");
}
