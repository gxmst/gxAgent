import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Archive, RefreshCw, RotateCcw } from "lucide-react";
import type { ChatSession } from "../../types";
import { normalizeSessions } from "../../appDefaults";
import { useAppStore } from "../../store/appStore";
import type { ConfirmationOptions } from "../shared/ConfirmDialog";

type Backup = {
  id: string;
  sessionId: string;
  title: string;
  createdAt: number;
  bytes: number;
};
export function BackupSettings({
  lang,
  disabled,
  hasAttachmentLoading,
  createSnapshot,
  requestConfirmation,
}: {
  lang: string;
  disabled: boolean;
  hasAttachmentLoading: boolean;
  createSnapshot: () => Promise<void>;
  requestConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
}) {
  const zh = lang === "zh";
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [issues, setIssues] = useState<{ sessionId: string; error: string }[]>(
    [],
  );
  const running = useAppStore((s) =>
    Boolean(s.activeRunSessionId || s.preparingRequestSessionId),
  );
  const reload = async () => {
    setBusy(true);
    setError("");
    try {
      const [list, problems] = await Promise.all([
        invoke<Backup[]>("list_session_backups"),
        invoke<typeof issues>("session_storage_issues"),
      ]);
      setBackups(list);
      setIssues(problems);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  const restore = async (backup: Backup) => {
    if (
      !(await requestConfirmation({
        title: zh ? "恢复会话副本" : "Restore task copy",
        message: `${backup.title}\n${new Date(backup.createdAt).toLocaleString()}`,
        confirmLabel: zh ? "恢复副本" : "Restore copy",
        cancelLabel: zh ? "取消" : "Cancel",
      }))
    )
      return;
    if (
      useAppStore.getState().activeRunSessionId ||
      useAppStore.getState().preparingRequestSessionId
    )
      return;
    setBusy(true);
    setError("");
    try {
      const raw = await invoke<ChatSession>("read_session_backup", {
        sessionId: backup.sessionId,
        backupId: backup.id,
      });
      const session = normalizeSessions([raw])[0];
      await invoke("save_session", { session });
      useAppStore.getState().setSessions((previous) => [session, ...previous]);
      useAppStore.getState().setCurrentSessionId(session.id);
      setStatus(zh ? "已恢复会话副本" : "Task copy restored");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="lab-section">
      <div className="lab-toolbar">
        <h4>{zh ? "会话快照" : "Task snapshots"}</h4>
        <button
          className="btn"
          disabled={busy || disabled}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await createSnapshot();
              await reload();
              setStatus(zh ? "快照已创建" : "Snapshots created");
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Archive size={14} />
          {zh ? "创建快照" : "Create snapshot"}
        </button>
        <button
          className="panel-toggle-btn"
          disabled={busy}
          title={zh ? "刷新快照" : "Refresh snapshots"}
          aria-label={zh ? "刷新快照" : "Refresh snapshots"}
          onClick={() => void reload()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {error && (
        <p role="alert" className="lab-error">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {!busy && !backups.length && (
        <p className="lab-muted">{zh ? "暂无快照" : "No snapshots"}</p>
      )}
      {issues.map((issue) => (
        <p role="alert" className="lab-error" key={issue.sessionId}>
          {issue.sessionId}: {issue.error}
        </p>
      ))}
      <div className="backup-list">
        {backups.map((b) => (
          <div className="lab-row" key={`${b.sessionId}:${b.id}`}>
            <div>
              <strong>{b.title || b.sessionId}</strong>
              <small>
                {new Date(b.createdAt).toLocaleString()} ·{" "}
                {Math.ceil(b.bytes / 1024)} KB
              </small>
            </div>
            {issues.some((issue) => issue.sessionId === b.sessionId) ? (
              <button
                className="btn"
                disabled={busy || running || hasAttachmentLoading}
                onClick={async () => {
                  if (
                    !(await requestConfirmation({
                      title: zh ? "修复损坏会话" : "Repair damaged task",
                      message: b.title,
                      confirmLabel: zh ? "从快照修复" : "Repair from snapshot",
                      cancelLabel: zh ? "取消" : "Cancel",
                    }))
                  )
                    return;
                  if (
                    useAppStore.getState().activeRunSessionId ||
                    useAppStore.getState().preparingRequestSessionId
                  )
                    return;
                  setBusy(true);
                  setError("");
                  try {
                    await invoke("repair_session_backup", {
                      sessionId: b.sessionId,
                      backupId: b.id,
                    });
                    window.dispatchEvent(
                      new Event("gx-session-storage-repaired"),
                    );
                    await reload();
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RotateCcw size={14} />
                {zh ? "修复会话" : "Repair task"}
              </button>
            ) : (
              <button
                className="btn"
                disabled={busy || disabled}
                onClick={() => void restore(b)}
              >
                <RotateCcw size={14} />
                {zh ? "恢复副本" : "Restore copy"}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
