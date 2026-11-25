// bun .agentic-setup/dev.ts [launcher…] (`bun run dev`): starts the repo's dev servers from its
// dev.config.ts in the foreground, the first launcher unless one is named, each output line prefixed
// with its entry's name. Ctrl+C stops what this runner started and nothing else.
//   --print [--repo <abs>]  the config fully resolved, as JSON (DevConfigJson), for the Untracked Dev
//                           tab: its Rust side never parses TypeScript and spawns on its own
//   --step seed-env [--from f] [--to f] [--generate KEY,…]
//   --step check-dev-vars --keys KEY,…   the built-in setup steps, as --print's setup commands run
//                           them (in the entry's cwd)
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

// ---- dev.config.ts

/** Built-in setup step: copies `from` to `to` (default .env.example → .env, in the entry's cwd)
 *  only when `to` is missing, and gives each `generate` key a fresh random value (64 hex chars) in
 *  the new file. An existing file is never touched. */
export type SeedEnv = { seedEnv: { from?: string; to?: string; generate?: string[] } };
/** Runs before the entry's command on every start, so it must be safe to repeat: a shell command
 *  (in the entry's cwd, with its env), the same with a short name for logs and the Dev tab, or a
 *  built-in. */
export type SetupStep = string | { name: string; run: string } | SeedEnv;

export type Entry = {
  name: string;
  /** Relative to the repo root (default: the root). */
  cwd?: string;
  /** A shell command. A server's must fail when its port is taken (Vite: --strictPort). */
  command: string;
  /** Makes the entry a server, ready once this port listens. Without it the entry is a task: it
   *  ends finished (exit 0) or failed. */
  port?: number;
  /** Given to the process only; .env and .dev.vars are never written. Vite reads it by itself; a
   *  Worker with a `secrets.required` block gets its declared keys from it. The start fails while a
   *  .dev.vars sits next to a wrangler config in its cwd (Wrangler would ignore the process env). */
  env?: Record<string, string>;
  /** Sets CLOUDFLARE_INCLUDE_PROCESS_ENV=true, so process env overrides a Worker's `vars`. Only for a
   *  wrangler-run Worker WITHOUT a `secrets` block that needs that: Wrangler then hands the Worker
   *  the whole inherited environment (session tokens, SSH_AUTH_SOCK, everything in the shell). */
  workerEnv?: boolean;
  setup?: SetupStep[];
  /** How long a server may take to listen (default 120 s). */
  readyTimeoutMs?: number;
  /** SIGTERM to SIGKILL on a stop (default 5 s), for a command that cleans up on SIGTERM. */
  stopTimeoutMs?: number;
};

/** A sibling of the repo's main checkout (`"us-auth"` is ../us-auth), or `"."` for this checkout,
 *  and optionally which of its launchers (default: its first). */
export type Need = string | { repo: string; launcher?: string };

/** One Start button. Entries start in order: each server is ready before the next entry starts. */
export type Launcher = { name: string; needs?: Need[]; entries: Entry[] };

/** dev.config.ts's default export. The first launcher is the default. */
export type DevConfig = { launchers: Launcher[] };

// ---- --print: the stable contract with the Untracked app (bump `version` on a breaking change)

/**
 * How to start launcher L (the runner below does exactly this):
 *  1. Every need in order: an `error` fails the start with it; else start `need.launcher` of
 *     `need.repo` (print that repo's own config) and wait until it is ready. A launcher already
 *     started by this owner just gains a holder; it stops when its last holder lets go.
 *  2. Every entry in order. A server first checks its port: a listener whose cwd is the entry's cwd
 *     (or inside it, same checkout) means it's already running: skip it, it isn't ours to stop. Any
 *     other listener fails the start, naming it (pid, command, cwd).
 *  3. Setup steps, in order: `sh -c <command>` in cwd with env, output into the entry's log. A
 *     non-zero exit fails the start.
 *  4. `sh -c <command>` in cwd with env added over the inherited environment, in its own process
 *     group. Readiness repeats the port's checkout and managed-owner checks; exiting first, or no listener after
 *     readyTimeoutMs, fails the start. The next entry starts when it's ready; a task isn't waited
 *     for, and ends finished (exit 0) or failed.
 *  A failed start stops what it started. Stop: SIGTERM to the process group, SIGKILL after the
 *  entry's stopTimeoutMs.
 */
