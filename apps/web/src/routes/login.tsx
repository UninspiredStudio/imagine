import { Badge } from "@imagine/components/components/Badge";
import { Button } from "@imagine/components/components/Button";
import { TextField } from "@imagine/components/components/TextField";
import { FeatherMail, FeatherSparkles } from "@subframe/core";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard } from "../components/AuthCard";
import { CodeStep } from "../components/CodeStep";
import { SendCodeAlert } from "../components/SendCodeAlert";
import { metaQueryOptions } from "../lib/api";
import { authClient } from "../lib/auth";
import { EMAIL_ERROR, isEmail } from "../lib/email";
import { useSendSignInCode } from "../lib/otp";

function validateEmail({ value }: { value: string }) {
  return isEmail(value) ? undefined : EMAIL_ERROR;
}

// Only same-site paths. Anything else would let the login page redirect to another site.
function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : undefined;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(search.redirect),
  }),
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (data) throw redirect({ to: "/" });
  },
  loader: ({ context }) => context.queryClient.query({ ...metaQueryOptions, staleTime: "static" }),
  component: LoginPage,
});

function LoginPage() {
  const { redirect: redirectTo } = Route.useSearch();
  const navigate = useNavigate();
  const { data: meta } = useQuery(metaQueryOptions);
  // The email outlives the email step, so "Change email" brings it back.
  const [email, setEmail] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const needsSetup = meta?.needsSetup ?? false;

  return (
    <AuthCard
      footer={
        <span className="max-w-[400px] text-caption font-caption text-subtext-color text-center">
          {needsSetup
            ? "This screen disappears once the first account exists."
            : "Access is invite-only. Ask an admin of this registry for an invite."}
        </span>
      }
    >
      {codeSent ? (
        <CodeStep
          email={email}
          onChangeEmail={() => setCodeSent(false)}
          onSignedIn={() => navigate({ href: redirectTo ?? "/" })}
        />
      ) : (
        <EmailStep
          defaultEmail={email}
          needsSetup={needsSetup}
          onSent={(sent) => {
            setEmail(sent);
            setCodeSent(true);
          }}
        />
      )}
    </AuthCard>
  );
}

function EmailStep({
  defaultEmail,
  needsSetup,
  onSent,
}: {
  defaultEmail: string;
  needsSetup: boolean;
  onSent: (email: string) => void;
}) {
  const { send, sending, retryIn, failed } = useSendSignInCode(onSent);
  const form = useForm({
    defaultValues: { email: defaultEmail },
    onSubmit: ({ value }) => send(value.email.trim()),
  });

  return (
    <>
      {needsSetup ? (
        <div className="flex w-full flex-col items-start gap-2">
          <Badge className="rounded-full" variant="brand" icon={<FeatherSparkles />}>
            New registry
          </Badge>
          <div className="flex w-full flex-col items-start gap-1">
            <h1 className="text-heading-2 font-heading-2 text-default-font">Set up Imagine</h1>
            <span className="text-body font-body text-subtext-color">
              This registry has no users yet. The first account becomes the admin and can invite everyone else.
            </span>
          </div>
        </div>
      ) : (
        <div className="flex w-full flex-col items-start gap-1">
          <h1 className="text-heading-2 font-heading-2 text-default-font">Sign in</h1>
          <span className="text-body font-body text-subtext-color">
            Enter your email and we&apos;ll send you a sign-in code.
          </span>
        </div>
      )}
      <SendCodeAlert retryIn={retryIn} failed={failed} />
      <form
        noValidate
        className="flex w-full flex-col items-start gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <form.Field name="email" validators={{ onChange: validateEmail, onSubmit: validateEmail }}>
          {(field) => {
            const invalid =
              !field.state.meta.isValid && (field.state.meta.isTouched || form.state.submissionAttempts > 0);
            return (
              <TextField
                className="h-auto w-full flex-none"
                label="Email"
                error={invalid}
                helpText={invalid ? EMAIL_ERROR : ""}
                icon={<FeatherMail />}
              >
                <TextField.Input
                  name={field.name}
                  type="email"
                  autoComplete="email"
                  placeholder="you@acme.dev"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={invalid}
                />
              </TextField>
            );
          }}
        </form.Field>
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
