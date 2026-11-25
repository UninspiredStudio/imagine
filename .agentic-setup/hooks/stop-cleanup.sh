#!/bin/sh
# Stop (Claude and Codex): when a background server (a task that never ends on its own) is still
# running, asks the agent once to stop it. Finite background jobs (tests, verify, builds) may run on:
# the agent waits for their notification. stop_hook_active guards against asking twice.
input=$(cat)
# Desktop worktree sessions run the main checkout's hooks: hand over to the worktree's own copy.
here=$(printf '%s' "$input" | jq -r '.cwd // "."')
local_copy="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)/.agentic-setup/hooks/$(basename "$0")"
if [ -z "$AGENTIC_HOOK_LOCAL" ] && [ -f "$local_copy" ] && [ ! "$local_copy" -ef "$0" ]; then
  printf '%s' "$input" | AGENTIC_HOOK_LOCAL=1 sh "$local_copy"; exit $?
fi
servers=$(printf '%s' "$input" | jq -r 'select(.stop_hook_active | not) | [.background_tasks[]?
  | select((.type // "shell") == "shell" and (.status // "running") == "running")
  | select((.command // "") | test("(^|[ /;&|])(vite|next|astro|wrangler +dev|serve|http-server|http\\.server)( |$)|(run|bun) +(dev|start|preview|serve)( |$)|playwright +show-report|--watch"))
  | .command] | join("; ")')
[ -n "$servers" ] || exit 0
jq -n --arg s "$servers" '{decision: "block", reason: ("Stop the servers you started before you finish (still running: " + $s + ").")}'
