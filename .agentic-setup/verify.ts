// bun .agentic-setup/verify.ts [--all] : the lockfile check, the repo's `verify` steps (whole-repo static checks, unit
// tests, build, full ui e2e), the lint baseline check, then the heavy lanes whose globs match the
// branch diff (every lane with --all or on a config or lockfile change), each through
// .agentic-setup/heavy, the machine-wide lane. Once a step is red, the steps marked `heavy` and the
// lanes are skipped and named: minutes of browser and GPU work can't turn a red verify green.
import { CAPS, loadConfig, mergeLanes, problems, repoRoot, reportStep, reviewNotes, scope, secrets, sh, STEP_MS, stepCmd, stepName, type Step } from "./check.ts";

const root = repoRoot();
const t0 = Date.now();
const config = await loadConfig(root);
const all = process.argv.includes("--all");
const s = scope(root, config.base, false);
const env = { ...CAPS, CHECK_BASE: s.from };
// The lockfile must match package.json, as CI and deploys install it (a stale one only fails there).
const steps: Step[] = [{ name: "lockfile", run: "bun install --frozen-lockfile" }, ...config.verify,
  { name: "lint-baseline", run: "bun .agentic-setup/lint-baseline.ts --check" }];
const lanes = mergeLanes(Object.entries(config.lanes ?? {})
  .filter(([glob]) => all || s.all || s.files.some((f) => new Bun.Glob(glob).match(f)))
  .flatMap(([, cmds]) => cmds));
const failed: string[] = secrets(root, s.files, s.from);
console.log(`verify: scope: ${s.files.length} changed file(s) since ${s.from.slice(0, 9)}; ${all || s.all ? "all configured lanes selected" : "lanes selected by changed paths"}`);
let ran = 0, afterRed = 0;
for (const [i, step] of steps.entries()) {
  if (failed.length && typeof step !== "string" && step.heavy) {
    console.log(`verify: ${stepName(step)}: skipped, an earlier step is red`);
    afterRed++;
    continue;
  }
  const r = await sh(stepCmd(step), root, env, STEP_MS.verify);
  ran++;
  reportStep("verify", stepName(step), r, root, String(i + 1));
  if (r.code !== 0) failed.push(...problems(stepName(step), r.out));
}
// CI (MIXD's runs `bun run verify` on Ubuntu) has no browsers installed: lanes are for this Mac.
const skipped = process.env.CI ? lanes : [];
for (const lane of skipped) console.log(`verify: lane skipped on CI: ${lane}`);
const selected = process.env.CI || failed.length ? [] : lanes;
if (!process.env.CI && failed.length) for (const lane of lanes) {
  console.log(`verify: lane skipped, an earlier step is red: ${lane}`);
  afterRed++;
}
for (const [i, lane] of selected.entries()) {
  console.log(`verify: lane ${lane} (queues for the browser lane)`);
  const r = await sh('sh .agentic-setup/heavy sh -c "$LANE_CMD"', root, { ...env, LANE_CMD: lane }, STEP_MS.lane);
  reportStep("verify", `lane ${lane}`, r, root, `lane-${i + 1}`);
  if (r.code !== 0) failed.push(...problems(`lane ${lane}`, r.out));
}
for (const note of reviewNotes(root, s.from)) console.log(`verify: review: ${note}`);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const what = `${ran} steps and ${selected.length} lane${selected.length === 1 ? "" : "s"} run, ${skipped.length + afterRed} skipped in ${secs} s`;
if (failed.length) {
  for (const l of failed) console.log(l);
  console.log(`verify: red, ${what}`);
  process.exit(1);
}
console.log(`verify: green, ${what}`);
