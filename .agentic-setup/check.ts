// bun .agentic-setup/check.ts : the fast, change-scoped check. Health first (warn-only), then the
// scope from the "Changed" rule, then the repo's `check` steps from checks.config.ts in order,
// continuing past failures. One summary line on a pass; one line per problem on a failure.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { caps } from "./caps.ts";

/** A step is a shell command, or a named one so problem lines start with a short label. `heavy`
 *  marks a browser or GPU step of verify: it is skipped once an earlier step is red, since that
 *  verify is red anyway and the fixed tree runs everything again. */
export type Step = string | { name: string; run: string; heavy?: boolean };
export const stepCmd = (s: Step) => (typeof s === "string" ? s : s.run);
export const stepName = (s: Step) => (typeof s === "string" ? s.split(" ").slice(0, 3).join(" ") : s.name);

export type ChecksConfig = {
  base: string;
  /** A list inside the list is a group of steps that don't read each other's output: they run at once. */
  check: (Step | Step[])[];
  verify: Step[];
  /** Commands by glob of changed paths. What follows " -- " in a command is a selection of plain words:
   *  commands that differ only in it run once with the union, and the bare command covers them all. */
  lanes?: Record<string, string[]>;
  /** run: the command specs are appended to, or a function that builds it (several configs). */
  e2e?: { run: string | ((specs: string[], grep?: string) => string); smoke: string[] | string; map: Record<string, string[]> };
  /** Where lint-baseline.ts lints: one entry per folder whose oxlint config the repo's lint uses
   *  (override paths match relative to that config, so each keeps its own baseline in .checks/). */
  lint?: { cwd?: string; args?: string[] }[];
};

const RUN_ALL = /(^|\/)(package\.json|bun\.lockb?|tsconfig[^/]*\.json|\.?oxlint[^/]*|oxlint\.config\.ts|vite\.config\.[^/]+|vitest\.config\.[^/]+|playwright\.config\.[^/]+|bunfig\.toml|checks\.config\.ts)$/;
/** What every step may take of this machine (caps.ts): workers and threads per job. */
export const CAPS = caps();

