import { Badge } from "@imagine/components/components/Badge";
import { Button } from "@imagine/components/components/Button";
import { LinkButton } from "@imagine/components/components/LinkButton";
import { TextField } from "@imagine/components/components/TextField";
import { FeatherLink2Off, FeatherLock, FeatherMail } from "@subframe/core";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AuthCard } from "../components/AuthCard";
import { CodeStep } from "../components/CodeStep";
import { SendCodeAlert } from "../components/SendCodeAlert";
import { lookupInvite, metaQueryOptions } from "../lib/api";
import { authClient } from "../lib/auth";
import { useSendSignInCode } from "../lib/otp";

export const Route = createFileRoute("/invite")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (data) throw redirect({ to: "/" });
  },
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ context, deps }) => {
    const [invite] = await Promise.all([
      lookupInvite(deps.token),
      context.queryClient.query({ ...metaQueryOptions, staleTime: "static" }),
    ]);
    return invite;
  },
  component: InvitePage,
});

function InvitePage() {
  const invite = Route.useLoaderData();
  const navigate = useNavigate();
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (!invite) {
    return (
      <AuthCard>
        <div className="flex w-full flex-col items-start gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-neutral-100">
            <FeatherLink2Off className="text-heading-3 font-heading-3 text-subtext-color" />
          </div>
          <div className="flex w-full flex-col items-start gap-1">
            <h1 className="text-heading-2 font-heading-2 text-default-font">This invite link no longer works</h1>
            <span className="text-body font-body text-subtext-color">
              It may have expired or already been used. Ask an admin of this registry to send you a new invite.
            </span>
          </div>
        </div>
        <Button
          className="h-10 w-full flex-none"
          variant="neutral-secondary"
          size="large"
          onClick={() => navigate({ to: "/login" })}
        >
          Go to sign in
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      footer={
        <div className="flex items-center gap-1">
          <span className="text-caption font-caption text-subtext-color">Already have access?</span>
          <LinkButton variant="brand" size="small" onClick={() => navigate({ to: "/login" })}>
            Sign in
          </LinkButton>
        </div>
      }
    >
      {sentTo === null ? (
        <InviteEmailStep invite={invite} onSent={setSentTo} />
      ) : (
        <CodeStep
          email={sentTo}
          onChangeEmail={() => setSentTo(null)}
          onSignedIn={() => navigate({ to: "/" })}
        />
      )}
    </AuthCard>
  );
}

function InviteEmailStep({
  invite,
  onSent,
}: {
  invite: { email: string; role: string };
  onSent: (email: string) => void;
}) {
  const { send, sending, retryIn, failed } = useSendSignInCode(onSent);

  return (
    <>
      <div className="flex w-full flex-col items-start gap-1">
        <div className="flex w-full items-center gap-2">
          <h1 className="text-heading-2 font-heading-2 text-default-font">Join Imagine</h1>
          <Badge className="rounded-full" variant="neutral">
            {invite.role === "admin" ? "Admin" : "Member"}
          </Badge>
        </div>
        <span className="text-body font-body text-subtext-color">
          You&apos;ve been invited to the Imagine registry. Confirm your email to get a sign-in code.
        </span>
      </div>
      <SendCodeAlert retryIn={retryIn} failed={failed} />
      <form
        noValidate
        className="flex w-full flex-col items-start gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void send(invite.email);
        }}
      >
        <TextField
          className="h-auto w-full flex-none"
          label="Email"
          disabled
          helpText="This invite is for this address only."
          icon={<FeatherMail />}
          iconRight={<FeatherLock />}
        >
          <TextField.Input value={invite.email} readOnly />
        </TextField>
        <Button
          type="submit"
          className="h-10 w-full flex-none"
          size="large"
          loading={sending}
          disabled={sending || retryIn > 0}
        >
          {retryIn > 0 ? `Try again in ${retryIn}s` : "Send code"}
        </Button>
      </form>
    </>
  );
}
