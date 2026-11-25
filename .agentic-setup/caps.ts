// What one check, verify or e2e job may take of this machine. A job is capped so several sessions'
// jobs fit side by side (three benches at once overloaded a Mac and turned a verify red), and the cap
// follows the machine it runs on: its unit is the performance cores. On the 4P+4E Mac the setup was
// built on this gives the fixed caps it had (4 Vitest workers, 2 Playwright workers, 2 checkers).
// Measured on a 6P+6E M3 Pro with 36 GB (Nov 2026): Vitest at 6 workers takes about 26 % less time
// than at 4 for 10 % more CPU (MIXD, mom-exp, us-auth, momentum); 8 and 11 workers gain under 10 %
// more for 30–45 % more CPU. mom-exp's 126 UI tests take 143–178 s at 2 Playwright workers, 94–100 s
// at 3 and 80 s at 4, where the browsers alone fill 8 cores. tsc uncapped gains 0.3 s of 1.8 s for
// twice the CPU. The efficiency cores stay free for the other sessions and the servers.
import { spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";

/** This machine's performance cores (Apple silicon's hw.perflevel0), or 4, the old fixed cap, where
 *  there is no such split (CI, Linux, Intel). UNINSPIRED_JOB_CORES sets it for a bench or a busy day. */
export function jobCores(env: Record<string, string | undefined> = process.env): number {
  const asked = Number(env.UNINSPIRED_JOB_CORES);
  if (Number.isInteger(asked) && asked > 0) return Math.min(asked, availableParallelism());
  if (process.platform === "darwin" && !env.CI) {
    const n = Number(String(spawnSync("/usr/sbin/sysctl", ["-n", "hw.perflevel0.logicalcpu"], { encoding: "utf8" }).stdout ?? "").trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 4;
}

/** The environment the runners give every step. Browser workers and type checkers get half the
 *  cores: each Playwright worker drives a browser of several processes, and tsc's checkers each
 *  hold a copy of the program. */
export function caps(cores = jobCores()) {
  const half = Math.max(1, Math.floor(cores / 2));
  return {
    VITEST_MAX_WORKERS: String(cores),
    GOMAXPROCS: String(cores),
    UNINSPIRED_PW_WORKERS: String(half),
    TSC_CAPS: `--checkers ${half} --builders 1`,
  };
}

/** Whether the touched workspaces' type checks may run at once instead of one after another: with
 *  32 GB or more, and never on CI. At once they take more memory for less time (us-auth, every
 *  workspace: 3.0 GB and 7 s against 1.9 GB and 12 s on a 36 GB Mac), which a 16 GB Mac shared by
 *  several sessions doesn't have. */
export function workspacesAtOnce(env: Record<string, string | undefined> = process.env, memory = totalmem()): boolean {
  return !env.CI && memory >= 30 * 2 ** 30;
}
