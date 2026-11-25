#!/bin/sh
# PostToolUse on edits (Claude and Codex): lints the edited file with the repo's fast oxlint config
# and hands the findings back to the agent. Reports only, never --fix (a rewrite makes the agent's
# next edit stale). Appends its duration in ms to the repo's git dir (agentic-hook.log). Every
# process start counts against the 300 ms budget, so the happy path runs one jq, one git, oxlint
# and the two clock reads, and paths are cut with shell expansion instead of dirname.
# oxlint's bin is a Node script, and Node's start is most of a one-file lint (Homebrew's Node 26:
# 100 ms of a 180 ms lint; Bun starts in 10), so the file is linted with the same CLI under Bun: both
# report the same findings, the JS plugins' included (all eight repos, and the setup's tests hold
# it). Exit 0 is clean and 1 is findings; anything else is Bun or the CLI failing, and Node decides.
t0=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
input=$(cat)
# Claude sends tool_input.file_path; Codex may send apply_patch text in command, patch, or input.
out=$(printf '%s' "$input" | jq -r '(.cwd // "."), (.tool_input.file_path // .tool_input.path // .tool_input.filePath // empty),
  ([.tool_input.command, .tool_input.patch, .tool_input.input][] | if type == "string" then scan("(?m)^\\*\\*\\* (?:Add|Update) File: (.+)$")[0] else empty end)')
first=1
set --
while IFS= read -r f; do
  if [ "$first" = 1 ]; then cwd=$f; first=0; continue; fi
  case "$f" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts) ;; *) continue ;; esac
  case "$f" in /*) ;; *) f="$cwd/$f" ;; esac
  set -- "$@" "$f"
done <<EOF
$out
EOF
[ $# -gt 0 ] || exit 0
# The repo that holds the file, not $CLAUDE_PROJECT_DIR: Desktop worktree sessions run the main
# checkout's hooks, so the worktree's own setup is found from the file.
paths=$(git -C "${1%/*}" rev-parse --show-toplevel --git-path agentic-hook.log 2>/dev/null) || exit 0
root=${paths%%
*}
log=${paths#*
}
case "$log" in /*) ;; *) log="${1%/*}/$log" ;; esac
local_copy="$root/.agentic-setup/hooks/${0##*/}"
if [ -z "$AGENTIC_HOOK_LOCAL" ] && [ -f "$local_copy" ] && [ ! "$local_copy" -ef "$0" ]; then
  printf '%s' "$input" | AGENTIC_HOOK_LOCAL=1 sh "$local_copy"; exit $?
fi
# The nearest folder at or above the file with a fast config (momentum keeps it in apps/app).
dir=${1%/*}
config=""
while [ -z "$config" ]; do
  for c in oxlint.fast.json oxlint.fast.config.ts; do [ -f "$dir/$c" ] && config="$dir/$c" && break; done
  { [ "$dir" = "$root" ] || [ -z "$dir" ]; } && break
  dir=${dir%/*}
done
[ -n "$config" ] || exit 0
lintdir=${config%/*}
ox="$lintdir/node_modules/.bin/oxlint"; [ -x "$ox" ] || ox="$root/node_modules/.bin/oxlint"
[ -x "$ox" ] || exit 0
cli="${ox%/.bin/oxlint}/oxlint/dist/cli.js"
code=2
[ -z "$AGENTIC_HOOK_NODE" ] && [ -f "$cli" ] && command -v bun >/dev/null 2>&1 &&
  { out=$(cd "$lintdir" && bun "$cli" -c "$config" -f agent --no-error-on-unmatched-pattern "$@" 2>&1); code=$?; }
[ "$code" -le 1 ] || { out=$(cd "$lintdir" && "$ox" -c "$config" -f agent --no-error-on-unmatched-pattern "$@" 2>&1); code=$?; }
echo "$(( $(perl -MTime::HiRes=time -e 'printf "%d", time*1000') - t0 ))" >> "$log"
[ "$code" -eq 0 ] && exit 0
jq -n --arg out "$out" '{hookSpecificOutput: {hookEventName: "PostToolUse",
  additionalContext: ("oxlint found problems in the files you just edited:\n" + $out)}}'
