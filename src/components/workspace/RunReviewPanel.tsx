import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createTwoFilesPatch } from "diff";
import { Check, FileCode2, GitCompareArrows, Loader2, RefreshCw, Undo2 } from "lucide-react";
import type { RunCheckpoint, WorkspaceViewState } from "../../appDefaults";
import type { ModifiedFileEntry } from "../../store/appStore";
import type { GitStatusEntry } from "./WorkspaceChanges";
import { WorkspaceChanges } from "./WorkspaceChanges";
import { UnifiedDiff } from "./UnifiedDiff";

export interface RunChange { path: string; status: string; diff: string; truncated?: boolean }
interface RunReview { repositoryRoot: string; version: string; entries: RunChange[] }

export function RunReviewPanel({ lang, checkpoint, workspace, modifiedFiles, disabled, onRefresh, onSelectGit, onRestoreGit, onKeep, onRestore }: {
  lang: string;
  checkpoint: RunCheckpoint | null;
  workspace: WorkspaceViewState;
  modifiedFiles: Record<string, ModifiedFileEntry>;
  disabled: boolean;
  onRefresh: () => void;
  onSelectGit: (entry: GitStatusEntry) => void;
  onRestoreGit: (entry: GitStatusEntry) => void;
  onKeep: () => void;
  onRestore: () => void;
}) {
  const zh = lang === "zh";
  const [scope, setScope] = useState<"run" | "workspace">("run");
  const [review, setReview] = useState<RunReview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, string>>({});
  useEffect(() => { setReviewed({}); setSelectedPath(null); setReview(null); }, [checkpoint?.reference]);
  useEffect(() => {
    let cancelled = false;
    if (!checkpoint) { setReview(null); setLoading(false); setError(""); return; }
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      void invoke<RunReview>("get_git_run_review", { workDir: checkpoint.workDir, reference: checkpoint.reference })
        .then(result => { if (!cancelled) setReview(result); })
        .catch(reason => { if (!cancelled) { setError(String(reason)); setReview(null); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, disabled ? 500 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [checkpoint?.reference, checkpoint?.workDir, workspace.entries, disabled]);

  const entries = useMemo<RunChange[]>(() => checkpoint ? review?.entries || [] : Object.entries(modifiedFiles)
    .filter(([, file]) => file.old !== file.new)
    .map(([path, file]) => ({ path, status: "M", diff: createTwoFilesPatch(path, path, file.old, file.new) })), [checkpoint, review, modifiedFiles]);
  const selected = entries.find(entry => entry.path === selectedPath) || entries[0];
  const reviewedCount = entries.filter(entry => reviewed[entry.path] === entry.diff).length;

  return <div className="run-review-panel">
    <div className="review-scope-bar">
      <div className="review-scope" role="group" aria-label={zh ? "改动范围" : "Change scope"}>
        <button aria-pressed={scope === "run"} onClick={() => setScope("run")}>{zh ? "本次运行" : "This run"}</button>
        <button aria-pressed={scope === "workspace"} onClick={() => setScope("workspace")}>{zh ? "工作区" : "Workspace"}</button>
      </div>
      <button className="panel-toggle-btn" disabled={loading || workspace.loading} onClick={onRefresh} aria-label={zh ? "刷新改动" : "Refresh changes"} title={zh ? "刷新改动" : "Refresh changes"}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
    </div>
    {scope === "workspace" ? <WorkspaceChanges lang={lang} branch={workspace.branch} entries={workspace.entries} selectedPath={workspace.selectedPath} diff={workspace.diff} loading={workspace.loading} error={workspace.changesError} actionsDisabled={disabled} onSelect={onSelectGit} onRefresh={onRefresh} onRestorePath={onRestoreGit} /> : <>
      <div className="review-baseline">{checkpoint ? (zh ? "与执行前快照比较" : "Compared with the pre-run snapshot") : entries.length ? (zh ? "文件工具记录；不含命令产生的改动" : "File tool changes; command changes are not included") : (zh ? "尚无运行快照" : "No run snapshot")}</div>
      {loading && <div className="workspace-inline-state" role="status"><Loader2 size={14} className="spin" />{zh ? "正在读取差异" : "Loading differences"}</div>}
      {error && <div className="workspace-inline-state error" role="alert">{error}<button className="btn" onClick={onRefresh}><RefreshCw size={13} />{zh ? "重试" : "Retry"}</button></div>}
      {!loading && !error && entries.length === 0 && <div className="workspace-empty-state"><GitCompareArrows size={27} /><span>{checkpoint ? (zh ? "本次运行没有文件改动" : "No file changes in this run") : (zh ? "暂无可审查的运行改动" : "No run changes to review")}</span><button className="btn" onClick={() => setScope("workspace")}>{zh ? "查看工作区" : "View workspace"}</button></div>}
      {entries.length > 0 && <>
        <div className="review-file-list" aria-label={zh ? "已改动文件" : "Changed files"}>
          {entries.map(entry => <button key={entry.path} className="review-file" aria-pressed={selected?.path === entry.path} onClick={() => setSelectedPath(entry.path)} title={entry.path}>
            <FileCode2 size={14} /><span>{entry.path}</span><small className={`change-kind ${entry.status}`}>{entry.status}</small>{reviewed[entry.path] === entry.diff && <Check size={13} className="review-check" />}
          </button>)}
        </div>
        {selected && <UnifiedDiff lang={lang} label={selected.path} diff={selected.diff} />}
        {selected?.truncated && <div className="workspace-inline-state">{zh ? "差异过大，仅显示前 1 MB" : "Diff exceeds 1 MB; showing a partial view"}</div>}
      </>}
      <div className="review-footer">
        <span>{reviewedCount} / {entries.length} {zh ? "已审查" : "reviewed"}</span>
        {selected && <button className="btn" disabled={loading || disabled || !!selected.truncated} onClick={() => setReviewed(previous => ({ ...previous, [selected.path]: previous[selected.path] === selected.diff ? "" : selected.diff }))}><Check size={13} />{reviewed[selected.path] === selected.diff ? (zh ? "取消标记" : "Unmark") : (zh ? "标记已审查" : "Mark reviewed")}</button>}
      </div>
      {checkpoint && <div className="review-checkpoint-actions">
        <button className="btn" disabled={disabled || loading} onClick={onRestore}><Undo2 size={13} />{zh ? "恢复执行前" : "Restore before run"}</button>
        <button className="btn" disabled={disabled || loading} onClick={onKeep}><Check size={13} />{zh ? "保留改动" : "Keep changes"}</button>
      </div>}
    </>}
  </div>;
}
