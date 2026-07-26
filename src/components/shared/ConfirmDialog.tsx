import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";

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

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => dialog.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="modal-overlay confirm-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <div
        ref={dialogRef}
        className="modal-content confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-header">
          <span className={`confirm-dialog-icon ${danger ? "danger" : ""}`}>
            <AlertTriangle size={18} />
          </span>
          <h3 id="confirm-dialog-title">{title}</h3>
          <button type="button" className="settings-close-button" onClick={onCancel} aria-label={cancelLabel}>
            <X size={16} />
          </button>
        </div>
        <p id="confirm-dialog-message" className="confirm-dialog-message">{message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
          <button
            type="button"
            className={`btn confirm-dialog-submit ${danger ? "danger" : ""}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
