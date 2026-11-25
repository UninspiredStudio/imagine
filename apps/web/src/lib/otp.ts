import { useEffect, useState } from "react";
import { authClient } from "./auth";

export const OTP_LENGTH = 6;
export const RESEND_COOLDOWN_MS = 30_000;
export const LOCKOUT_MS = 5 * 60_000;

// The server copies the wait from the 429 headers into the body as retryAfter. 60s if it is missing.
// Read it in an onError hook once createAuthClient exposes one.
const RATE_LIMIT_FALLBACK_SECONDS = 60;

export type OtpFailure = "invalid" | "expired" | "too-many" | "failed";

// The one place that maps emailOTP verify errors to UI states. Adjust the codes here if the server changes them.
export function otpFailure(error: { code?: string; status: number }): OtpFailure {
  switch (error.code) {
    case "INVALID_OTP":
      return "invalid";
    case "OTP_EXPIRED":
      return "expired";
    case "TOO_MANY_ATTEMPTS":
      return "too-many";
    default:
      return error.status === 429 ? "too-many" : "failed";
  }
}

export type SendOutcome =
  | { kind: "sent" }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "failed" };

function retryAfterFrom(error: object): number {
  const seconds = (error as { retryAfter?: unknown }).retryAfter;
  return typeof seconds === "number" && seconds > 0 ? seconds : RATE_LIMIT_FALLBACK_SECONDS;
}

// The server answers "sent" for unknown emails too, so this never reveals whether an address has access.
export async function sendSignInCode(email: string): Promise<SendOutcome> {
  const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
  if (!error) return { kind: "sent" };
  if (error.status === 429) return { kind: "rate-limited", retryAfterSeconds: retryAfterFrom(error) };
  return { kind: "failed" };
}

// Resolves to null when the code signed the user in.
export async function verifySignInCode(email: string, otp: string): Promise<OtpFailure | null> {
  const { error } = await authClient.signIn.emailOtp({ email, otp });
  return error ? otpFailure(error) : null;
}

// Whole seconds left until `untilMs` (epoch milliseconds). Re-renders once a second until the deadline passes.
export function useSecondsUntil(untilMs: number | null): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (untilMs === null || untilMs <= Date.now()) return;
    const id = setInterval(() => {
      setTick((tick) => tick + 1);
      if (Date.now() >= untilMs) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [untilMs]);
  return untilMs === null ? 0 : Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

export function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Send-code state shared by the login and invite steps. A rate limit disables the button until the retry time.
// Any other failure is reported through `failed`.
export function useSendSignInCode(onSent: (email: string) => void) {
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const retryIn = useSecondsUntil(retryAt);

  async function send(email: string) {
    setSending(true);
    const outcome = await sendSignInCode(email);
    setSending(false);
    setFailed(outcome.kind === "failed");
    if (outcome.kind === "rate-limited") setRetryAt(Date.now() + outcome.retryAfterSeconds * 1000);
    if (outcome.kind === "sent") onSent(email);
  }

  return { send, sending, retryIn, failed };
}