export const git = (root: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
export const repoRoot = () => git(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
export const gitPath = (root: string, name: string) => {
  const p = git(root, "rev-parse", "--git-path", name)!;
  return p.startsWith("/") ? p : join(root, p);
};
export async function loadConfig(root: string): Promise<ChecksConfig> {
  return (await import(join(root, "checks.config.ts"))).default;
}

/** The commit the scope starts from, and the changed files (committed, uncommitted, untracked).
 *  `stamp` names the runner's own mark of its last green run (false: the whole branch). check and
 *  e2e keep separate marks: sharing check's, a commit followed by a green check left
 *  `e2e --changed` with nothing to run. */
export function scope(root: string, base: string, stamp: string | false = "agentic-check") {
  const ancestor = (c: string) => spawnSync("git", ["merge-base", "--is-ancestor", c, "HEAD"], { cwd: root }).status === 0;
  const root0 = git(root, "rev-list", "--max-parents=0", "HEAD")!.split("\n").at(-1)!;
  const mark = stamp ? gitPath(root, stamp) : "";
  const stamped = mark && existsSync(mark) ? readFileSync(mark, "utf8").trim() : "";
  let since: string | undefined;
  if (stamped && ancestor(stamped)) since = stamped;
  else if (git(root, "branch", "--show-current") !== base) since = git(root, "merge-base", "HEAD", base) ?? git(root, "merge-base", "HEAD", `origin/${base}`);
  else if (git(root, "rev-parse", "-q", "--verify", `origin/${base}`)) since = `origin/${base}`;
  else since = git(root, "merge-base", "HEAD", "origin/HEAD");
  since ??= root0;
  const files = [
    // --no-renames: a moved file counts in the folder it left too, not only where it arrived.
    ...(git(root, "diff", "--name-only", "--no-renames", since) ?? "").split("\n"),
    ...(git(root, "ls-files", "--others", "--exclude-standard") ?? "").split("\n"),
  ].filter(Boolean);
  const all = since === root0 || files.some((f) => RUN_ALL.test(f));
  // `from` stays the real starting commit; `since` becomes the root commit when everything runs.
  return { since: all ? root0 : since, from: since, files: [...new Set(files)], all };
}

/** Runs one shell command, output captured. */
// Hard caps, so a hung step ends red instead of waiting forever (lanes include up to 20 min queueing).
export const STEP_MS = { check: 10 * 60_000, verify: 30 * 60_000, lane: 45 * 60_000 };

let inFlight = 0;
// skipLaneWait: the budget stops while heavy queues and starts again when the lane is ours; onLane
// hears both moments (with heavy's line), so a caller can say who it waits for while it waits.
export function sh(cmd: string, cwd: string, env: Record<string, string>, timeoutMs = 0, skipLaneWait = false,
  onLane?: (state: "waiting" | "got", line: string) => void): Promise<{ code: number; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    inFlight++;
    const child = spawn("sh", ["-c", cmd], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      out += d;
      // heavy's own 20-minute limit bounds the wait, so the budget can start with the lane.
      const text = String(d);
      const line = (re: RegExp) => text.split("\n").find((l) => re.test(l)) ?? "";
      if (text.includes("waiting for the browser lane")) {
        if (skipLaneWait) clearTimeout(timer);
        onLane?.("waiting", line(/waiting for the browser lane/));
      }
      if (text.includes("got the browser lane")) {
        if (skipLaneWait) { clearTimeout(timer); arm(); }
        onLane?.("got", line(/got the browser lane/));
      }
    });
    // SIGINT first: Playwright stops its detached webServers only on a graceful exit, which an
    // early SIGKILL skips (run/leftover-servers-audit-invoicing-v1.md). Harder signals follow.
    const send = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch {} };
    const kill = () => {
      send("SIGINT");
      setTimeout(() => send("SIGTERM"), 10_000).unref();
      setTimeout(() => send("SIGKILL"), 15_000).unref();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const arm = () => { if (timeoutMs) timer = setTimeout(() => { timedOut = true; out += `\n(timed out after ${timeoutMs / 1000} s)`; kill(); }, timeoutMs); };
    arm();
    // Ctrl-C or a kill of this runner takes the step's whole process group with it; it stays until
    // the group is gone (every group, when steps run at once), or the harder signals above would
    // never be sent.
    let stopped = false;
    const onSignal = () => { stopped = true; kill(); };
    process.once("SIGINT", onSignal).once("SIGTERM", onSignal);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      process.off("SIGINT", onSignal).off("SIGTERM", onSignal);
      inFlight--;
      if (stopped) {
        if (inFlight === 0) process.exit(130);
        return;
      }
      resolve({ code: timedOut ? 1 : code ?? 1, out, ms: Date.now() - t0 });
    });
  });
}

