import { Alert } from "@imagine/components/components/Alert";
import { FeatherAlertCircle, FeatherClockAlert } from "@subframe/core";

// Shown above the send-code button. A rate limit counts down live in a polite region.
export function SendCodeAlert({ retryIn, failed }: { retryIn: number; failed: boolean }) {
  if (retryIn > 0) {
    return (
      <Alert
        variant="warning"
        icon={<FeatherClockAlert />}
        title="Too many attempts"
        description={`Try again in ${retryIn} ${retryIn === 1 ? "second" : "seconds"}.`}
        aria-live="polite"
      />
    );
  }
  if (failed) {
    return (
      <Alert
        variant="error"
        icon={<FeatherAlertCircle />}
        title="We couldn't send the code"
        description="Check your connection and try again."
        role="alert"
      />
    );
  }
  return null;
}
