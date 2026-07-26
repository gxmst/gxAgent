/**
 * Global toast notifications, rendered at the top of the app container.
 *
 * Extracted verbatim from App.tsx. Toast state lives entirely in the zustand
 * store, so this component takes no props.
 */
import { useAppStore } from "../../store/appStore";

export function ToastStack() {
  const toasts = useAppStore((s) => s.toasts);
  const setToasts = useAppStore((s) => s.setToasts);

  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast-item ${toast.type === "cmd" ? "info" : toast.type}`}>
          <span className="toast-dot" />
          <span className="toast-text">{toast.text}</span>
          {toast.actionLabel && toast.onAction && (
            <button type="button" className="toast-action" onClick={() => {
              setToasts((previous) => previous.filter((item) => item.id !== toast.id));
              toast.onAction?.();
            }}>
              {toast.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
