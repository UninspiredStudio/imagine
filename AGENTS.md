<!-- agentic-setup:begin -->

## Shared agent rules (from agentic-setup)

Work in this loop, always through `bun run`:

1. After a coherent change, which may span several edits: `bun run check` (lint, types and the
   unit tests your change reaches). Re-run after fixing a failed check; quote its summary line.
   EXEMPT: post-edit hooks give immediate lint feedback; batch related edits before running the
   broader checks so they exercise a complete change.
2. After a change to a UI flow, in repos with browser tests: `bun run e2e --changed`
   (`bun run e2e <spec…>` runs named specs).
3. Before handing the work over: `bun run verify`, once. The work is ready when `verify` is green.

To get green, fix the cause. A check you must loosen gets an `EXEMPT` reason next to the change.
When a test or a check contradicts the request, stop and say so: never edit the test, skip it or
special-case the code to pass it.

- EXEMPT: for prose-only changes, review the diff and referenced paths, and validate any generated
  documentation copies. Code, configuration and executable examples still require `check` and `verify`.
- For a read-only audit, establish a verification baseline for the reviewed state and reuse it while
  source, dependencies and check configuration stay unchanged. Run focused reproductions as needed;
  a new reviewer alone is not a reason to repeat the full gate. Record changes that invalidate the baseline.
- Write a test only when you can name the user-visible bug it would catch. Red → green loops use
  unit tests; browser tests come once the feature works.
- `verify` lists the existing tests you edited, deleted or skipped and the `EXEMPT` reasons you
  added: give the reason for each in the hand-over.
- Before handing over more than about 300 changed lines, or a change to sign-in, payments or
  deleting data: give a fresh sub-agent only the diff and the request, to look for bugs, not style.
  Fix what it confirms and say what it found.
- Browser, GPU, perf and export jobs share one lane per Mac, so `e2e` can queue (up to 20 minutes,
  printing who holds the lane) before its 3-minute run. When yours waits, let it wait; never stop
  another session's job.
- Read `check`, `verify` and `e2e` output whole: a pipe (`| tail`, `| grep`) hides the exit code
  and the lane's waiting line.
- Neon Postgres: any query wakes a suspended compute, and that compute is billed until it suspends
  again, so frequent cron jobs, health checks, keep-alives or polling that hit the database keep it
  billed for the whole month. Keep scheduled database access to a minimum: run jobs as rarely as
  the feature allows, batch them, and skip the query when there is nothing to do.

<!-- agentic-setup:end -->
