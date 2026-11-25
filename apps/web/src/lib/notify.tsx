import { IconButton } from "@imagine/components/components/IconButton";
import { Toast } from "@imagine/components/components/Toast";
import { FeatherAlertCircle, FeatherCheckCircle, FeatherX, toast } from "@subframe/core";

function notify(variant: "success" | "error", title: string, description?: string) {
  toast.custom((id) => (
    <Toast
      className="border border-solid border-neutral-border mobile:w-full"
      variant={variant}
      icon={variant === "success" ? <FeatherCheckCircle /> : <FeatherAlertCircle />}
      title={title}
      description={description}
      actions={<IconButton size="small" icon={<FeatherX />} aria-label="Dismiss" onClick={() => toast.dismiss(id)} />}
    />
  ));
}

export const notifySuccess = (title: string, description?: string) => notify("success", title, description);

// For a mutation's onError.
export const notifyFailure = (title: string) => (error: Error) => notify("error", title, error.message);

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notifySuccess("Copied to clipboard");
  } catch {
    // Clipboard access needs HTTPS or localhost, and the user can refuse it.
    notify("error", "Couldn't copy", "Select the text and copy it yourself.");
  }
}
