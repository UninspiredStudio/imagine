import { IconButton } from "@imagine/components/components/IconButton";
import { FeatherCopy } from "@subframe/core";
import { copy } from "../lib/notify";

export function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <IconButton
      size="small"
      icon={<FeatherCopy />}
      aria-label={label}
      onClick={(event) => {
        // Copy buttons sit inside clickable rows.
        event.stopPropagation();
        void copy(text);
      }}
    />
  );
}

export function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex w-full items-center gap-2 rounded-md border border-solid border-neutral-border bg-default-background pl-3 pr-1 py-1">
      <span
        title={command}
        className="min-w-[0px] grow shrink-0 basis-0 whitespace-nowrap text-left text-monospace-body font-monospace-body text-default-font truncate"
      >
        {command}
      </span>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}
