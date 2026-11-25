// bun .agentic-setup/hooks/install.ts : adds the shared hooks to .claude/settings.json (after the
// repo's own entries) and writes .codex/hooks.json. Running it again changes nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const cmd = (name: string, base: string) => `"${base}"/.agentic-setup/hooks/${name}`;
const entries = (base: string, edit: string, shell: string) => ({
  PreToolUse: [
    { matcher: edit, hooks: [{ type: "command", command: cmd("subframe-guard.sh", base) }] },
    { matcher: shell, hooks: [{ type: "command", command: cmd("no-deploy.sh", base) }] },
  ],
  PostToolUse: [{ matcher: edit, hooks: [{ type: "command", command: cmd("lint-after-edit.sh", base) }] }],
  Stop: [{ hooks: [{ type: "command", command: cmd("stop-cleanup.sh", base) }] }],
});

function merge(path: string, add: Record<string, any[]>, wrap: (h: any) => any = (h) => h) {
  const json = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const hooks = (json.hooks ??= {});
  for (const [event, list] of Object.entries(add)) {
    // Drop earlier copies of ours, then append in a fixed order after the repo's own entries.
    const own = (hooks[event] ?? []).filter((e: any) => !JSON.stringify(e).includes(".agentic-setup/hooks/"));
    // Untracked's adapter confines paths and groups package configs; don't lint the same edit twice.
    const adapterCommands = [
      'bun "$CLAUDE_PROJECT_DIR/scripts/lint-after-edit.ts"',
      'bun "$(git rev-parse --show-toplevel)/scripts/lint-after-edit.ts"',
      `bun "${root}/scripts/lint-after-edit.ts"`,
    ];
    const hasAdapter = event === "PostToolUse" && existsSync(join(root, "scripts/lint-after-edit.ts")) &&
      own.some((entry: any) => (entry.matcher === undefined || list.some((added) => entry.matcher === added.matcher)) &&
        entry.hooks?.some((hook: any) => hook.type === "command" && adapterCommands.includes(hook.command)));
    hooks[event] = [...own, ...(hasAdapter ? [] : list.map(wrap))];
  }
  const text = JSON.stringify(json, null, 2) + "\n";
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
}

merge(join(root, ".claude/settings.json"), entries("$CLAUDE_PROJECT_DIR", "Edit|Write|MultiEdit", "Bash"));
// Codex (learn.chatgpt.com/docs/hooks): shell commands match as Bash, edits as apply_patch, and
// commands run in the session cwd, so paths start from the git root.
merge(join(root, ".codex/hooks.json"), entries("$(git rev-parse --show-toplevel)", "apply_patch|Edit|Write", "Bash"));
