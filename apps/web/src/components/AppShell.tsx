import { Avatar } from "@imagine/components/components/Avatar";
import { DropdownMenu } from "@imagine/components/components/DropdownMenu";
import * as SubframeCore from "@subframe/core";
import {
  FeatherBoxes,
  FeatherKeyRound,
  FeatherLogOut,
  FeatherPackage,
  FeatherShield,
  Toaster,
} from "@subframe/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { isAdmin, metaQueryOptions } from "../lib/api";
import { authClient } from "../lib/auth";
import { initials } from "../lib/email";
import { notifyFailure } from "../lib/notify";
import { CopyButton } from "./Copy";

type User = { email: string; role?: string | null };

// Desktop: icon rail beside an inset panel. Mobile: top bar, full-bleed panel, bottom tab bar.
export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const { data: meta } = useQuery(metaQueryOptions);
  const { pathname } = useLocation();

  const items = [
    {
      to: "/",
      label: "Images",
      icon: <FeatherBoxes />,
      active: pathname === "/" || pathname.startsWith("/images/"),
    },
    { to: "/access-tokens", label: "Personal access tokens", icon: <FeatherKeyRound />, active: pathname === "/access-tokens" },
    ...(isAdmin(user)
      ? [{ to: "/admin", label: "Admin", icon: <FeatherShield />, active: pathname === "/admin" } as const]
      : []),
  ] as const;

  const navLinks = (itemClass: string) =>
    items.map((item) => (
      <Link
        key={item.to}
        to={item.to}
        aria-current={item.active ? "page" : undefined}
        className={`flex flex-col items-center gap-1 rounded-lg ${itemClass} ${item.active ? "bg-brand-100" : "hover:bg-neutral-200"}`}
      >
        <span className={`text-heading-3 font-heading-3 ${item.active ? "text-brand-600" : "text-subtext-color"}`}>
          {item.icon}
        </span>
        <span
          className={`whitespace-nowrap ${
            item.active
              ? "text-caption-bold font-caption-bold text-brand-800"
              : "text-caption font-caption text-secondary-font"
          }`}
        >
          {item.label}
        </span>
      </Link>
    ));

  return (
    <div className="flex h-full w-full bg-page-background items-stretch mobile:flex-col">
      <header className="hidden flex-none items-center justify-between border-b border-solid border-neutral-border bg-default-background px-4 py-3 gap-3 mobile:flex">
        <div className="flex min-w-[0px] items-center gap-2.5">
          <div className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-brand-600">
            <FeatherPackage className="text-heading-3 font-heading-3 text-white" />
          </div>
          <div className="flex min-w-[0px] flex-col items-start">
            <span className="text-body-bold font-body-bold text-default-font">Imagine</span>
            <span className="max-w-full whitespace-nowrap text-monospace-caption font-monospace-caption text-subtext-color truncate">
              {meta?.host}
            </span>
          </div>
        </div>
        <UserMenu user={user} side="bottom" />
      </header>
      <aside className="flex w-[72px] flex-none flex-col items-center gap-5 self-stretch px-1.5 py-4 mobile:hidden">
        <SubframeCore.HoverCard.Root openDelay={150}>
          <SubframeCore.HoverCard.Trigger asChild={true}>
            <button
              type="button"
              aria-label={`Imagine, ${meta?.host ?? ""}`}
              className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-600 shadow-sm cursor-pointer hover:bg-brand-700"
            >
              <FeatherPackage className="text-heading-3 font-heading-3 text-white" />
            </button>
          </SubframeCore.HoverCard.Trigger>
          <SubframeCore.HoverCard.Portal>
            <SubframeCore.HoverCard.Content side="right" align="start" sideOffset={8} asChild={true}>
              <div className="flex flex-col items-start gap-2 rounded-lg border border-solid border-neutral-border bg-default-background px-3 py-3 shadow-lg">
                <span className="text-body-bold font-body-bold text-default-font">Imagine</span>
                <div className="flex items-center gap-2 rounded-md bg-page-background pl-2.5 pr-1 py-1">
                  <div className="flex h-1.5 w-1.5 flex-none items-start rounded-full bg-success-500" />
                  <span className="text-monospace-caption font-monospace-caption text-secondary-font">
                    {meta?.host}
                  </span>
                  <CopyButton text={meta?.host ?? ""} label="Copy registry host" />
                </div>
              </div>
            </SubframeCore.HoverCard.Content>
          </SubframeCore.HoverCard.Portal>
        </SubframeCore.HoverCard.Root>
        <nav aria-label="Main" className="flex w-full flex-col items-center gap-1">
          {navLinks("w-full px-1 py-2")}
        </nav>
        <div className="flex w-full flex-col items-center justify-end grow">
          <UserMenu user={user} side="right" />
        </div>
      </aside>
      <div className="flex min-h-[0px] min-w-[0px] flex-col self-stretch pr-2 py-2 grow items-stretch mobile:px-0 mobile:py-0">
        <main className="flex min-h-[0px] w-full flex-col items-center gap-6 overflow-y-auto rounded-lg border border-solid border-neutral-border bg-default-background px-8 pt-7 pb-6 shadow-sm relative grow mobile:gap-4 mobile:rounded-none mobile:border-none mobile:px-4 mobile:py-4 mobile:shadow-none">
          <div className="flex w-full max-w-[1280px] flex-col items-start gap-6 grow mobile:gap-4">{children}</div>
        </main>
      </div>
      <nav
        aria-label="Main"
        className="hidden flex-none gap-1 border-t border-solid border-neutral-border bg-default-background px-2 pt-1.5 pb-3 items-stretch mobile:flex"
      >
        {navLinks("grow shrink-0 basis-0 px-2 py-1.5")}
      </nav>
      <Toaster position="bottom-right" offset={32} mobileOffset={{ bottom: 88, left: 16, right: 16 }} />
    </div>
  );
}

function UserMenu({ user, side }: { user: User; side: "right" | "bottom" }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function signOut() {
    const { error } = await authClient.signOut();
    if (error) {
      notifyFailure("Couldn't sign out")(new Error("Try again."));
      return;
    }
    await navigate({ to: "/login" });
    // The next person to sign in on this browser must not see this user's data.
    queryClient.clear();
  }

  return (
    <SubframeCore.DropdownMenu.Root>
      <SubframeCore.DropdownMenu.Trigger asChild={true}>
        <button
          type="button"
          aria-label="Account"
          className="flex items-center justify-center rounded-full px-1 py-1 cursor-pointer hover:bg-neutral-200"
        >
          <Avatar size="medium">{initials(user.email)}</Avatar>
        </button>
      </SubframeCore.DropdownMenu.Trigger>
      <SubframeCore.DropdownMenu.Portal>
        <SubframeCore.DropdownMenu.Content side={side} align="end" sideOffset={8} asChild={true}>
          <DropdownMenu>
            <div className="flex w-full flex-col items-start gap-1 px-3 py-2">
              <span className="text-body-bold font-body-bold text-default-font">{user.email}</span>
              <span className="text-caption font-caption text-subtext-color">
                {isAdmin(user) ? "Admin" : "Member"} of Imagine
              </span>
            </div>
            <DropdownMenu.DropdownDivider />
            <DropdownMenu.DropdownItem icon={<FeatherLogOut />} onSelect={() => void signOut()}>
              Sign out
            </DropdownMenu.DropdownItem>
          </DropdownMenu>
        </SubframeCore.DropdownMenu.Content>
      </SubframeCore.DropdownMenu.Portal>
    </SubframeCore.DropdownMenu.Root>
  );
}
