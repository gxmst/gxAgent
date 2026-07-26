/**
 * Right workspace panel: terminal log / activity / files / preview tabs,
 * run-checkpoint controls, git changes and diff viewer.
 *
 * Extracted verbatim from App.tsx; state stays in App and flows in
 * through props.
 */
import {
  Eye,
  FileText,
  FolderOpen,
  Globe,
  Monitor,
  RefreshCw,
  Smartphone,
  Terminal as TerminalIcon,
  Trash2,
  Zap,
} from "lucide-react";
import { t } from "../../i18n";
import { X } from "lucide-react";
import type { AppConfig, ChatSession, ToolAction } from "../../types";
import type { WorkspaceViewState, RunCheckpoint } from "../../appDefaults";
import { WorkspaceTree, type DirectoryNode } from "./WorkspaceTree";
import { WorkspaceChanges, type GitStatusEntry } from "./WorkspaceChanges";
import { DiffView } from "../shared/DiffView";

type PreviewConsoleLog = { text: string; type: "log" | "error" | "warn" | "info" };

export interface WorkspacePanelProps {
  lang: string;
  config: AppConfig;
  currentSession: ChatSession;
  currentSessionId: string;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  setRightPanelOpen: (open: boolean) => void;
  activeTab: "activity" | "files" | "preview";
  setActiveTab: React.Dispatch<React.SetStateAction<"activity" | "files" | "preview">>;
  terminalLogs: { text: string; type: string; timestamp?: number }[];
  statusLabel: (status: ToolAction["status"]) => string;
  currentWorkspace: WorkspaceViewState;
  refreshWorkspace: () => void;
  selectWorkspaceFile: (node: DirectoryNode) => void;
  attachWorkspaceFile: (node: DirectoryNode) => void;
  isAttachmentLoading: boolean;
  selectGitEntry: (entry: GitStatusEntry) => void;
  restoreGitEntry: (entry: GitStatusEntry) => void;
  checkpointBySession: Record<string, RunCheckpoint | null>;
  acceptRunCheckpoint: () => void;
  restoreRunCheckpoint: () => void;
  sessionMutationLocked: boolean;
  selectedFile: string | null;
  fileContent: string | null;
  modifiedFiles: Record<string, { old: string; new: string }>;
  diffView: boolean;
  setDiffView: React.Dispatch<React.SetStateAction<boolean>>;
  previewSrc: string;
  setPreviewSrc: (next: string | ((previous: string) => string)) => void;
  previewDevice: "desktop" | "mobile";
  setPreviewDevice: React.Dispatch<React.SetStateAction<"desktop" | "mobile">>;
  previewConsoleLogs: PreviewConsoleLog[];
  setPreviewConsoleLogs: (next: PreviewConsoleLog[] | ((previous: PreviewConsoleLog[]) => PreviewConsoleLog[])) => void;
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  const {
    lang, config, currentSession, currentSessionId,
    rightPanelOpen, rightPanelWidth, setRightPanelOpen,
    activeTab, setActiveTab, terminalLogs, statusLabel,
    currentWorkspace, refreshWorkspace, selectWorkspaceFile,
    attachWorkspaceFile, isAttachmentLoading, selectGitEntry,
    restoreGitEntry, checkpointBySession, acceptRunCheckpoint,
    restoreRunCheckpoint, sessionMutationLocked,
    selectedFile, fileContent, modifiedFiles, diffView, setDiffView,
    previewSrc, setPreviewSrc, previewDevice, setPreviewDevice,
    previewConsoleLogs, setPreviewConsoleLogs,
  } = props;
  return (
    <section
      className={`canvas-panel ${rightPanelOpen ? "" : "collapsed"}`}
      style={{ width: rightPanelWidth }}
    >
      <div className="canvas-tab-bar" role="tablist" aria-label={t("ui.workspace-panel", lang)}>
        <button
          role="tab"
          aria-selected={activeTab === "activity"}
          className={`canvas-tab ${activeTab === "activity" ? "active" : ""}`}
          onClick={() => setActiveTab("activity")}
        >
          <Zap size={12} /> {t("activity", lang)}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "files"}
          className={`canvas-tab ${activeTab === "files" ? "active" : ""}`}
          onClick={() => setActiveTab("files")}
        >
          <FolderOpen size={12} /> {t("files", lang)}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "preview"}
          className={`canvas-tab ${activeTab === "preview" ? "active" : ""}`}
          onClick={() => setActiveTab("preview")}
        >
          <Eye size={12} /> {t("preview", lang)}
        </button>
        <button
          type="button"
          className="canvas-close-btn"
          title={t("ui.close-workspace-panel", lang)}
          aria-label={t("ui.close-workspace-panel", lang)}
          onClick={() => setRightPanelOpen(false)}
        >
          <X size={14} />
        </button>
      </div>

      <div className="canvas-body">
        <div className={`canvas-content-pane ${activeTab === "activity" ? "active" : ""}`}>
          <div className="activity-panel">
            {/* Tool Calls from current session */}
            <div className="activity-section">
              <div className="activity-section-header">
                <Zap size={11} /> {t("activity.toolCalls", lang)}
              </div>
              {(() => {
                const allActions = currentSession.messages
                  .filter(m => m.role === "assistant" && m.actions && m.actions.length > 0)
                  .flatMap(m => m.actions || []);
                if (allActions.length === 0) {
                  return <div className="activity-empty">{t("activity.empty", lang)}</div>;
                }
                return (
                  <div className="activity-list">
                    {allActions.slice(-20).reverse().map((act, idx) => (
                      <div key={idx} className={`activity-item ${act.status}`}>
                        <div className="activity-item-header">
                          <span className="activity-item-name">{act.name}</span>
                          <span className={`activity-item-badge ${act.status}`}>{statusLabel(act.status)}</span>
                        </div>
                        {act.output && (
                          <div className="activity-item-output">
                            {act.output.length > 120 ? act.output.slice(0, 120) + "..." : act.output}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Search Sources from current session */}
            <div className="activity-section">
              <div className="activity-section-header">
                <Globe size={11} /> {t("activity.searchSources", lang)}
              </div>
              {(() => {
                const allSearchStatus = currentSession.messages
                  .filter(m => m.searchStatus && m.searchStatus.length > 0)
                  .flatMap(m => m.searchStatus || []);
                const resultsWithSources = allSearchStatus.filter(s => s.type === "results" && s.sources && s.sources.length > 0);
                if (resultsWithSources.length === 0) {
                  return <div className="activity-empty">{t("ui.no-search-sources-yet", lang)}</div>;
                }
                // Deduplicate sources by link
                const allSources = resultsWithSources.flatMap(ss => ss.sources || []);
                const seenLinks = new Set<string>();
                const uniqueSources = allSources.filter(src => {
                  if (!src.link || seenLinks.has(src.link)) return false;
                  seenLinks.add(src.link);
                  return true;
                });
                return (
                  <div className="activity-list">
                    {uniqueSources.slice(0, 15).map((src, idx) => (
                      <div key={idx} className="activity-source-item">
                        <div className="activity-source-title">
                          {src.link ? <a href={src.link} target="_blank" rel="noopener noreferrer">{src.title || src.link}</a> : src.title}
                        </div>
                        {src.snippet && <div className="activity-source-snippet">{src.snippet}</div>}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Recent Logs (collapsed by default) */}
            <details className="activity-section activity-logs-section">
              <summary className="activity-section-header">
                <TerminalIcon size={11} /> {t("terminal", lang)}
              </summary>
              <div className="console-container">
                {terminalLogs.slice(-50).map((log, idx) => (
                  <div key={idx} className={`console-line ${log.type}`}>
                    {log.type === "cmd" ? "> " : ""}
                    {log.text}
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>

        <div className={`canvas-content-pane ${activeTab === "files" ? "active" : ""}`}>
          <div className="files-panel">
            <div className="files-header">
              <span style={{ fontSize: "var(--font-caption)", color: "var(--accent)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {t("files.workspace", lang)}
              </span>
              <button className="btn" style={{ padding: "3px 8px", fontSize: "var(--font-caption)" }} onClick={() => { void refreshWorkspace(); }}>
                <RefreshCw size={11} /> {t("files.refresh", lang)}
              </button>
            </div>
            <WorkspaceTree
              root={currentWorkspace.root}
              lang={lang}
              loading={currentWorkspace.loading}
              error={currentWorkspace.treeError}
              onSelect={(node) => { void selectWorkspaceFile(node); }}
              onAttach={(node) => { void attachWorkspaceFile(node); }}
              attachDisabled={isAttachmentLoading || sessionMutationLocked}
              onRefresh={() => { void refreshWorkspace(); }}
            />
            <WorkspaceChanges
              lang={lang}
              branch={currentWorkspace.branch}
              entries={currentWorkspace.entries}
              selectedPath={currentWorkspace.selectedPath}
              diff={currentWorkspace.diff}
              loading={currentWorkspace.loading}
              error={currentWorkspace.changesError}
              checkpointAvailable={Boolean(checkpointBySession[currentSessionId])}
              actionsDisabled={sessionMutationLocked}
              onSelect={(entry) => { void selectGitEntry(entry); }}
              onRefresh={() => { void refreshWorkspace(); }}
              onRestorePath={(entry) => { void restoreGitEntry(entry); }}
              onRestoreCheckpoint={() => { void restoreRunCheckpoint(); }}
              onAcceptCheckpoint={() => { void acceptRunCheckpoint(); }}
            />
            {fileContent !== null && (
              <div className="file-preview">
                <div className="file-preview-header">
                  <FileText size={12} />
                  <span title={selectedFile || undefined}>{selectedFile}</span>
                  {selectedFile && modifiedFiles[selectedFile] && (
                    <button className="btn" style={{ padding: "2px 8px", fontSize: "var(--font-caption)", marginLeft: "auto" }} onClick={() => setDiffView(!diffView)}>
                      {diffView ? t("files.current", lang) : t("files.diff", lang)}
                    </button>
                  )}
                </div>
                {diffView && selectedFile && modifiedFiles[selectedFile] ? (
                  <DiffView
                    oldContent={modifiedFiles[selectedFile].old}
                    newContent={modifiedFiles[selectedFile].new}
                  />
                ) : (
                  <pre className="file-preview-body">
                    <code>{fileContent}</code>
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>

        <div className={`canvas-content-pane ${activeTab === "preview" ? "active" : ""}`}>
          <div className="preview-panel">
            <div className="preview-toolbar">
              <button
                className={`preview-device-btn ${previewDevice === "desktop" ? "active" : ""}`}
                onClick={() => setPreviewDevice("desktop")}
                title="Desktop"
              >
                <Monitor size={14} />
              </button>
              <button
                className={`preview-device-btn ${previewDevice === "mobile" ? "active" : ""}`}
                onClick={() => setPreviewDevice("mobile")}
                title="Mobile"
              >
                <Smartphone size={14} />
              </button>
              <button className="btn" style={{ padding: "3px 8px", fontSize: "var(--font-caption)" }} onClick={() => setPreviewSrc(previewSrc + " ")} title={t("files.refresh", lang)}>
                <RefreshCw size={11} />
              </button>
              <button className="btn" style={{ padding: "3px 8px", fontSize: "var(--font-caption)", marginLeft: "auto" }} onClick={() => setPreviewConsoleLogs([])} title="Clear console">
                <Trash2 size={11} />
              </button>
            </div>
            <div className="preview-frame-wrapper">
              {previewSrc ? (
                <iframe
                  className={`preview-iframe ${previewDevice === "mobile" ? "mobile" : ""}`}
                  sandbox={config.preview_sandbox ? "allow-scripts" : undefined}
                  srcDoc={(() => {
                    const consoleHijack = `<script>(function(){var o={log:console.log,error:console.error,warn:console.warn,info:console.info};function c(t){return function(){var a=[].slice.call(arguments);o[t].apply(console,a);window.parent.postMessage({type:'iframe-console-log',logType:t,text:a.map(function(x){return typeof x==='object'?JSON.stringify(x):String(x)}).join(' ')},'*')}};console.log=c('log');console.error=c('error');console.warn=c('warn');console.info=c('info');window.addEventListener('error',function(e){window.parent.postMessage({type:'iframe-console-log',logType:'error',text:'Runtime Error: '+e.message+' at '+e.filename+':'+e.lineno},'*')})})()</script>`;
                    if (previewSrc.toLowerCase().includes("<head>")) {
                      return previewSrc.replace(/<head>/i, "<head>" + consoleHijack);
                    }
                    return consoleHijack + previewSrc;
                  })()}
                  title="Preview"
                />
              ) : (
                <div className="preview-empty">
                  <Eye size={24} style={{ opacity: 0.3 }} />
                  <span>{t("preview.empty", lang)}</span>
                </div>
              )}
            </div>
            {previewConsoleLogs.length > 0 && (
              <div className="preview-console">
                {previewConsoleLogs.map((log, i) => (
                  <div key={i} className={`preview-console-line ${log.type}`}>
                    [{log.type}] {log.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