export type DevConfigJson = {
  version: 1;
  /** Absolute: the checkout the config was read from (a worktree's own folder when run from one). */
  repo: string;
  /** In config order; launchers[0] is the default. */
  launchers: LauncherJson[];
};
export type LauncherJson = { name: string; needs: NeedJson[]; entries: EntryJson[] };
export type NeedJson = {
  /** The sibling's folder name ("us-auth"), or "." for this checkout. */
  name: string;
  /** Absolute checkout path (or where the sibling was looked for, on an error). */
  repo: string;
  /** The launcher to start there; null selects its first launcher after the owner authorizes the repo. */
  launcher: string | null;
  /** A path-resolution error, or null. Config/launcher validation happens when starting the need. */
  error: string | null;
};
export type EntryJson = {
  name: string;
  kind: "server" | "task";
  /** Absolute. */
  cwd: string;
  command: string;
  /** null for a task. */
  port: number | null;
  /** null for a task. */
  readyTimeoutMs: number | null;
  /** SIGTERM to SIGKILL on a stop (default 5000). Added within version 1: a runner synced before
   *  it doesn't print it. */
  stopTimeoutMs: number;
  /** Added over the inherited environment, for the setup steps and the command: exactly the entry's
   *  `env` as declared ({} without one), plus CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" only when the
   *  entry opts in with `workerEnv: true`. */
  env: Record<string, string>;
  /** Shell commands in order; built-ins are already turned into a call of `bun` with this runner.
   *  An entry with env (or workerEnv) ends with the "check .dev.vars" step. */
  setup: { name: string; command: string }[];
};

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The main checkout, also from a worktree: siblings sit next to it, not next to the worktree. */
export function mainCheckout(repo: string): string {
  const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return real(common ? (basename(common) === ".git" ? dirname(common) : common) : repo);
}

async function readConfig(repo: string): Promise<DevConfig> {
  const file = join(repo, "dev.config.ts");
  if (!existsSync(file)) throw new Error(`no dev.config.ts in ${repo}`);
  const config: DevConfig = (await import(file)).default;
  const bad = (why: string) => { throw new Error(`${file}: ${why}`); };
  if (!config?.launchers?.length) bad("no launchers");
  const seen = new Set<string>();
  for (const l of config.launchers) {
    if (!l.name || seen.has(l.name)) bad(`launcher names must be set and unique ("${l.name}")`);
    seen.add(l.name);
    if (!Array.isArray(l.entries) || (!l.entries.length && !l.needs?.length)) bad(`launcher "${l.name}" has no entries or needs`);
    const names = new Set<string>();
    for (const e of l.entries) {
      if (!e.name || names.has(e.name)) bad(`entry names in "${l.name}" must be set and unique ("${e.name}")`);
      names.add(e.name);
      if (typeof e.command !== "string" || !e.command) bad(`entry "${e.name}" has no command`);
      if (e.port !== undefined && !(Number.isInteger(e.port) && e.port > 0 && e.port < 65536)) bad(`entry "${e.name}" has port ${e.port}`);
      for (const ms of ["readyTimeoutMs", "stopTimeoutMs"] as const)
        if (e[ms] !== undefined && !(Number.isInteger(e[ms]) && e[ms]! > 0)) bad(`entry "${e.name}" has ${ms} ${e[ms]}`);
      for (const k of Object.keys(e.env ?? {})) if (!ENV_KEY.test(k)) bad(`entry "${e.name}" has env key "${k}"`);
      if (e.env && "CLOUDFLARE_INCLUDE_PROCESS_ENV" in e.env) bad(`entry "${e.name}": use workerEnv: true, not CLOUDFLARE_INCLUDE_PROCESS_ENV in env`);
      if (e.workerEnv !== undefined && typeof e.workerEnv !== "boolean") bad(`entry "${e.name}" has workerEnv ${e.workerEnv}`);
      for (const s of e.setup ?? []) {
        if (typeof s === "string") continue;
        if ("seedEnv" in s) {
          for (const k of s.seedEnv.generate ?? []) if (!ENV_KEY.test(k)) bad(`entry "${e.name}": seedEnv can't generate "${k}"`);
        } else if (!s.name || typeof s.run !== "string" || !s.run) bad(`entry "${e.name}": a named setup step needs name and run`);
      }
    }
  }
  return config;
}

