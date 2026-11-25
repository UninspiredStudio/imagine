import { Button } from "@imagine/components/components/Button";
import { SkeletonText } from "@imagine/components/components/SkeletonText";
import { FeatherAlertCircle, FeatherRotateCw } from "@subframe/core";
import type { ReactNode } from "react";

export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="flex w-full items-end justify-between gap-6 mobile:flex-col mobile:items-start mobile:justify-start mobile:gap-3">
      <div className="flex min-w-[0px] flex-col items-start gap-1">
        <h1 className="text-heading-1 font-heading-1 text-default-font mobile:text-heading-2 mobile:font-heading-2">
          {title}
        </h1>
        <span className="text-body font-body text-subtext-color">{description}</span>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionHeading({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex grow shrink-0 basis-0 gap-2 items-baseline">
      <h2 className="text-heading-2 font-heading-2 text-default-font">{title}</h2>
      {count === undefined ? null : <span className="text-body font-body text-subtext-color">{count}</span>}
    </div>
  );
}

// A dashed panel for an empty list.
export function EmptyPanel({
  icon,
  brand = false,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  brand?: boolean;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col items-center gap-4 rounded-lg border border-dashed border-neutral-border bg-page-background px-6 py-12 mobile:px-4 mobile:py-8">
      <div
        className={`flex h-10 w-10 flex-none items-center justify-center text-heading-3 font-heading-3 ${
          brand ? "rounded-lg bg-brand-50 text-brand-600" : "rounded-full bg-neutral-200 text-subtext-color"
        }`}
      >
        {icon}
      </div>
      <div className="flex max-w-[520px] flex-col items-center gap-1">
        <h2 className="text-heading-3 font-heading-3 text-default-font text-center break-words">{title}</h2>
        <span className="text-body font-body text-subtext-color text-center">{description}</span>
      </div>
      {children}
    </div>
  );
}

// A whole page that is not available: not found, forbidden or failed.
export function PageMessage({
  icon,
  title,
  detail,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col items-center gap-4 px-6 py-16 mobile:px-2 mobile:py-10">
      <div className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-neutral-100 text-heading-2 font-heading-2 text-subtext-color">
        {icon}
      </div>
      <div className="flex max-w-[400px] flex-col items-center gap-1">
        <h1 className="text-heading-2 font-heading-2 text-default-font text-center">{title}</h1>
        {detail ? (
          <span className="text-monospace-body font-monospace-body text-secondary-font text-center break-all">
            {detail}
          </span>
        ) : null}
        <span className="text-body font-body text-subtext-color text-center">{description}</span>
      </div>
      {children}
    </div>
  );
}

export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="w-full">
      <EmptyPanel
        icon={<FeatherAlertCircle />}
        title={`Couldn't load ${what}`}
        description="Check your connection and try again."
      >
        <Button variant="neutral-secondary" icon={<FeatherRotateCw />} onClick={onRetry}>
          Try again
        </Button>
      </EmptyPanel>
    </div>
  );
}

export function LoadingRows() {
  return (
    <div role="status" aria-label="Loading" className="flex w-full flex-col items-start gap-2">
      {Array.from({ length: 5 }, (_, index) => (
        <SkeletonText key={index} size="header" />
      ))}
    </div>
  );
}
