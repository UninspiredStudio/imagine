import { FeatherPackage } from "@subframe/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { metaQueryOptions } from "../lib/api";

// The sign-in and invite pages share this chrome. `footer` sits below the card.
export function AuthCard({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const { data: meta } = useQuery(metaQueryOptions);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-page-background px-6 py-12 mobile:justify-start mobile:px-4 mobile:py-10">
      <div className="flex w-full max-w-[400px] flex-col items-start gap-6 rounded-lg border border-solid border-neutral-border bg-default-background px-8 py-8 shadow-sm mobile:px-6 mobile:py-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-600 shadow-sm">
            <FeatherPackage className="text-heading-3 font-heading-3 text-white" />
          </div>
          <div className="flex flex-col items-start">
            <span className="text-body-bold font-body-bold text-default-font">Imagine</span>
            <span className="text-monospace-caption font-monospace-caption text-subtext-color">{meta?.host}</span>
          </div>
        </div>
        {children}
      </div>
      {footer}
    </div>
  );
}