// Problem lines tools print: oxlint -f agent, tsc, oxfmt, vitest, bun test, knip, sherif and playwright failures.
const PROBLEM = /^(\S+\.\w+[:(]\d+[\d:,)]*.*|FAIL\s+.+|✘.+|×.+|\S+\.\w+: \(fail\) .+|ERROR: Coverage for .+|\S+\s{2,}\S+\.\w+:\d+:\d+|⨯ .+|\d+ issues? found in .+:|(?:AssertionError|Expected|Received|[-+] (?:Expected|Received))[: ].*)$/;
// `bun run --filter` prefixes lines with "<workspace> <script>: ", `--parallel` with "<script> | ".
// Not tsc's project-level "error TS6305: …", which has the same shape.
const PREFIX = /^(?!(?:error|warning) )(?:[\w@./-]+ [\w:./-]+: |[\w@:./-]+\s+\| )/;
// Oxfmt names each unformatted file with its elapsed time, including filenames containing spaces.
const FAILURE = /\b(?:errors?|failed|failure|panic|fatal|timed out)\b|^[✖✘✗×⨯]|^Format issues found\b|^.+\.\w+ \(\d+ms\)$/i;
const WRAPPER_ERROR = /^error: script ".+" exited with code/;
const PASSED = /^(?:\(pass\)|PASS\b|[✓✔])/;
export function problems(step: string, out: string): string[] {
  // Workspaces that ran at once interleave their lines: each one's lines are put back together, so
  // a bun test "(fail)" line finds its own file header and not a neighbour's.
  const byPrefix = new Map<string, string[]>();
  for (const raw of stripVTControlCharacters(out).split("\n")) {
    const line = raw.trim();
    const prefix = PREFIX.exec(line)?.[0] ?? "";
    const group = byPrefix.get(prefix) ?? [];
    if (!group.length) byPrefix.set(prefix, group);
    group.push(line.slice(prefix.length).trim());
  }
  const clean = [...byPrefix.values()].flat().filter((l) => !PASSED.test(l));
  // bun test names the file only in a "path:" header above its "(fail) test name" lines.
  let file = "";
  for (const [i, l] of clean.entries()) {
    if (/^\S+\.\w+:$/.test(l)) file = l;
    else if (l.startsWith("(fail) ") && file) clean[i] = `${file} ${l}`;
  }
  const lines = [...new Set(clean.filter((l) => !WRAPPER_ERROR.test(l) && (PROBLEM.test(l) || FAILURE.test(l))))];
  const ranked = lines.length > 60 ? [...lines.filter((l) => FAILURE.test(l)), ...lines.filter((l) => !FAILURE.test(l))] : lines;
  if (ranked.length) return ranked.slice(0, 60).map((l) => `${step}: ${l}`);
  const tail = clean.filter((l) => l && !WRAPPER_ERROR.test(l)).slice(-15);
  return [`${step}: failed`, ...tail.map((l) => `  ${l}`)];
}

/** Keep timings, explicit skips and the full failed output visible without another runner. */
export function reportStep(kind: "check" | "verify", name: string, result: { code: number; out: string; ms: number }, root: string, id: string) {
  console.log(`${kind}: ${name}: ${result.code ? "red" : "green"} in ${(result.ms / 1000).toFixed(1)} s`);
  for (const line of stripVTControlCharacters(result.out).split("\n").filter((l) => !PASSED.test(l.trim().replace(PREFIX, "").trim()) && /\b(?:skip|skipped|skipping)\b/i.test(l)))
    console.log(`${kind}: ${name}: ${line.trim()}`);
  if (result.code) {
    const log = gitPath(root, `agentic-${kind}-${id}.log`);
    writeFileSync(log, result.out);
    console.log(`${kind}: ${name}: full output in ${log}`);
  }
}

/** Lanes that differ only in the selection after " -- " run once: the bare command covers every
 *  selection, and the selections of one command merge into one run. MIXD's scan groups overlapped:
 *  seven lanes of one verify repeated 137 s of work the full run had already done. */
export function mergeLanes(commands: string[]): string[] {
  const picks = new Map<string, string[] | undefined>(); // by command; undefined once the bare command is in
  for (const cmd of commands) {
    const at = cmd.indexOf(" -- ");
    const head = at < 0 ? cmd : cmd.slice(0, at);
    const words = at < 0 ? undefined : cmd.slice(at + 4).split(/\s+/).filter(Boolean);
    if (!picks.has(head)) picks.set(head, words);
    else if (!words || !picks.get(head)) picks.set(head, undefined);
    else picks.set(head, [...new Set([...picks.get(head)!, ...words])]);
  }
  return [...picks].map(([head, words]) => (words ? `${head} -- ${words.join(" ")}` : head));
}

