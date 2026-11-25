import { IconButton } from "@imagine/components/components/IconButton";
import { FeatherCheck, FeatherCopy } from "@subframe/core";
import { useState, type MouseEvent } from "react";

// Copies the code block it sits in.
export function CopyCode() {
  const [copied, setCopied] = useState(false);

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    const code = event.currentTarget.closest("[data-code]")?.querySelector("pre")?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return; // Clipboard blocked. The code can still be selected.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <IconButton
      size="small"
      icon={copied ? <FeatherCheck /> : <FeatherCopy />}
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={(event) => void copy(event)}
    />
  );
}
