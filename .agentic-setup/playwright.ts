// Shared Playwright base (research 07 §1, 2, 5, 6). A repo's config:
//   export default defineConfig(e2eConfig({ server: (port) => `vite --port ${port} --strictPort` }, { projects }))
// It imports nothing from Playwright, because some repos install it only in one workspace.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library/Caches/uninspired");
// 3900–3909 belong to the lane holder only (tests move the band so they never touch a live run).
export const BAND = Number(process.env.UNINSPIRED_BAND ?? 3900);

/**
 * True only in the Playwright runner that is about to run tests: `playwright test` without --list or
 * --ui. Anything else that loads the config (knip's Playwright plugin, an editor, a worker) gets
 * false, so it never takes the lane, clears the band or launches Chrome.
 */
export function runsTests(argv = process.argv): boolean {
  if (process.env.TEST_WORKER_INDEX !== undefined) return false;
  if (!/(^|[/\\])(playwright|@playwright[/\\]test[/\\]cli\.js|playwright[/\\]cli\.js)$/.test(argv[1] ?? "") || argv[2] !== "test") return false;
  return !argv.some((a) => a === "--list" || a === "--ui");
}

/**
 * Takes the machine-wide browser lane for as long as this Playwright runner lives (the same lock as
 * scripts/heavy), then kills leftover listeners on the band: only the lane holder may use it.
 * Only for a runner that runs tests (runsTests). Under scripts/heavy (UNINSPIRED_LANE set) the
 * lane is already held, so it only clears the band. CI and machines without lockf skip both.
 */