// What a reviewer should read first. An agent told to get a check green sometimes changes the check
// instead: with tests that contradicted the task, models edited or special-cased their way past them
// in about half the runs (ImpossibleBench, arXiv 2510.20270). verify lists, since `from`: existing
// tests edited or deleted, skips added and EXEMPT reasons added. A note, never a failure: tests do
// need to change. The synced setup and AGENTS.md don't count (a sync brings their own EXEMPT text).
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP = /\b(?:it|test|describe)(?:\.\w+)*\.(?:skip|todo|fixme|fails|skipIf|runIf)\b|\bx(?:it|describe|test)\s*\(/;
export function reviewNotes(root: string, from: string): string[] {
  const own = ["--", ".", ":(exclude).agentic-setup", ":(exclude)AGENTS.md"];
  // With rename detection: a moved test is edited (or untouched), not deleted.
  const status = (git(root, "diff", "--name-status", from, ...own) ?? "").split("\n").filter(Boolean).map((l) => l.split("\t"));
  const edited: string[] = [], deleted: string[] = [];
  for (const [kind, file, to] of status) {
    if (kind === "M" && TEST_FILE.test(file ?? "")) edited.push(file!);
    else if (kind === "D" && TEST_FILE.test(file ?? "")) deleted.push(file!);
    else if (kind?.startsWith("R") && kind !== "R100" && TEST_FILE.test(to ?? "")) edited.push(to!);
  }
  // Counted file by file and never below zero: a deleted file's skips don't cancel a new one. -G keeps
  // the patch to the files whose changed lines can count.
  const patch = spawnSync("git", ["diff", "-U0", "-G", "EXEMPT|skip|todo|fixme|fails|runIf|x(it|describe|test)", from, ...own],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? "";
  let skips = 0, exempt = 0, fileSkips = 0, fileExempt = 0;
  const close = () => { skips += Math.max(0, fileSkips); exempt += Math.max(0, fileExempt); fileSkips = fileExempt = 0; };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { close(); continue; }
    const sign = line.startsWith("+") && !line.startsWith("+++") ? 1 : line.startsWith("-") && !line.startsWith("---") ? -1 : 0;
    if (!sign) continue;
    if (SKIP.test(line)) fileSkips += sign;
    if (/\bEXEMPT\b/.test(line)) fileExempt += sign;
  }
  close();
  // Files git doesn't track yet: verify usually runs before `git add`.
  for (const file of (git(root, "ls-files", "--others", "--exclude-standard", ...own) ?? "").split("\n").filter(Boolean)) {
    const path = join(root, file);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > 1_000_000) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (TEST_FILE.test(file) && SKIP.test(line)) skips++;
      if (/\bEXEMPT\b/.test(line)) exempt++;
    }
  }
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const list = (files: string[]) => `${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`;
  const notes: string[] = [];
  if (edited.length) notes.push(`${count(edited.length, "existing test file", "existing test files")} edited: ${list(edited)}`);
  if (deleted.length) notes.push(`${count(deleted.length, "test file", "test files")} deleted: ${list(deleted)}`);
  if (skips > 0) notes.push(`${count(skips, "skipped or todo test", "skipped or todo tests")} added`);
  if (exempt > 0) notes.push(`${count(exempt, "EXEMPT reason", "EXEMPT reasons")} added`);
  return notes;
}

// Live credentials: Betterleaks (Homebrew, pinned 1.10.0, config in betterleaks.toml) scans the changed
// files and the commits since `from`, so a key committed and then deleted is caught too; where it isn't
// installed (CI, a fresh Mac) a regex of high-confidence key formats stands in. Neither prints the value.
// A deliberate fake (a test fixture) carries EXEMPT on its line.
const SECRET = /sk_live_[0-9A-Za-z]{10,}|rk_live_[0-9A-Za-z]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|xox[baprs]-[0-9A-Za-z-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}/;
const isFile = (p: string) => existsSync(p) && statSync(p).isFile(); // a tracked symlink can point at a folder

function regexSecrets(root: string, files: string[]): string[] {
  const found: string[] = [];
  for (const f of files) {
    const p = join(root, f);
    if (!isFile(p) || statSync(p).size > 1_000_000) continue;
    const text = readFileSync(p, "utf8");
    if (text.includes("\0")) continue;
    text.split("\n").forEach((l, i) => {
      if (SECRET.test(l) && !l.includes("EXEMPT")) found.push(`secrets: ${f}:${i + 1}: looks like a live credential; keep it in an env file`);
    });
  }
  return found;
}

