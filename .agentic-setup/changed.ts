// Check steps that see only the change (CHECK_FILES, from check.ts); with CHECK_ALL set (a config or
// lockfile change) they cover the whole repo.
//   bun .agentic-setup/changed.ts lint [oxlint args…] : oxlint on the changed JS/TS files
//   bun .agentic-setup/changed.ts format [--include glob]… [oxfmt args…] : existing changed files,
//     passed as literal arguments; includes restrict the repository's normal formatting scope
//   bun .agentic-setup/changed.ts workspaces <script> : <script> in the workspaces the change touches,
//                                                     plus every workspace that depends on them
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { workspacesAtOnce } from "./caps.ts";

const root = process.cwd();
const all = !!process.env.CHECK_ALL || !process.env.CHECK_FILES;
// Deleted files count for workspaces (their dependents still need checking), not for lint.
const files = all ? [] : readFileSync(process.env.CHECK_FILES!, "utf8").split("\n").filter(Boolean);
const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  process.exit(spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1);

type Workspace = { dir: string; name: string; deps: string[] };

export function workspaces(at: string): Workspace[] {
  const globs: string[] = JSON.parse(readFileSync(join(at, "package.json"), "utf8")).workspaces ?? [];
  return globs.flatMap((g) => [...new Bun.Glob(`${g}/package.json`).scanSync({ cwd: at, onlyFiles: true })]).map((p) => {
    const pkg = JSON.parse(readFileSync(join(at, p), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    return { dir: p.slice(0, -"/package.json".length), name: pkg.name, deps: Object.keys(deps).filter((d) => String(deps[d]).startsWith("workspace:")) };
  });
}

/** The workspaces holding `changed`, plus their dependents; undefined when a file sits in none. */
export function affected(list: Workspace[], changed: string[]): Set<string> | undefined {
  const hit = new Set<string>();
  for (const f of changed) {
    const w = list.find((x) => f.startsWith(`${x.dir}/`));
    if (!w) return undefined;
    hit.add(w.name);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const w of list) if (!hit.has(w.name) && w.deps.some((d) => hit.has(d))) hit.add(w.name), (grew = true);
  }
  return hit;
}

export function formatArguments(at: string, changed: string[], args: string[]): string[] {
  const includes: Bun.Glob[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--include") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--include needs a glob");
      includes.push(new Bun.Glob(args[++i]));
    } else flags.push(args[i]);
  }
  const present = changed.filter((f) => existsSync(join(at, f)) && statSync(join(at, f)).isFile()
    && (!includes.length || includes.some((g) => g.match(f))));
  return present.length ? [...flags, ...present.map((f) => `./${f}`)] : [];
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "lint") {
    const lintable = files.filter((f) => /\.(m|c)?[jt]sx?$/.test(f) && existsSync(join(root, f)));
    if (!all && !lintable.length) process.exit(0);
    run(join(root, "node_modules/.bin/oxlint"), [...rest, "--no-error-on-unmatched-pattern", ...(all ? [] : lintable)]);
  } else if (mode === "format") {
    // Unlike workspace/lint selection, a CHECK_ALL change still formats the actual changed files,
    // as the old CHECK_FILES shell fragments did. A direct call without CHECK_FILES checks all files.
    let changed: string[];
    if (process.env.CHECK_FILES) changed = readFileSync(process.env.CHECK_FILES, "utf8").split("\n").filter(Boolean);
    else {
      const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
      if (listed.status !== 0) throw new Error(`cannot list files for formatting: ${listed.stderr}`);
      changed = listed.stdout.split("\0").filter(Boolean);
    }
    const args = formatArguments(root, changed, rest);
    if (!args.length) { console.log("format: skipped (no existing files in formatting scope)"); process.exit(0); }
    console.log(`format: checking ${args.filter((a) => a.startsWith("./")).length} file(s)`);
    run(join(root, "node_modules/.bin/oxfmt"), args);
  } else if (mode === "workspaces" && rest[0]) {
    const list = workspaces(root);
    const hit = all ? undefined : affected(list, files.filter((f) => !/\.md$/.test(f)));
    if (hit && !hit.size) process.exit(0);
    const names = hit ? list.filter((w) => hit.has(w.name)) : list;
    // One workspace at a time on a small machine: in parallel a shared-package change ran ten tsc at
    // once (us-auth, packages/types: 7.3 s and 2.4 GB in all, against 11.8 s and 1.2 GB one at a time).
    // Where the memory is there (caps.ts) they run at once, and every workspace reports, not only
    // the first that fails. At once, each gets two compiler threads: the workspaces are the
    // parallelism, and a job's cap times a dozen workspaces would take the whole machine.
    const atOnce = workspacesAtOnce();
    run("bun", ["run", ...names.flatMap((w) => ["--filter", w.name]), ...(atOnce ? [] : ["--sequential"]), "--if-present", rest[0]], atOnce ? { GOMAXPROCS: "2" } : {});
  } else {
    console.error("usage: changed.ts lint [oxlint args…] | format [--include glob]… [oxfmt args…] | workspaces <script>");
    process.exit(2);
  }
}

