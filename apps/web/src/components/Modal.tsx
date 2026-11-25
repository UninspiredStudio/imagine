import { Button } from "@imagine/components/components/Button";
import { Dialog } from "@imagine/components/components/Dialog";
import type { ReactNode } from "react";

// `onClose` runs on Escape, an outside click or Cancel. Leave it out for a dialog that closes only through its own action.
export function Modal({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  onClose?: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog open title={title} className="bg-scrim px-4" onOpenChange={(open) => !open && onClose?.()}>
      <Dialog.Content className={`w-full gap-5 rounded-lg px-6 py-6 ${wide ? "max-w-[520px]" : "max-w-[460px]"}`}>
        {children}
      </Dialog.Content>
    </Dialog>
  );
}

export function ModalActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full items-center justify-end gap-2 pt-1 mobile:flex-col-reverse mobile:items-stretch">
      {children}
    </div>
  );
}

const ICON_TONES = {
  success: "bg-success-50 text-success-700",
  neutral: "bg-neutral-100 text-secondary-font",
  error: "bg-error-50 text-error-700",
};

export function ModalHeading({
  icon,
  tone,
  title,
  description,
}: {
  icon: ReactNode;
  tone: keyof typeof ICON_TONES;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex w-full flex-col items-start gap-3">
      <div
        className={`flex h-10 w-10 flex-none items-center justify-center rounded-lg text-heading-3 font-heading-3 ${ICON_TONES[tone]}`}
      >
        {icon}
      </div>
      <div className="flex flex-col items-start gap-1">
        <h2 className="text-heading-3 font-heading-3 text-default-font break-words">{title}</h2>
        {description ? <span className="text-body font-body text-secondary-font">{description}</span> : null}
      </div>
    </div>
  );
}

export function ConfirmModal({
  icon,
  tone,
  title,
  description,
  confirm,
  destructive = false,
  pending,
  blocked = false,
  onConfirm,
  onClose,
  children,
}: {
  icon: ReactNode;
  tone: keyof typeof ICON_TONES;
  title: string;
  description?: string;
  confirm: { label: string; icon: ReactNode };
  destructive?: boolean;
  pending: boolean;
  // Keeps the confirm button disabled, for a dialog that asks for something first.
  blocked?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <ModalHeading icon={icon} tone={tone} title={title} description={description} />
      {children}
      <ModalActions>
        <Button className="mobile:w-full" variant="neutral-secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          className="mobile:w-full"
          variant={destructive ? "destructive-primary" : "brand-primary"}
          icon={confirm.icon}
          loading={pending}
          disabled={pending || blocked}
          onClick={onConfirm}
        >
          {confirm.label}
        </Button>
      </ModalActions>
    </Modal>
  );
}
