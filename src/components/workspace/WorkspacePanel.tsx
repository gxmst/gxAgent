import { FileCode2, RefreshCw, X } from "lucide-react";
import type { AppConfig, ChatSession } from "../../types";
import type { WorkspaceViewState } from "../../appDefaults";
import { useAppStore } from "../../store/appStore";
import { EMPTY_FILE_VIEW, useWorkspaceViewStore, type WorkspaceTab } from "../../store/workspaceViewStore";
import type { useWorkspaceActions } from "../../hooks/useWorkspaceActions";
import { WorkspaceTree } from "./WorkspaceTree";
import { RunReviewPanel } from "./RunReviewPanel";
import { RunActivity } from "./RunActivity";
import { HtmlPreview } from "./HtmlPreview";
import { ContextInspector } from "./ContextInspector";

const EMPTY_LOGS: never[] = [];
const EMPTY_CHANGES = {};
export interface WorkspacePanelProps {
  lang: string;
  config: AppConfig;
  session: ChatSession;
  open: boolean;
  width: number;
  onClose: () => void;
  workspace: WorkspaceViewState;
  onRefresh: () => void;
  actions: ReturnType<typeof useWorkspaceActions>;
  attachmentsLoading: boolean;
  disabled: boolean;
  selectedRunId?: string;
}

export function WorkspacePanel({ lang, config, session, open, width, onClose, workspace, onRefresh, actions, attachmentsLoading, disabled, selectedRunId }: WorkspacePanelProps) {
  const zh = lang === "zh";
  const sessionId = session.id;
  const activeTab = useWorkspaceViewStore(state => state.tabs[sessionId] || "changes");
  const setTab = useWorkspaceViewStore(state => state.setTab);
  const file = useWorkspaceViewStore(state => state.files[sessionId] || EMPTY_FILE_VIEW);
  const checkpoint = useAppStore(state => state.checkpointBySession[sessionId] || null);
  const modified = useAppStore(state => state.modifiedFilesBySession[sessionId] || EMPTY_CHANGES);
  const logs = useAppStore(state => state.terminalLogsBySession[sessionId] || EMPTY_LOGS);
  const tabs: { id: WorkspaceTab; label: string }[] = [
    { id: "changes", label: zh ? "改动" : "Changes" },
    { id: "files", label: zh ? "文件" : "Files" },
    { id: "activity", label: zh ? "运行" : "Runs" },
    { id: "context", label: zh ? "上下文" : "Context" },
    { id: "preview", label: zh ? "预览" : "Preview" },
  ];
  return <section className={`review-panel ${open ? "" : "collapsed"}`} style={{ width }} aria-label={zh ? "任务工作区" : "Task workspace"}>
    <div className="review-tabs" role="tablist" aria-label={zh ? "工作区视图" : "Workspace view"}>
      {tabs.map((tab, index) => <button type="button" key={tab.id} id={`workspace-tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id} aria-controls={`workspace-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => setTab(sessionId, tab.id)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        setTab(sessionId, tabs[next].id);
        document.getElementById(`workspace-tab-${tabs[next].id}`)?.focus();
      }}>{tab.label}</button>)}
      <button className="panel-toggle-btn review-close" type="button" onClick={onClose} aria-label={zh ? "关闭工作区" : "Close workspace"} title={zh ? "关闭工作区" : "Close workspace"}><X size={15} /></button>
    </div>
    <div className="review-panel-body">
      <div role="tabpanel" id="workspace-panel-changes" aria-labelledby="workspace-tab-changes" hidden={activeTab !== "changes"}>
        <RunReviewPanel lang={lang} checkpoint={checkpoint} workspace={workspace} modifiedFiles={modified} disabled={disabled} onRefresh={onRefresh} onSelectGit={actions.selectGitEntry} onRestoreGit={actions.restoreGitEntry} onKeep={actions.acceptRunCheckpoint} onRestore={actions.restoreRunCheckpoint} />
      </div>
      <div className="workspace-files" role="tabpanel" id="workspace-panel-files" aria-labelledby="workspace-tab-files" hidden={activeTab !== "files"}>
        <div className="workspace-file-tree"><div className="workspace-files-heading"><span title={workspace.workDir}>{workspace.workDir || (zh ? "未关联项目" : "No project")}</span><button className="panel-toggle-btn" onClick={onRefresh} disabled={workspace.loading} title={zh ? "刷新文件" : "Refresh files"} aria-label={zh ? "刷新文件" : "Refresh files"}><RefreshCw size={13} /></button></div>
          <WorkspaceTree root={workspace.root} lang={lang} loading={workspace.loading} error={workspace.treeError} onSelect={actions.selectWorkspaceFile} onAttach={actions.attachWorkspaceFile} attachDisabled={attachmentsLoading || disabled} onRefresh={onRefresh} />
        </div>
        <div className="workspace-file-view">
          {file.path ? <><div className="workspace-file-title" title={file.path}><FileCode2 size={14} /><span>{file.path}</span></div>{file.error ? <div className="workspace-inline-state error" role="alert">{file.error}<button className="btn" onClick={() => { void actions.selectWorkspaceFile({ path: file.path! }); }}><RefreshCw size={13} />{zh ? "重试" : "Retry"}</button></div> : file.loading ? <div className="workspace-inline-state" role="status">{zh ? "读取文件中..." : "Loading file..."}</div> : <pre><code>{file.content}</code></pre>}</> : <div className="workspace-empty-state"><FileCode2 size={25} /><span>{zh ? "未选择文件" : "No file selected"}</span></div>}
        </div>
      </div>
      <div role="tabpanel" id="workspace-panel-activity" aria-labelledby="workspace-tab-activity" hidden={activeTab !== "activity"}><RunActivity key={`${sessionId}:${selectedRunId || "latest"}`} session={session} lang={lang} logs={logs} selectedMessageId={selectedRunId} /></div>
      <div role="tabpanel" id="workspace-panel-preview" aria-labelledby="workspace-tab-preview" hidden={activeTab !== "preview"}><HtmlPreview sessionId={sessionId} lang={lang} sandbox={config.preview_sandbox} /></div>
      <div role="tabpanel" id="workspace-panel-context" aria-labelledby="workspace-tab-context" hidden={activeTab !== "context"}><ContextInspector key={`${sessionId}:${selectedRunId || "latest"}`} session={session} lang={lang} selectedMessageId={selectedRunId} /></div>
    </div>
  </section>;
}