// A built-in step calls this same file, so the app's copy of the runner and the repo's agree on what
// it does. `bun` from PATH, not process.execPath: that's a versioned Homebrew Cellar path, gone after
// `brew upgrade bun` while the app still caches the printed JSON.
const builtin = (...args: string[]) => ["bun", import.meta.path, "--step", ...args].map(quote).join(" ");

function stepJson(step: SetupStep): { name: string; command: string } {
  if (typeof step === "string") return { name: step, command: step };
  if (!("seedEnv" in step)) return { name: step.name, command: step.run };
  const { from = ".env.example", to = ".env", generate = [] } = step.seedEnv;
  const args = ["seed-env", "--from", from, "--to", to, ...(generate.length ? ["--generate", generate.join(",")] : [])];
  return { name: `seed-env ${to}`, command: builtin(...args) };
}

function entryJson(repo: string, e: Entry): EntryJson {
  const server = e.port !== undefined;
  const keys = Object.keys(e.env ?? {});
  const setup = (e.setup ?? []).map(stepJson);
  // Last, so a .dev.vars an earlier step seeded is caught too.
  if (keys.length || e.workerEnv) setup.push({ name: "check .dev.vars", command: builtin("check-dev-vars", "--keys", keys.join(",")) });
  return {
    name: e.name, kind: server ? "server" : "task", cwd: resolve(repo, e.cwd ?? "."), command: e.command,
    port: e.port ?? null, readyTimeoutMs: server ? (e.readyTimeoutMs ?? 120_000) : null, stopTimeoutMs: e.stopTimeoutMs ?? 5000,
    // The flag only on request: without a `secrets` block it hands the whole inherited environment to
    // the Worker (us-auth's Vite-plugin SSR Workers got 93 keys, agent tokens included, for VITE_* env
    // that Vite reads without it).
    env: { ...e.env, ...(e.workerEnv ? { CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" } : {}) },
    setup,
  };
}

function needJson(parent: string, current: string, need: Need): NeedJson {
  const { repo: name, launcher } = typeof need === "string" ? { repo: need, launcher: undefined } : need;
  const repo = real(name === "." ? current : join(parent, name));
  // Printing a trusted parent must not evaluate a dependency before its owner has authorized that repo.
  return { name, repo, launcher: launcher ?? null, error: existsSync(repo) ? null : `needs ${name}, but ${repo} doesn't exist` };
}

/** The repo's dev.config.ts, resolved: what --print prints. */
export async function printConfig(repoPath: string): Promise<DevConfigJson> {
  const repo = real(repoPath);
  const config = await readConfig(repo);
  const parent = dirname(mainCheckout(repo));
  const launchers = config.launchers.map((l) => ({
    name: l.name,
    needs: (l.needs ?? []).map((n) => needJson(parent, repo, n)),
    entries: l.entries.map((e) => entryJson(repo, e)),
  }));
  return { version: 1, repo, launchers };
}

// ---- ports

export type Holder = { pid: number; command: string; cwd: string };
const out = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" }).stdout ?? "";
const listeners = (port: number) => [...new Set(out("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split("\n").filter(Boolean).map(Number))];

export function holders(port: number): Holder[] {
  return listeners(port).map((pid) => ({
    pid,
    command: out("ps", ["-o", "command=", "-p", String(pid)]).trim(),
    cwd: /^n(.+)$/m.exec(out("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]))?.[1] ?? "",
  }));
}
export const describeHolders = (hs: Holder[]) => hs.map((h) => `pid ${h.pid} (${h.command || "?"}) in ${h.cwd || "?"}`).join("; ");

/** own: this server already runs (a listener in its cwd, or below it in the same checkout, so a
 *  worktree nested in the repo isn't taken for it); foreign: something else holds the port. */
export function portCheck(port: number, cwd: string): { state: "free" } | { state: "own" | "foreign"; holders: Holder[] } {
  const hs = holders(port);
  if (!hs.length) return { state: "free" };
  const dir = real(cwd);
  const top = git(dir, "rev-parse", "--show-toplevel");
  const own = hs.some(({ cwd: c }) => {
    const r = c && real(c);
    return r && (r === dir || r.startsWith(dir + sep)) && git(r, "rev-parse", "--show-toplevel") === top;
  });
  return { state: own ? "own" : "foreign", holders: hs };
}

// ---- seed-env

export function seedEnv(cwd: string, from = ".env.example", to = ".env", generate: string[] = []): string {
  const dest = resolve(cwd, to);
  if (existsSync(dest)) return `${to} exists, left as is`;
  const src = resolve(cwd, from);
  if (!existsSync(src)) throw new Error(`${from} is missing, so ${to} can't be seeded`);
  let text = readFileSync(src, "utf8");
  for (const key of generate) {
    const line = `${key}=${randomBytes(32).toString("hex")}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  writeFileSync(dest, text, { flag: "wx", mode: 0o600 }); // wx: never over a file that appeared meanwhile
  return `seeded ${to} from ${from}${generate.length ? `, generated ${generate.join(", ")}` : ""}`;
}

/** check-dev-vars: Wrangler ignores the process env entirely while a .dev.vars exists, so an entry's
 *  env would silently not reach the Worker. A failed start says so; folders without a wrangler
 *  config (Vite alone, a script) pass. */
export function checkDevVars(cwd: string, keys: string[]): string | undefined {
  const wrangler = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"].find((f) => existsSync(join(cwd, f)));
  if (!wrangler || !existsSync(join(cwd, ".dev.vars"))) return undefined;
  return `${join(cwd, ".dev.vars")} exists, so wrangler ignores the process env and ` +
    `${keys.length ? `this entry's env (${keys.join(", ")})` : "workerEnv's process env"} wouldn't reach the Worker: delete or rename .dev.vars (wrangler reads .env when it's ` +
    `gone), or drop env from this entry in dev.config.ts`;
}

// ---- the runner

export type ProcState = "starting" | "running" | "already running" | "finished" | "failed" | "stopped";
/** label: how its log lines are prefixed; where: how errors name it ("alpha · web / server"). */
export type Proc = { launch: string; label: string; where: string; entry: EntryJson; state: ProcState; child?: ChildProcess; code?: number; stopping?: boolean };
export type Started = { key: string; repo: string; launcher: string; procs: Proc[]; needs: string[]; holders: Set<string>; ready: Promise<void> };
type Options = {
  log: (label: string, line: string) => void;
  /** Labels for this repo's entries are bare names; a dependency's carry its folder ("us-auth/api"). */
  home?: string;
  /** Added to every spawn's env (the terminal adds FORCE_COLOR). */
  env?: Record<string, string>;
  /** A running server exited by itself (not stopped). */
  onExit?: (started: Started, proc: Proc) => void;
};

const signalGroup = (pid: number, signal: NodeJS.Signals | 0) => { try { process.kill(-pid, signal); return true; } catch { return false; } };

/** In every spawn's environment: which runner started it. Once a child's own exit was seen, its group number may
 *  be anyone's by now; only a process there carrying this proves the group still holds what the child started. */
const RUNNER = "AGENTIC_SETUP_DEV_RUNNER";
const SPAWN = "AGENTIC_SETUP_DEV_SPAWN";
type OwnedSpawn = { child: ChildProcess; proc: Proc; token: string; exited: boolean };
/** Whether process group `pgid` still holds a process this runner started (Apple's own binaries hide their
 *  environment, so a group of only those can't be proven ours). */
export function groupIsOurs(pgid: number, token?: string): boolean {
  const members = out("ps", ["-axo", "pid=,pgid="]).split("\n").map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, g]) => g === pgid && pid).map(([pid]) => String(pid));
  if (!members.length) return false;
  const env = out("ps", ["-Eww", "-o", "command=", "-p", members.join(",")]);
  return env.split("\n").some((line) => {
    const words = line.split(/\s+/);
    return words.includes(`${RUNNER}=${process.pid}`) && (token === undefined || words.includes(`${SPAWN}=${token}`));
  });
}

/** Starts launchers with their needs; a launcher held by several (the user, other launchers) stops
 *  only when the last holder lets go. The counts live in this object only. */
export class Runner {
  started = new Map<string, Started>();
  /** Every process this runner spawned that may still have a group, for a kill that can't wait. A child whose exit
   *  was seen leaves it once its group is empty, and is signalled only while groupIsOurs says so. */
  private spawned: OwnedSpawn[] = [];
  private configs = new Map<string, Promise<DevConfigJson>>();
  private closing = false;
  constructor(private opts: Options) {}

  private config(repo: string) {
    const key = real(repo);
    if (!this.configs.has(key)) this.configs.set(key, printConfig(key));
    return this.configs.get(key)!;
  }

  async start(repo: string, launcher?: string, holder = "you", chain: string[] = []): Promise<Started> {
    if (this.closing) throw new Error("stopped");
    const config = await this.config(repo);
    if (this.closing) throw new Error("stopped");
    const l = launcher === undefined ? config.launchers[0]! : config.launchers.find((x) => x.name === launcher);
    if (!l) throw new Error(`${config.repo} has no launcher "${launcher}" (it has ${config.launchers.map((x) => x.name).join(", ")})`);
    const key = `${config.repo}#${l.name}`;
    if (chain.includes(key)) throw new Error(`needs go in a circle: ${[...chain, key].join(" → ")}`);
    const have = this.started.get(key);
    if (have) {
      have.holders.add(holder);
      await have.ready;
      return have;
    }
    const s: Started = { key, repo: config.repo, launcher: l.name, procs: [], needs: [], holders: new Set([holder]), ready: Promise.resolve() };
    this.started.set(key, s);
    s.ready = (async () => {
      try {
        for (const n of l.needs) {
          if (n.error) throw new Error(n.error);
          s.needs.push((await this.start(n.repo, n.launcher ?? undefined, key, [...chain, key])).key);
        }
        for (const e of l.entries) await this.entry(s, e);
      } catch (err) {
        this.started.delete(key);
        await this.halt(s);
        throw err;
      }
    })();
    await s.ready;
    return s;
  }

  /** Lets go of a launcher for one holder; the last one out stops it, then lets go of its needs. */
  async stop(key: string, holder = "you") {
    const s = this.started.get(key);
    if (!s || !s.holders.delete(holder) || s.holders.size) return;
    this.started.delete(key);
    await this.halt(s);
  }

  /** Everything this runner started, whoever holds it. */
  async stopAll() {
    this.closing = true;
    this.started.clear();
    await Promise.all([...this.spawned].map((owned) => this.kill(owned)));
  }

  /** SIGKILL to every group at once (a second Ctrl+C), each one provably still ours. */
  killNow() {
    for (const owned of [...this.spawned]) if (this.ours(owned)) signalGroup(owned.child.pid!, "SIGKILL");
  }

  /** The groups this runner would still signal (for tests). */
  get live(): number[] {
    return [...this.spawned].filter((owned) => this.ours(owned)).map((owned) => owned.child.pid!);
  }

  /** A child's group is ours while the child itself hasn't exited (its pid can't be reused), or, after, while the
   *  group still holds a process carrying this runner's marker. A group seen empty is dropped for good. */
  private ours(owned: OwnedSpawn): boolean {
    const c = owned.child;
    if (!this.spawned.includes(owned)) return false;
    if (!c.pid || !signalGroup(c.pid, 0)) return this.drop(owned), false;
    if (!owned.exited && c.exitCode === null && c.signalCode === null) return true;
    if (groupIsOurs(c.pid, owned.token)) return true;
    this.drop(owned);
    return false;
  }

  private drop(owned: OwnedSpawn) {
    this.spawned = this.spawned.filter((x) => x !== owned);
  }

  private async halt(s: Started) {
    await Promise.all(this.spawned.filter((owned) => s.procs.includes(owned.proc)).map((owned) => this.kill(owned)));
    for (const n of s.needs.reverse()) await this.stop(n, s.key);
  }

  private async entry(s: Started, e: EntryJson) {
    const label = this.opts.home && real(this.opts.home) === s.repo ? e.name : `${basename(s.repo)}/${e.name}`;
    // two launchers may share an entry name: errors name the launcher too
    const where = `${basename(s.repo)} · ${s.launcher} / ${e.name}`;
    const p: Proc = { launch: s.key, label, where, entry: e, state: "starting" };
    s.procs.push(p);
    const log = (line: string) => this.opts.log(label, line);
    const checkPort = (port: number) => {
      const check = portCheck(port, e.cwd);
      if (check.state === "own") {
        const groups = new Set(out("ps", ["-o", "pgid=", "-p", check.holders.map((h) => h.pid).join(",")]).trim().split(/\s+/).map(Number));
        const managed = this.spawned.find((owned) => owned.proc.launch !== s.key && groups.has(owned.child.pid!) && this.ours(owned));
        if (managed && !s.needs.includes(managed.proc.launch)) throw new Error(`${where}: port ${port} belongs to managed launcher ${managed.proc.launch}; declare it in needs instead of borrowing it`);
      }
      if (check.state === "foreign") throw new Error(`${where}: port ${port} is held by ${describeHolders(check.holders)}`);
      return check;
    };
    if (e.port !== null) {
      const check = checkPort(e.port);
      if (check.state === "own") {
        p.state = "already running";
        return log(`already running on ${e.port} (${describeHolders(check.holders)}), not started`);
      }
    }
    for (const step of e.setup) {
      log(`$ ${step.name}`);
      const code = await this.exit(this.spawn(p, step.command));
      if (this.closing) throw new Error("stopped");
      if (code !== 0) throw new Error(`${where}: setup step "${step.name}" failed (exit ${code})`);
    }
    const child = this.spawn(p, e.command);
    if (e.port === null) p.state = "running"; // a server runs once it's ready
    const exited = this.exit(child).then((code) => {
      const was = p.state;
      p.code = code;
      if (p.stopping) p.state = "stopped";
      else if (e.port === null) { p.state = code === 0 ? "finished" : "failed"; log(code === 0 ? "finished ✓" : `failed (exit ${code})`); }
      else {
        p.state = "failed";
        log(`exited (code ${code})`);
        if (was === "running" && this.started.get(s.key) === s) this.opts.onExit?.(s, p);
      }
      return code;
    });
    if (e.port === null) return;
    let gone = false;
    void exited.then(() => (gone = true));
    for (const end = Date.now() + e.readyTimeoutMs!;;) {
      if (this.closing) throw new Error("stopped");
      if (gone) throw new Error(`${where}: exited (code ${p.code}) before port ${e.port} listened`);
      if (checkPort(e.port).state === "own") break;
      if (Date.now() > end) throw new Error(`${where}: port ${e.port} didn't listen within ${e.readyTimeoutMs! / 1000} s`);
      await Bun.sleep(200);
    }
    p.state = "running";
    log(`ready on http://localhost:${e.port}`);
  }

  private spawn(p: Proc, command: string): ChildProcess {
    if (this.closing) throw new Error("stopped");
    // detached: its own process group, so a stop reaches what it spawned (wrangler → workerd) and a
    // terminal's Ctrl+C reaches only this runner, which then stops what it started.
    const token = randomBytes(16).toString("hex");
    const env = { ...process.env, ...this.opts.env, ...p.entry.env, [RUNNER]: String(process.pid), [SPAWN]: token };
    const child = spawn("sh", ["-c", command], { cwd: p.entry.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const owned: OwnedSpawn = { child, proc: p, token, exited: false };
    // its exit is seen: from now on its number is only ours while the group provably holds what it started
    child.on("exit", () => {
      owned.exited = true;
      if (!child.pid || !signalGroup(child.pid, 0)) this.drop(owned);
    });
    for (const stream of [child.stdout!, child.stderr!]) {
      let buf = "";
      stream.on("data", (d) => {
        const lines = (buf + d).split("\n");
        buf = lines.pop()!;
        for (const l of lines) this.opts.log(p.label, l.replace(/\r$/, ""));
      });
      stream.on("end", () => buf && this.opts.log(p.label, buf));
    }
    p.child = child;
    this.spawned.push(owned);
    return child;
  }

  private exit(child: ChildProcess) {
    return new Promise<number>((done) => {
      child.on("error", () => done(127));
      child.on("exit", (code, signal) => done(code ?? (signal ? 128 : 1)));
    });
  }

  /** SIGTERM to the process group, SIGKILL after the grace; done when the whole group is gone. Only a group that's
   *  provably still ours: a finished task's old number may belong to someone else by now. */
  private async kill(owned: OwnedSpawn) {
    const { child: c, proc: p } = owned;
    const pid = c.pid;
    if (!pid || !this.spawned.includes(owned)) return;
    if (!this.ours(owned)) {
      if (signalGroup(pid, 0)) this.opts.log(p.label, `process group ${pid} still has processes that can't be told to be this runner's: left alone`);
      return;
    }
    p.stopping = true;
    signalGroup(pid, "SIGTERM");
    const ms = p.entry.stopTimeoutMs;
    for (const end = Date.now() + ms; signalGroup(pid, 0) && Date.now() < end;) await Bun.sleep(100);
    // checked again: the group may have emptied (and its number been taken) during the grace
    if (this.ours(owned)) {
      this.opts.log(p.label, `still running after ${ms / 1000} s, killing`);
      signalGroup(pid, "SIGKILL");
    }
  }
}

// ---- the command line

/** The handler for an uncaught exception or unhandled rejection in the runner itself: its children are detached
 *  and would outlive it, so it stops what it started (or, already stopping, kills it), then exits 1. `stopping`
 *  marks the runner as stopping and says whether it already was. */
export function onCrash(runner: Runner, stopping: () => boolean, exit: (code: number) => void = process.exit) {
  return (err: unknown) => {
    console.error(`dev: ${(err as Error)?.stack ?? err}`);
    if (stopping()) {
      runner.killNow();
      return exit(1);
    }
    console.error("dev: stopping what this runner started");
    void runner.stopAll().finally(() => exit(1));
  };
}

function arg(argv: string[], name: string) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = argv.splice(i, 2);
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

async function main(argv: string[]) {
  if (argv[0] === "--step") {
    const rest = argv.slice(2);
    if (argv[1] === "check-dev-vars") {
      const problem = checkDevVars(process.cwd(), arg(rest, "--keys")?.split(",").filter(Boolean) ?? []);
      if (problem) throw new Error(problem);
      return;
    }
    if (argv[1] !== "seed-env") throw new Error(`unknown step "${argv[1]}"`);
    const from = arg(rest, "--from"), to = arg(rest, "--to"), generate = arg(rest, "--generate");
    return console.log(seedEnv(process.cwd(), from, to, generate?.split(",").filter(Boolean)));
  }
  const at = argv.indexOf("--print");
  if (at >= 0) argv.splice(at, 1);
  const repoArg = arg(argv, "--repo");
  const repo = repoArg ? resolve(repoArg) : (git(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd());
  const config = await printConfig(repo);
  if (at >= 0) return console.log(JSON.stringify(config, null, 2));

  const names = config.launchers.map((l) => l.name);
  const unknown = argv.filter((a) => !names.includes(a));
  if (unknown.length) {
    console.error(`dev: no launcher ${unknown.map((u) => `"${u}"`).join(", ")}; this repo has: ${names.join(", ")}`);
    process.exit(2);
  }
  const tty = !!process.stdout.isTTY;
  const colors = new Map<string, number>();
  let width = 8;
  const log = (label: string, line: string) => {
    if (!colors.has(label)) colors.set(label, [36, 35, 33, 32, 34, 31][colors.size % 6]!);
    width = Math.max(width, label.length);
    const tag = label.padEnd(width);
    console.log(`${tty ? `\x1b[${colors.get(label)}m${tag}\x1b[0m` : tag} │ ${line}`);
  };
  let done = false;
  const runner: Runner = new Runner({
    log, home: repo, env: tty ? { FORCE_COLOR: "1", CARGO_TERM_COLOR: "always" } : {},
    // A server of the launcher you started ended by itself (a crash, or `tauri dev`'s window closed):
    // stop the rest rather than leave half a stack running. A dependency's exit is only reported.
    onExit: (s, p) => {
      if (done || !s.holders.has("you")) return;
      done = true;
      console.log(`dev: ${p.label} exited, stopping the rest`);
      void runner.stopAll().then(() => process.exit(p.code ?? 1));
    },
  });
  const crash = onCrash(runner, () => {
    const was = done;
    done = true;
    return was;
  });
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => {
    if (done) {
      runner.killNow(); // a second Ctrl+C doesn't wait for the grace
      process.exit(130);
    }
    done = true;
    console.log("\ndev: stopping what this runner started (Ctrl+C again to kill)");
    void runner.stopAll().then(() => process.exit(130));
  });
  try {
    for (const name of argv.length ? argv : [names[0]!]) await runner.start(repo, name);
  } catch (err) {
    if (done) return;
    done = true;
    console.error(`dev: ${(err as Error).message}`);
    await runner.stopAll();
    process.exit(1);
  }
  const ours = [...runner.started.values()].flatMap((s) => s.procs).filter((p) => p.state === "running").length;
  console.log(ours ? `dev: started ${ours}; Ctrl+C stops what this runner started` : "dev: nothing left running here");
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`dev: ${(err as Error).message}`);
    process.exit(1);
  });
}
