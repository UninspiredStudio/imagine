import { Tooltip } from "@imagine/components/components/Tooltip";
import * as SubframeCore from "@subframe/core";
import type { ReactNode } from "react";

// The span takes hover and focus, so the hint also works around a disabled button.
export function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <SubframeCore.Tooltip.Provider>
      <SubframeCore.Tooltip.Root>
        <SubframeCore.Tooltip.Trigger asChild={true}>
          <span tabIndex={0}>{children}</span>
        </SubframeCore.Tooltip.Trigger>
        <SubframeCore.Tooltip.Portal>
          <SubframeCore.Tooltip.Content side="top" align="center" sideOffset={4} asChild={true}>
            <Tooltip>{text}</Tooltip>
          </SubframeCore.Tooltip.Content>
        </SubframeCore.Tooltip.Portal>
      </SubframeCore.Tooltip.Root>
    </SubframeCore.Tooltip.Provider>
  );
}
