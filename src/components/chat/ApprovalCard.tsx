/**
 * Pending tool-approval card: lists the tool calls awaiting user consent and
 * offers approve / approve-and-trust / reject. Rendered inline under the
 * message that owns the pending actions and as a dock above the composer.
 *
 * Extracted verbatim from App.tsx. Approval state lives in the zustand store;
 * the global config (for the trust whitelist) still lives in App and flows in
 * through props.
 */
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import { t } from "../../i18n";
import type { AppConfig, Message, PendingApproval, TrustedPattern } from "../../types";
import { suggestTrustPatterns } from "../../utils/trustPatterns";
import { useAppStore } from "../../store/appStore";
import { addLog } from "../../services/agentEvents";

/** True when one of the message's tool actions is part of the pending approval. */
export const messageHasPendingApproval = (message: Message, pendingApprovals: PendingApproval | null) => Boolean(
  pendingApprovals
  && message.actions?.some((action) => pendingApprovals.tool_calls.some((tc) => tc.id === action.id)),
);

export interface ApprovalCardProps {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  className?: string;
}

export function ApprovalCard({ lang, config, setConfig, className = "" }: ApprovalCardProps) {
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const pendingApprovals = useAppStore((s) => s.pendingApprovalsBySession[s.currentSessionId] || null);
  const setPendingApprovalsBySession = useAppStore((s) => s.setPendingApprovalsBySession);
  const approvalSubmitting = useAppStore((s) => Boolean(s.approvalSubmittingBySession[s.currentSessionId]));
  const setApprovalSubmittingBySession = useAppStore((s) => s.setApprovalSubmittingBySession);

  const handleApproval = async (approved: boolean, trustPattern: boolean = false) => {
    if (!pendingApprovals || approvalSubmitting) return;
    const sessionId = currentSessionId;
    setApprovalSubmittingBySession((previous) => ({ ...previous, [sessionId]: true }));
    const approvedIds = approved
      ? pendingApprovals.tool_calls.map((tc) => tc.id)
      : [];
    const rejectedIds = approved
      ? []
      : pendingApprovals.tool_calls.map((tc) => tc.id);

    try {
      await invoke("resolve_tool_approval", {
        requestId: pendingApprovals.request_id,
        approvedIds,
        rejectedIds,
      });
      setPendingApprovalsBySession((previous) => ({ ...previous, [sessionId]: null }));

      // If approved with trust, add each tool call's suggested patterns to
      // the whitelist. Compound commands contribute one pattern per segment
      // so the backend's per-segment matching approves them next time.
      if (approved && trustPattern) {
        const now = Math.floor(Date.now() / 1000);
        const seen = new Set<string>();
        const newPatterns: TrustedPattern[] = pendingApprovals.tool_calls.flatMap((tc) =>
          suggestTrustPatterns(tc.name, tc.arguments)
            .filter((pattern) => {
              const key = `${tc.name}\u0000${pattern}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((pattern) => ({ tool_name: tc.name, pattern, created_at: now })),
        );

        try {
          const updatedConfig = await invoke<AppConfig>("add_trusted_patterns", {
            currentConfig: config,
            patterns: newPatterns,
          });
          setConfig(updatedConfig);
          addLog(`Added ${newPatterns.length} pattern(s) to whitelist`, "success");
        } catch (e) {
          addLog(`Failed to add whitelist patterns: ${e}`, "error");
        }
      }
    } catch (e) {
      addLog(`Approval error: ${e}`, "error");
    } finally {
      setApprovalSubmittingBySession((previous) => ({ ...previous, [sessionId]: false }));
    }
  };

  if (!pendingApprovals) return null;
  const trustPreview = [...new Set(
    pendingApprovals.tool_calls.flatMap((tc) => suggestTrustPatterns(tc.name, tc.arguments)),
  )].join(", ");
  return (
    <div className={`approval-card ${className}`.trim()}>
      <div className="approval-card-header">
        <ShieldAlert size={14} />
        <span>{t("approval.title", lang)}</span>
      </div>
      {pendingApprovals.tool_calls.map((tc) => (
        <div key={tc.id} className="approval-item">
          <span style={{ fontWeight: 600, color: "var(--accent)", fontSize: "var(--font-small)" }}>{tc.name}</span>
          <pre style={{ fontSize: "var(--font-caption)", color: "var(--text-secondary)", marginTop: 3, whiteSpace: "pre-wrap" }}>
            {tc.arguments}
          </pre>
        </div>
      ))}
      <div className="approval-trust-preview">
        {t("approval.trustPreview", lang, { patterns: trustPreview })}
      </div>
      <div className="approval-actions">
        <button className="btn btn-approve" disabled={approvalSubmitting} onClick={() => handleApproval(true)}>
          <CheckCircle2 size={13} /> {t("approval.approve", lang)}
        </button>
        <button className="btn btn-approve-trust" disabled={approvalSubmitting} onClick={() => handleApproval(true, true)} title={t("approval.trustHint", lang)}>
          <ShieldAlert size={13} /> {t("approval.approveAndTrust", lang)}
        </button>
        <button className="btn btn-reject" disabled={approvalSubmitting} onClick={() => handleApproval(false)}>
          <XCircle size={13} /> {t("approval.reject", lang)}
        </button>
      </div>
    </div>
  );
}
