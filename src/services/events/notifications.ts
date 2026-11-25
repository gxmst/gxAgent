import { useAppStore } from "../../store/appStore";

const MAX_LOG_LINES = 500;
const store = () => useAppStore.getState();

export const notify = (
  text: string,
  type: "info" | "success" | "error" | "cmd" = "info",
  options?: { actionLabel?: string; onAction?: () => void; duration?: number },
) => {
  const id = Date.now() + Math.random();
  store().setToasts((prev) => [...prev.slice(-3), {
    id,
    text,
    type,
    actionLabel: options?.actionLabel,
    onAction: options?.onAction,
  }]);
  if (options?.duration !== 0) {
    window.setTimeout(() => {
      store().setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, options?.duration ?? 3200);
  }
};

export const addLog = (
  text: string,
  type: "info" | "success" | "error" | "cmd" = "info",
  showToast = false,
  sessionId = store().currentSessionId,
) => {
  store().setTerminalLogsBySession((previous) => {
    const next = [...(previous[sessionId] || []), { text, type }];
    return {
      ...previous,
      [sessionId]: next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next,
    };
  });
  if (showToast) notify(text, type);
};
