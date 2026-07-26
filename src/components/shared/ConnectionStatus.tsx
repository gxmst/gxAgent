import { AlertCircle, CheckCircle2, Loader2, Plug } from "lucide-react";

export type ConnectionState = "unconfigured" | "configured" | "checking" | "ready" | "error";

export function ConnectionStatus({
  state,
  label,
  detail,
  compact = false,
  onClick,
}: {
  state: ConnectionState;
  label: string;
  detail?: string;
  compact?: boolean;
  onClick?: () => void;
}) {
  const icon = state === "ready"
    ? <CheckCircle2 size={13} />
    : state === "checking"
      ? <Loader2 size={13} className="animate-spin" />
      : state === "error"
        ? <AlertCircle size={13} />
        : <Plug size={13} />;
  const content = (
    <>
      {icon}
      {!compact && <span>{label}</span>}
    </>
  );

  return onClick ? (
    <button
      type="button"
      className={`connection-status ${state} ${compact ? "compact" : ""}`}
      title={detail || label}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <span className={`connection-status ${state} ${compact ? "compact" : ""}`} title={detail || label} role="status">
      {content}
    </span>
  );
}
