#!/bin/sh
# PreToolUse on shell commands (Claude and Codex): warns when `bun run check|verify|e2e` is piped,
# and denies `wrangler deploy` through any runner
# (bunx, npx, bun run, …) except a single dry-run, alone or after one `cd <folder> &&` (deploys go through Workers Builds), and any command
# a repo lists in its .agentic-forbid (one extended regex per line, # comments). The repo is the
# session's folder, or a folder the command names with cd, -C or --cwd.
# shortcut: a package script that calls wrangler deploy under another name isn't seen; resolve
# `bun run <script>` against package.json if that happens.
input=$(cat)
# Desktop worktree sessions run the main checkout's hooks: hand over to the worktree's own copy.
here=$(printf '%s' "$input" | jq -r '.cwd // "."')
local_copy="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)/.agentic-setup/hooks/$(basename "$0")"
if [ -z "$AGENTIC_HOOK_LOCAL" ] && [ -f "$local_copy" ] && [ ! "$local_copy" -ef "$0" ]; then
  printf '%s' "$input" | AGENTIC_HOOK_LOCAL=1 sh "$local_copy"; exit $?
fi
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // (.tool_input.cmd | if type == "array" then join(" ") else . end) // ""')
deny() { jq -n --arg r "$1" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'; exit 0; }
# Waiting in a foreground poll loop burns the tool's time limit (retrospective: 110 min).
bg=$(printf '%s' "$input" | jq -r '.tool_input.run_in_background // false')
[ "$bg" != true ] && printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])(while|until)[[:space:]].*(;|[[:space:]])do[[:space:]].*sleep[[:space:]]' &&
  deny "Don't wait in a foreground poll loop: start the job in the background and let it notify you when it ends."
dirs="$here $(printf '%s' "$cmd" | grep -Eo '(^|[;&|[:space:]])(cd|-C|--cwd)[[:space:]=]+[^;&|[:space:]]+' | sed -E 's/.*(cd|-C|--cwd)[[:space:]=]+//')"
for d in $dirs; do
  case $d in /*) ;; *) d="$here/$d" ;; esac
  top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || continue
  [ -f "$top/.agentic-forbid" ] || continue
  hit=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$top/.agentic-forbid" | while IFS= read -r re; do
    printf '%s' "$cmd" | grep -Eq -- "$re" && { printf '%s' "$re"; break; }
  done)
  [ -n "$hit" ] && deny "$(basename "$top") doesn't allow this command (its .agentic-forbid matches: $hit). $(sed -n 's/^# why: //p' "$top/.agentic-forbid" | head -1)"
done
# A warning, not a deny: `bun run check | tail` reports tail's exit code and can cut the lane's waiting line.
piped=$(printf '%s' "$cmd" | grep -Eo 'bun +run +(check|verify|e2e)([^;&|]|&[0-9>])*\|[[:space:]]*[^|[:space:]]+' | head -1)
done_() {
  [ -n "$piped" ] && jq -n --arg c "Your command pipes the output (${piped}): the exit code you see is the last command's, not the check's, and the browser lane's waiting line can be cut. Run it again unpiped if you need its result; its output is already short." \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $c}}'
  exit 0
}
# Seen as a deploy: `(cd api && wrangler deploy)`, `wrangler deploy>log`, `wrangler@4 deploy`,
# `wrangler "deploy"`, one split over two lines, and one inside a shell's -c string. Not seen: a file
# named wrangler.jsonc beside one named deploy.md, or the two words closing a search pattern or a
# sentence ("wrangler deploy", wrangler deploy.).
flat=$(printf '%s' "$cmd" | tr '\n' ' ')
q="'"
w='wrangler(@[^;&|[:space:]]*)?([[:space:]]+[^;&|[:space:]]+)*[[:space:]]+'
printf '%s' "$flat" | grep -Eq "${w}(\"deploy\"|${q}deploy${q}|deploy)([[:space:];&|)<>]|\$)|(^|[;&|([:space:]])(sh|bash|zsh|dash|ksh)[[:space:]].*${w}deploy" || done_
# Only exempt an unambiguous invocation: shell syntax or another command must not borrow its flag.
case "$cmd" in
  *'
'*) ;;
  *)
    # A repo with one Worker config per environment dry-runs with --config, from the app's folder.
    path='[[:alnum:]_./][[:alnum:]_./-]*'
    args="([[:blank:]]+(--env|--outdir|--config|-c|--cwd)(=|[[:blank:]]+)${path})*"
    printf '%s' "$cmd" | grep -Eq "^[[:blank:]]*(cd[[:blank:]]+${path}[[:blank:]]*&&[[:blank:]]*)?((bunx|npx|bun[[:blank:]]+run)[[:blank:]]+)?wrangler(@[[:alnum:]._-]+)?[[:blank:]]+deploy${args}[[:blank:]]+--dry-run${args}[[:blank:]]*$" && done_
    ;;
esac
jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny",
  permissionDecisionReason: "Deploys go through Workers Builds (a push to develop or main), never wrangler deploy. Use one wrangler deploy --dry-run command to check a build; split compound commands into separate tool calls."}}'
