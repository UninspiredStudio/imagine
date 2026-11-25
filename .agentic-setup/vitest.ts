// Shared Vitest base (stage 2). A repo's config:
//   export default defineConfig(vitestConfig({ test: { projects, environment, setupFiles } }))
// No `.only`, at most one worker per performance core (VITEST_MAX_WORKERS, from caps.ts; the runner sets it),
// coverage written only with --coverage. Reporters stay unset: Vitest picks a compact one when an agent runs it.
// Projects listed by glob don't inherit these `test` options, so such a repo also passes
// `--allowOnly=false` in its test commands.
// `--changed` follows imports only, so a fixture, a migration or a snapshot a test reads from disk
// would select nothing (7.5 % of commits in a study of 22 projects changed such files, and one real
// failure was missed: Shi et al., ISSRE 2019). Those paths rerun everything; a repo's own triggers add to them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { join } from "node:path";

type Extra = Record<string, unknown> & { test?: Record<string, unknown> };

/** Vitest's own three, then the files tests read without importing them. */
export const RERUN_ALL = ["**/package.json/**", "**/vitest.config.*/**", "**/vite.config.*/**",
  "**/fixtures/**", "**/__fixtures__/**", "**/__snapshots__/**", "**/testdata/**", "**/migrations/**", "**/*.sql"];

// Vitest's transform cache resets only when the lockfile changes, but a new Bun can move packages
// without touching it, and the stale cache then loads a second Vitest or Preact. Naming the cache
// after where Vitest is installed gives such a move a fresh cache.
function moduleCachePath(): string | undefined {
  try {
    const at = realpathSync(createRequire(join(process.cwd(), "vitest.config.ts")).resolve("vitest/package.json"));
    return join(process.cwd(), "node_modules/.vitest-cache", createHash("sha1").update(at).digest("hex").slice(0, 8));
  } catch {
    return undefined; // Vitest's own default
  }
}

/** The workers of a Vitest run outside the runner (which sets VITEST_MAX_WORKERS from caps.ts): the
 *  same performance cores, and one core left free on a small machine (a 2-core container: 1).
 *  Written out here, not imported: repos list this file in their tsconfig (MIXD's composite
 *  project rejects an import it doesn't list), and the setup's tests hold the two together. */
function directWorkers(): number {
  const asked = Number(process.env.UNINSPIRED_JOB_CORES);
  let cores = 4;
  if (Number.isInteger(asked) && asked > 0) cores = asked;
  else if (process.platform === "darwin" && !process.env.CI) {
    const n = Number(String(spawnSync("/usr/sbin/sysctl", ["-n", "hw.perflevel0.logicalcpu"], { encoding: "utf8" }).stdout ?? "").trim());
    if (Number.isInteger(n) && n > 0) cores = n;
  }
  return Math.max(1, Math.min(cores, availableParallelism() - 1));
}

export function vitestConfig(extra: Extra = {}) {
  const { test, ...rest } = extra;
  const { coverage, forceRerunTriggers, ...ownTest } = test ?? {};
  // Vitest reads this for every project as it resolves it; a `maxWorkers` here would reach only the
  // projects that inherit this config, and Vitest rejects projects whose workers differ.
  process.env.VITEST_MAX_WORKERS ??= String(directWorkers());
  return {
    ...rest,
    test: {
      allowOnly: false,
      ...(moduleCachePath() ? { fsModuleCachePath: moduleCachePath() } : {}),
      ...ownTest,
      forceRerunTriggers: [...new Set([...RERUN_ALL, ...((forceRerunTriggers as string[] | undefined) ?? [])])],
      // A repo's coverage settings (thresholds, include) merge into the shared ones.
      coverage: { provider: "v8" as const, reporter: ["json-summary", "text-summary"], reportsDirectory: ".vitest/coverage", ...(coverage as object) },
    },
  };
}