type Leak = { File: string; StartLine: number; RuleID: string; Commit?: string };
function betterleaks(root: string, files: string[], from?: string): string[] | undefined {
  if (spawnSync("sh", ["-c", "command -v betterleaks"]).status !== 0) return undefined;
  const args = ["--no-banner", "--no-color", "--redact", "--log-level", "error", "-f", "json", "-r", "-", "--exit-code", "0",
    "--max-target-megabytes", "1", "--timeout", "60", "-c", join(root, ".agentic-setup/betterleaks.toml")];
  const run = (a: string[]): Leak[] => {
    const r = spawnSync("betterleaks", a, { cwd: root, encoding: "utf8", maxBuffer: 64_000_000 });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout || "[]");
  };
  try {
    const present = files.filter((f) => isFile(join(root, f)));
    const leaks = [...(present.length ? run(["dir", ...args, ...present]) : []), ...(from ? run(["git", ...args, `--log-opts=${from}..HEAD`]) : [])];
    const text = (l: Leak) => (l.Commit ? spawnSync("git", ["show", `${l.Commit}:${l.File}`], { cwd: root, encoding: "utf8" }).stdout
      : isFile(join(root, l.File)) ? readFileSync(join(root, l.File), "utf8") : "");
    const lineOf = (l: Leak) => text(l).split("\n")[l.StartLine - 1] ?? "";
    const out = leaks.filter((l) => !lineOf(l).includes("EXEMPT"))
      .map((l) => `secrets: ${l.File}:${l.StartLine}: ${l.RuleID}${l.Commit ? ` (in commit ${l.Commit.slice(0, 9)})` : ""}; keep it in an env file`);
    return [...new Set(out)];
  } catch {
    return undefined; // unreadable output: the regex stands in
  }
}

export const secrets = (root: string, files: string[], from?: string) => betterleaks(root, files, from) ?? regexSecrets(root, files);

async function main() {
  const root = repoRoot();
  const t0 = Date.now();
  const config = await loadConfig(root);
  const { health } = await import("./health.ts");
  const { ensurePostinstall } = await import("./playwright.ts");
  const installed = ensurePostinstall(root);
  if (installed) console.log(`check: ${installed}`);
  const warnings = health(root);
  // The stamp a green run leaves is the HEAD the scope was taken from, not the HEAD at the end: a
  // commit made while the steps ran is the next check's to cover.
  const head = git(root, "rev-parse", "HEAD");
  const s = scope(root, config.base);
  const filesPath = gitPath(root, "agentic-check-files");
  writeFileSync(filesPath, s.files.join("\n") + (s.files.length ? "\n" : ""));
  const env = { ...CAPS, CHECK_BASE: s.since, CHECK_FILES: filesPath, CHECK_ALL: s.all ? "1" : "" };
  const failed: string[] = secrets(root, s.files, s.from);
  let count = 0;
  for (const entry of config.check) {
    // A group's steps run at once and report in the config's order.
    const group = Array.isArray(entry) ? entry : [entry];
    const results = await Promise.all(group.map((step) => sh(stepCmd(step), root, env, STEP_MS.check)));
    for (const [j, step] of group.entries()) {
      reportStep("check", stepName(step), results[j], root, String(++count));
      if (results[j].code !== 0) failed.push(...problems(stepName(step), results[j].out));
    }
  }
  for (const w of warnings) console.log(`health: ${w}`);
  const what = s.all ? "everything" : `${s.files.length} file${s.files.length === 1 ? "" : "s"} since ${s.since.slice(0, 9)}`;
  // A config or lockfile change widens every check until it is committed and checked green once.
  const widener = s.all ? s.files.find((f) => RUN_ALL.test(f)) : undefined;
  if (widener) console.log(`check: scope: everything, because ${widener} changed since ${s.from.slice(0, 9)}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (failed.length) {
    for (const l of failed) console.log(l);
    console.log(`check: red, ${count} steps in ${secs} s (scope: ${what})`);
    process.exit(1);
  }
  writeFileSync(gitPath(root, "agentic-check"), head + "\n");
  console.log(`check: green, ${count} steps in ${secs} s (scope: ${what})`);
}

if (import.meta.main) await main();