export function holdLane(argv = process.argv): void {
  if (!runsTests(argv) || process.env.CI || !existsSync("/usr/bin/lockf")) return;
  if (!process.env.UNINSPIRED_LANE) takeLane();
  const orphans = spawnSync("lsof", ["-nP", `-iTCP:${BAND}-${BAND + 9}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout;
  for (const pid of orphans.split("\n").filter(Boolean)) if (!liveJob(Number(pid))) try { process.kill(Number(pid), "SIGKILL"); } catch {}
}

/** A listener a live lane job started (its UNINSPIRED_LANE_JOB mark names a running pid): never ours to stop. */
function liveJob(pid: number): boolean {
  const env = spawnSync("ps", ["-Eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  const owner = / UNINSPIRED_LANE_JOB=\S*:(\d+):(\s|$)/.exec(env)?.[1];
  if (!owner) return false;
  try { process.kill(Number(owner), 0); return true; } catch { return false; }
}

const CHROME_APPS = ["/Applications/Google Chrome.app", join(homedir(), "Applications/Google Chrome.app")];

/**
 * Checks once per Chrome version that Playwright's `chrome` channel can start: a 1–2 s headless
 * launch. Returns undefined when it can, else the fix in one line. A failure is written to
 * browser-broken in the lane's folder, where heavy and health print it to the next session; a pass
 * clears it. macOS only (CI and Linux have their own browsers); CHROME_APP points at another bundle.
 */
export function chromeProblem(): string | undefined {
  if (process.platform !== "darwin" || process.env.CI) return undefined;
  const app = process.env.CHROME_APP ?? CHROME_APPS.find((a) => existsSync(a));
  mkdirSync(DIR, { recursive: true });
  const broken = join(DIR, "browser-broken");
  const fail = (fix: string) => {
    writeFileSync(broken, `${new Date().toISOString().slice(0, 16)} in ${process.cwd().split("/").at(-1)}: ${fix}\n`);
    return fix;
  };
  if (!app || !existsSync(app)) return fail("Google Chrome isn't installed, and the chrome channel needs it: brew install --cask google-chrome, then open it once from Finder");
  const plist = spawnSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents/Info.plist")], { encoding: "utf8" });
  const version = plist.stdout.trim() || "unknown";
  const ok = join(DIR, "chrome-ok");
  if (existsSync(ok) && readFileSync(ok, "utf8").trim() === `${app} ${version}`) return undefined;
  const profile = join(DIR, `chrome-check.${process.pid}`);
  const bin = join(app, "Contents/MacOS", (spawnSync("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(app, "Contents/Info.plist")], { encoding: "utf8" }).stdout.trim() || "Google Chrome"));
  const r = spawnSync(bin, ["--headless", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, "--dump-dom", "about:blank"],
    { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
  rmSync(profile, { recursive: true, force: true });
  if (r.status === 0 && r.stdout.includes("<html")) {
    writeFileSync(ok, `${app} ${version}\n`);
    rmSync(broken, { force: true });
    return undefined;
  }
  const said = `${r.stdout}\n${r.stderr}`.split("\n").find((l) => /FATAL/.test(l))?.trim().slice(0, 160);
  const why = said ?? (r.error ? "no answer in 20 s" : `exit ${r.status ?? r.signal}`);
  // A downloaded Chrome that was never opened dies at once with path_service (9 Nov, three sessions).
  if (/path_service/.test(why))
    return fail(`Chrome ${version} can't start headless (${why}): it has never been opened. Open Google Chrome once from Finder, then run again`);
  return fail(`Chrome ${version} can't start headless (${why}): open Google Chrome once from Finder; if it still fails, brew reinstall --cask google-chrome`);
}

/**
 * Firefox keeps its data in ~/Library/Application Support/Firefox and exits at once ("Could not find
 * profile folder") where it can't create that folder: on macOS 27, commands a Claude session runs
 * are refused exactly that path (20 Nov: mom-exp's and MIXD's Firefox tests, red on any code).
 * Returns a folder for Firefox to take as its home instead, or undefined where its own folder works
 * (and off macOS, and in CI). UNINSPIRED_FIREFOX_HOME names the folder to use; 0 turns this off.
 */
export function firefoxHome(o: { folder?: string; into?: string; env?: Record<string, string | undefined>; platform?: string } = {}): string | undefined {
  const env = o.env ?? process.env;
  const asked = env.UNINSPIRED_FIREFOX_HOME;
  if (asked === "0") return undefined;
  if (!asked) {
    if ((o.platform ?? process.platform) !== "darwin" || env.CI) return undefined;
    const folder = o.folder ?? join(homedir(), "Library/Application Support/Firefox");
    try {
      // What Firefox does on its first start, undone again: where this works, so does Firefox.
      if (existsSync(folder)) {
        const probe = join(folder, `.uninspired-probe.${process.pid}`);
        writeFileSync(probe, "");
        rmSync(probe);
      } else {
        mkdirSync(folder);
        rmdirSync(folder);
      }
      return undefined;
    } catch {}
  }
  const home = asked || (o.into ?? join(DIR, "firefox-home"));
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Launch options that let Firefox start where it can't use its own data folder (firefoxHome): the
 * given ones, plus the environment with the home folder macOS apps see moved. HOME stays, so only
 * the browser moves. e2eConfig adds them to every project that runs Firefox; a spec that picks
 * Firefox itself writes `test.use({ browserName: "firefox", launchOptions: firefoxLaunch() })`.
 */
export function firefoxLaunch(launchOptions: Record<string, any> = {}, home = firefoxHome()): Record<string, any> {
  if (!home) return launchOptions;
  // Playwright replaces the browser's environment with `env`, so it carries the whole of this one.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...launchOptions.env })) if (v !== undefined) env[k] = String(v);
  return { ...launchOptions, env: { ...env, CFFIXED_USER_HOME: home } };
}

const runsFirefox = (use: Record<string, unknown> = {}) => (use.browserName ?? use.defaultBrowserType) === "firefox";

/** The projects this run selects (--project, with their dependencies unless --no-deps), else every
 *  project not marked `default: false`. Names match as Playwright does: case-insensitive, `*` globs. */
export function selectedProjects<P extends { name?: string; default?: boolean; dependencies?: string[] }>(projects: P[], argv = process.argv): P[] {
  const names: string[] = [];
  argv.forEach((a, i) => {
    const next = argv[i + 1];
    if (a === "--project" && next) names.push(next);
    else if (a.startsWith("--project=")) names.push(a.slice("--project=".length));
  });
  const match = (p: P) => names.some((n) => new RegExp(`^${n.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(p.name ?? ""));
  const picked = names.length ? projects.filter(match) : projects.filter((p) => p.default !== false);
  if (argv.includes("--no-deps")) return picked;
  const all = new Set(picked);
  const add = (p: P) => (p.dependencies ?? []).forEach((d) => {
    const dep = projects.find((q) => q.name === d);
    if (dep && !all.has(dep)) { all.add(dep); add(dep); }
  });
  picked.forEach(add);
  return [...all];
}

function takeLane() {
  mkdirSync(DIR, { recursive: true });
  const ready = join(DIR, `lane-0.ready.${process.pid}`);
  const lane = join(DIR, "lane-0");
  const job = `${lane}:${process.pid}:`;
  // Not import.meta: a config in a package without "type": "module" loads this file as CommonJS.
  const heavy = join(spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim(), ".agentic-setup/heavy");
  rmSync(ready, { force: true });
  // The helper holds the lock until this runner exits; if the helper dies, the kernel frees it.
  spawn("/usr/bin/lockf", ["-k", "-t", "1200", join(DIR, "lane-0.lock"), "sh", "-c",
    // Clear an earlier job's leftovers; when the runner is gone (even killed), its own and the holder, still in the lock.
    `sh '${heavy}' --sweep '${lane}:'; echo $$ > "$0"; while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; ` +
      `sh '${heavy}' --sweep '${job}'; : > "${join(DIR, "lane-0.holder")}"`, ready],
    { detached: true, stdio: "ignore" }).unref();
  const deadline = Date.now() + 1_205_000;
  const tick = new Int32Array(new SharedArrayBuffer(4));
  // Configs load synchronously, so the wait is synchronous too.
  let said = false;
  while (!existsSync(ready)) {
    if (!said && Date.now() > deadline - 1_204_000) {
      const holder = existsSync(join(DIR, "lane-0.holder")) ? readFileSync(join(DIR, "lane-0.holder"), "utf8").trim() : "";
      console.error(`playwright: waiting for the browser lane, held by: ${holder || "unknown"}`);
      said = true;
    }
    if (Date.now() > deadline) {
      const holder = existsSync(join(DIR, "lane-0.holder")) ? readFileSync(join(DIR, "lane-0.holder"), "utf8") : "unknown";
      throw new Error(`The browser lane stayed busy for 20 minutes. Holder: ${holder}`);
    }
    Atomics.wait(tick, 0, 0, 200);
  }
  rmSync(ready, { force: true });
  writeFileSync(join(DIR, "lane-0.holder"), `repo=${process.cwd().split("/").at(-1)} cwd=${process.cwd()} pid=${process.pid} cmd=playwright ${process.argv.slice(2).join(" ")}\n`);
  process.env.UNINSPIRED_LANE = "0";
  process.env.UNINSPIRED_LANE_JOB = job;
}

// The repo's root `postinstall`, once per checkout and lockfile. Claude Desktop seeds a new worktree's
// node_modules by copying the main checkout's (its log: "worktreeDepSeed"), so `bun install` and its
// postinstall never run there: mom-exp's worktrees had no models until someone ran `bun run models`.
// check and every Playwright test run call this; a stamp in the git dir (per worktree) keeps it to once.
/** Runs the root postinstall if this checkout hasn't for its current lockfile. Returns a line to
 *  print, or undefined when there was nothing to do. Never throws: a failure is reported, not stamped. */
export function ensurePostinstall(root: string): string | undefined {
  const pkg = join(root, "package.json");
  if (process.env.CI || !existsSync(pkg) || !existsSync(join(root, "node_modules"))) return undefined;
  let script: string | undefined;
  try { script = JSON.parse(readFileSync(pkg, "utf8")).scripts?.postinstall; } catch { return undefined; }
  if (!script) return undefined;
  const lock = ["bun.lock", "bun.lockb"].map((f) => join(root, f)).find((f) => existsSync(f));
  const key = createHash("sha256").update(script).update(lock ? readFileSync(lock) : "").digest("hex");
  const git = spawnSync("git", ["rev-parse", "--git-path", "agentic-postinstall"], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (!git) return undefined;
  const stamp = git.startsWith("/") ? git : join(root, git);
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === key) return undefined;
  const r = spawnSync("bun", ["run", "postinstall"], { cwd: root, encoding: "utf8", timeout: 5 * 60_000 });
  if (r.status !== 0) {
    const why = `${r.stdout}\n${r.stderr}`.trim().split("\n").at(-1) ?? `exit ${r.status}`;
    return `the root postinstall (${script}) failed in this checkout: ${why}; run bun install`;
  }
  writeFileSync(stamp, key + "\n");
  return `ran the root postinstall (${script}): this checkout's node_modules came without an install`;
}

/** The shared projects (07 §1): pass Playwright's `devices`. Repos add their own beside them. */
export function baseProjects(devices: Record<string, Record<string, unknown>>) {
  const chrome = devices["Desktop Chrome"];
  return [
    { name: "ui", grepInvert: /@gpu|@perf|@visual/, use: { ...chrome } },
    { name: "visual", grep: /@visual/, use: { ...chrome } },
    { name: "gpu-probe", testMatch: /gpu-probe\.spec/, use: { channel: "chromium" } },
    { name: "gpu", grep: /@gpu/, dependencies: ["gpu-probe"], workers: 1, fullyParallel: false, timeout: 120_000, use: { channel: "chromium" } },
  ];
}

type Extra = Record<string, any> & { use?: Record<string, unknown>; expect?: Record<string, unknown> };

/** The workers of a Playwright run outside the runner (which sets UNINSPIRED_PW_WORKERS from caps.ts):
 *  the same half of the performance cores. Written out here, not imported: repos type-check this
 *  file through their Playwright config, each under its own module resolution (mom-exp's rejects a
 *  `.ts` import path), and the setup's tests hold the two together. */
function directWorkers(): number {
  const asked = Number(process.env.UNINSPIRED_JOB_CORES);
  let cores = 4;
  if (Number.isInteger(asked) && asked > 0) cores = Math.min(asked, availableParallelism());
  else if (process.platform === "darwin" && !process.env.CI) {
    const n = Number(String(spawnSync("/usr/sbin/sysctl", ["-n", "hw.perflevel0.logicalcpu"], { encoding: "utf8" }).stdout ?? "").trim());
    if (Number.isInteger(n) && n > 0) cores = n;
  }
  return Math.max(1, Math.floor(cores / 2));
}

/** The shared settings: fail on `.only` and on flakes, one worker per two performance cores
 *  (caps.ts), short timeouts, fixed locale and timezone, line plus JSON reporters, a fresh server on
 *  the band. `extra` adds projects and may override a setting, which needs an EXEMPT reason in the
 *  repo's config. */
export function e2eConfig(o: { server: (port: number) => string; port?: number }, extra: Extra = {}) {
  const { use, expect, ...rest } = extra;
  if (runsTests()) {
    // A Desktop worktree's copied node_modules skipped the repo's postinstall (mom-exp's models).
    const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
    const installed = root ? ensurePostinstall(root) : undefined;
    if (installed) console.error(`playwright: ${installed}`);
    // A Chrome that can't start fails here in seconds, before the lane, not after a queue and a timeout.
    const chrome = selectedProjects<any>(extra.projects ?? []).some((p) => (p.use?.channel ?? use?.channel) === "chrome");
    const problem = chrome ? chromeProblem() : undefined;
    if (problem) {
      console.error(`playwright: ${problem}`);
      process.exit(1);
    }
    holdLane();
  }
  const port = o.port ?? BAND;
  // The JSON report goes inside the repo's own output folder, which its ignores already cover.
  const outputDir = String(extra.outputDir ?? "test-results");
  // Firefox only: Chrome and WebKit keep the real home (fonts, settings, Chrome's first-run state).
  const all: any[] | undefined = Array.isArray(rest.projects) ? rest.projects : undefined;
  const home = (all ?? [{}]).some((p) => runsFirefox({ ...use, ...p.use })) ? firefoxHome() : undefined;
  const projects = home && all
    ? all.map((p) => runsFirefox({ ...use, ...p.use }) ? { ...p, use: { ...p.use, launchOptions: firefoxLaunch(p.use?.launchOptions ?? use?.launchOptions, home) } } : p)
    : undefined;
  const firefoxOnly = home && !all ? { launchOptions: firefoxLaunch(use?.launchOptions as Record<string, any> | undefined, home) } : {};
  return {
    forbidOnly: true,
    retries: 1,
    failOnFlakyTests: true,
    workers: Number(process.env.UNINSPIRED_PW_WORKERS ?? directWorkers()),
    fullyParallel: true,
    globalTimeout: 5 * 60_000,
    timeout: 20_000,
    expect: { timeout: 5_000, ...expect },
    reporter: [["line"] as const, ["json", { outputFile: `${outputDir}/run.json` }] as const],
    use: {
      baseURL: `http://127.0.0.1:${port}`, trace: "on-first-retry" as const, screenshot: "only-on-failure" as const, video: "off" as const,
      // actionTimeout also caps page.waitForFunction and waitForEvent calls that set no timeout.
      actionTimeout: 5_000, navigationTimeout: 15_000, locale: "en-US", timezoneId: "UTC", colorScheme: "light" as const, ...use, ...firefoxOnly,
    },
    webServer: {
      command: o.server(port), url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 60_000,
      gracefulShutdown: { signal: "SIGTERM" as const, timeout: 2_000 },
    },
    ...rest,
    ...(projects ? { projects } : {}),
  };
}
