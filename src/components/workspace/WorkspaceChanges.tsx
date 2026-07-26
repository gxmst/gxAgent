import { Check, GitBranch, RefreshCw, RotateCcw, Undo2 } from "lucide-react";

export interface GitStatusEntry {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath?: string | null;
}

const statusLabel = (entry: GitStatusEntry) => {
  const status = entry.worktreeStatus.trim() || entry.indexStatus.trim() || "?";
  if (status === "M") return "M";
  if (status === "A" || status === "?") return "A";
  if (status === "D") return "D";
  if (status === "R") return "R";
  return status;
};

export function WorkspaceChanges({
  lang,
  branch,
  entries,
  selectedPath,
  diff,
  loading,
  error,
  checkpointAvailable,
  actionsDisabled,
  onSelect,
  onRefresh,
  onRestorePath,
  onRestoreCheckpoint,
  onAcceptCheckpoint,
}: {
  lang: string;
  branch: string;
  entries: GitStatusEntry[];
  selectedPath?: string | null;
  diff?: string;
  loading?: boolean;
  error?: string;
  checkpointAvailable?: boolean;
  actionsDisabled?: boolean;
  onSelect: (entry: GitStatusEntry) => void;
  onRefresh: () => void;
  onRestorePath: (entry: GitStatusEntry) => void;
  onRestoreCheckpoint?: () => void;
  onAcceptCheckpoint?: () => void;
}) {
  const zh = lang === "zh";
  return (
    <section className="workspace-changes" aria-label={zh ? "工作区变更" : "Workspace changes"}>
      <header className="workspace-changes-header">
        <span title={branch || (zh ? "未识别分支" : "No branch")}><GitBranch size={13} /> {branch || (zh ? "未识别分支" : "No branch")}</span>
        <div>
          {checkpointAvailable && onRestoreCheckpoint && (
            <button disabled={actionsDisabled} onClick={onRestoreCheckpoint} title={zh ? "恢复本轮" : "Restore run"}><Undo2 size={13} /></button>
          )}
          {checkpointAvailable && onAcceptCheckpoint && (
            <button disabled={actionsDisabled} onClick={onAcceptCheckpoint} title={zh ? "保留本轮改动" : "Keep run changes"}><Check size={13} /></button>
          )}
          <button onClick={onRefresh} title={zh ? "刷新" : "Refresh"}><RefreshCw size={13} /></button>
        </div>
      </header>
      {loading ? (
        <div className="workspace-change-state">{zh ? "正在检查变更..." : "Checking changes..."}</div>
      ) : error ? (
        <div className="workspace-change-state error">{error}</div>
      ) : entries.length === 0 ? (
        <div className="workspace-change-state">{zh ? "工作区没有未提交变更" : "No uncommitted changes"}</div>
      ) : (
        <div className="workspace-change-layout">
          <div className="workspace-change-list">
            {entries.map((entry) => (
              <div key={`${entry.path}-${entry.indexStatus}-${entry.worktreeStatus}`} className={`workspace-change-row ${selectedPath === entry.path ? "active" : ""}`}>
                <button className="workspace-change-main" onClick={() => onSelect(entry)} title={entry.path}>
                  <span className={`workspace-change-status status-${statusLabel(entry)}`}>{statusLabel(entry)}</span>
                  <span>{entry.path}</span>
                </button>
                <button disabled={actionsDisabled} className="workspace-change-restore" onClick={() => onRestorePath(entry)} title={zh ? "恢复文件" : "Restore file"}>
                  <RotateCcw size={12} />
                </button>
              </div>
            ))}
          </div>
          {selectedPath && (
            <pre className="workspace-change-diff"><code>{diff || (zh ? "正在读取差异..." : "Loading diff...")}</code></pre>
          )}
        </div>
      )}
    </section>
  );
}
