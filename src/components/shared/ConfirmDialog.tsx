import { useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Dialog } from "radix-ui";

export type ConfirmationOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
};

type ConfirmDialogProps = ConfirmationOptions & {
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Confirmation prompt. Built on Radix Dialog so focus trapping, scroll
 * locking, Esc handling and `aria-modal` wiring come from the primitive
 * instead of the hand-rolled Tab cycle this component used to carry.
 *
 * Rendered only while a confirmation is pending (see App.tsx), so the dialog
 * is permanently `open`; dismissal is reported through `onOpenChange` rather
 * than by toggling local state.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        // Covers Esc, overlay click and the close button in one place.
        if (!next) onCancel();
      }}
    >
      <Dialog.Portal>
        {/* Radix portals to document.body. The legacy overlay used
            `position: absolute` inside .app-container, which is unpositioned
            and exactly 100vw/100vh — so switching to a fixed body-level
            overlay is visually identical. */}
        <Dialog.Overlay className="dialog-overlay confirm-overlay" />
        <Dialog.Content
          className="dialog-panel confirm-dialog"
          role="alertdialog"
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            confirmButtonRef.current?.focus();
          }}
        >
          <div className="confirm-dialog-header">
            <span className={`confirm-dialog-icon ${danger ? "danger" : ""}`}>
              <AlertTriangle size={18} />
            </span>
            <Dialog.Title className="confirm-dialog-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="settings-close-button" aria-label={cancelLabel}>
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="confirm-dialog-message">
            {message}
          </Dialog.Description>
          <div className="confirm-dialog-actions">
            <button type="button" className="btn" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={`btn confirm-dialog-submit ${danger ? "danger" : ""}`}
              onClick={onConfirm}
              ref={confirmButtonRef}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
