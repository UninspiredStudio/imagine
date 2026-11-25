import { Alert } from "@imagine/components/components/Alert";
import { Button } from "@imagine/components/components/Button";
import { LinkButton } from "@imagine/components/components/LinkButton";
import { FeatherAlertCircle, FeatherClockAlert, FeatherRefreshCw, FeatherShieldAlert } from "@subframe/core";
import { useId, useRef, useState, type ChangeEvent } from "react";
import {
  LOCKOUT_MS,
  OTP_LENGTH,
  RESEND_COOLDOWN_MS,
  formatCountdown,
  sendSignInCode,
  useSecondsUntil,
  verifySignInCode,
  type OtpFailure,
} from "../lib/otp";

type CodeStepProps = {
  email: string;
  onChangeEmail: () => void;
  onSignedIn: () => void;
};

// The six boxes only display the code. One real input behind them takes typing, paste and autofill.
// It submits itself once six digits are entered.
export function CodeStep({ email, onChangeEmail, onSignedIn }: CodeStepProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [failure, setFailure] = useState<OtpFailure | null>(null);
  const [resendAt, setResendAt] = useState(() => Date.now() + RESEND_COOLDOWN_MS);
  const resendIn = useSecondsUntil(resendAt);

  const codeLocked = failure === "expired" || failure === "too-many";
  const caretIndex = focused && failure === null ? code.length : -1;

  async function verify(otp: string) {
    setVerifying(true);
    const result = await verifySignInCode(email, otp);
    if (result === null) {
      onSignedIn();
      return;
    }
    setVerifying(false);
    setFailure(result);
    setCode(result === "invalid" || result === "failed" ? otp : "");
    if (result === "too-many") setResendAt(Date.now() + LOCKOUT_MS);
  }

  async function resend() {
    const outcome = await sendSignInCode(email);
    if (outcome.kind === "rate-limited") {
      setResendAt(Date.now() + outcome.retryAfterSeconds * 1000);
    } else if (outcome.kind === "failed") {
      setFailure("failed");
    } else {
      setCode("");
      setFailure(null);
      setResendAt(Date.now() + RESEND_COOLDOWN_MS);
      inputRef.current?.focus();
    }
  }

  function handleCodeChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH);
    setCode(next);
    setFailure(null);
    if (next.length === OTP_LENGTH) void verify(next);
  }

  function boxClass(index: number) {
    let tone = "border-neutral-border bg-default-background";
    if (failure === "invalid" || failure === "failed") tone = "border-error-600 bg-default-background";
    else if (failure === "too-many") tone = "border-neutral-200 bg-neutral-100";
    else if (index === caretIndex) tone = "border-brand-primary bg-default-background";
    return `flex h-12 grow shrink-0 basis-0 items-center justify-center rounded-md border border-solid ${tone}`;
  }

  return (
    <>
      <div className="flex w-full flex-col items-start gap-1">
        <h1 className="text-heading-2 font-heading-2 text-default-font">Check your email</h1>
        <span className="text-body font-body text-subtext-color">
          If this email has access, we sent a 6-digit code to
        </span>
        <div className="flex w-full flex-wrap items-center gap-2">
          <span className="text-body-bold font-body-bold text-default-font">{email}</span>
          <LinkButton variant="brand" size="small" onClick={onChangeEmail}>
            Change email
          </LinkButton>
        </div>
      </div>
      {failure === "expired" ? (
        <Alert
          role="alert"
          variant="warning"
          icon={<FeatherClockAlert />}
          title="This code has expired"
          description="Codes are valid for 10 minutes. Send a new one to continue."
        />
      ) : null}
      {failure === "too-many" ? (
        <Alert
          role="alert"
          variant="error"
          icon={<FeatherShieldAlert />}
          title="Too many incorrect codes"
          description="For your security, request a new code in 5 minutes."
        />
      ) : null}
      <div className="flex w-full flex-col items-start gap-2">
        <label
          htmlFor={inputId}
          className={`text-caption-bold font-caption-bold ${
            failure === "too-many" ? "text-subtext-color" : "text-default-font"
          }`}
        >
          Code
        </label>
        <div className="relative flex w-full items-center gap-2">
          {Array.from({ length: OTP_LENGTH }, (_, index) => (
            <div key={index} aria-hidden="true" className={boxClass(index)}>
              {code[index] ? (
                <span className="text-heading-2 font-heading-2 text-default-font">{code[index]}</span>
              ) : index === caretIndex ? (
                <div className="flex h-6 w-px flex-none items-start bg-brand-600" />
              ) : null}
            </div>
          ))}
          <input
            id={inputId}
            ref={inputRef}
            value={code}
            onChange={handleCodeChange}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            readOnly={verifying || codeLocked}
            aria-invalid={failure === "invalid"}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={OTP_LENGTH}
            className="absolute inset-0 h-full w-full cursor-text opacity-0"
          />
        </div>
        {failure === "invalid" || failure === "failed" ? (
          <div role="alert" className="flex w-full items-center gap-1.5">
            <FeatherAlertCircle className="text-caption font-caption text-error-700" />
            <span className="text-caption font-caption text-error-700">
              {failure === "invalid"
                ? "That code isn't right. Check the email and try again."
                : "Something went wrong. Try again."}
            </span>
          </div>
        ) : failure === null ? (
          <span className="text-caption font-caption text-subtext-color">
            Paste works too. We&apos;ll sign you in automatically.
          </span>
        ) : null}
      </div>
      {failure === "expired" ? (
        <Button
          className="h-10 w-full flex-none"
          size="large"
          icon={<FeatherRefreshCw />}
          disabled={resendIn > 0}
          onClick={() => void resend()}
        >
          {resendIn > 0 ? `Try again in ${resendIn}s` : "Send a new code"}
        </Button>
      ) : (
        <div className="flex w-full items-center gap-1 border-t border-solid border-neutral-border pt-4">
          <span className="text-caption font-caption text-subtext-color">
            {failure === "too-many" ? "Need a new code?" : "Didn't get it?"}
          </span>
          <LinkButton variant="brand" size="small" disabled={resendIn > 0} onClick={() => void resend()}>
            {resendIn > 0 ? `Resend code in ${formatCountdown(resendIn)}` : "Resend code"}
          </LinkButton>
        </div>
      )}
    </>
  );
}
