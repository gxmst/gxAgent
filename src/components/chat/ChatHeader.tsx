import { useState } from "react";
import { CircleCheck, Loader2, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pencil, Settings2 } from "lucide-react";
import { t } from "../../i18n";
import type { ChatSession, SessionConfig } from "../../types";
import { useAppStore } from "../../store/appStore";
import { taskState, taskStateLabel } from "../../utils/workbench";

export interface ChatHeaderProps {
  lang: string;
  currentSession: ChatSession;
  navigationOpen: boolean;
  onToggleNavigation: () => void;
  onModeChange: (mode: SessionConfig["mode"]) => void;
  disabled: boolean;
  sessionSaveStatus: "idle" | "saving" | "saved" | "error";
  sessionSettingsOpen: boolean;
  setSessionSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sessionSettingsToggleRef: React.RefObject<HTMLButtonElement | null>;
  rightPanelOpen: boolean;
  setRightPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onShowRun: () => void;
}

export function ChatHeader({ lang, currentSession, navigationOpen, onToggleNavigation, onModeChange, disabled, sessionSaveStatus, sessionSettingsOpen, setSessionSettingsOpen, sessionSettingsToggleRef, rightPanelOpen, setRightPanelOpen, onShowRun }: ChatHeaderProps) {
  const zh = lang === "zh";
  const setSessions = useAppStore(state => state.setSessions);
  const runtime = useAppStore(state => state.runtimeBySession[currentSession.id]);
  const approval = useAppStore(state => state.pendingApprovalsBySession[currentSession.id]);
  const preparing = useAppStore(state => state.preparingRequestSessionId === currentSession.id);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(currentSession.title);
  const coding = currentSession.sessionConfig.mode === "code";
  const status = taskState(currentSession, runtime, approval, preparing);
  const saveTitle = () => {
    if (title.trim() && title.trim() !== currentSession.title) {
      setSessions(sessions => sessions.map(session => session.id === currentSession.id ? { ...session, title: title.trim(), updatedAt: Date.now() } : session));
    }
    setEditing(false);
  };

  return <header className="task-header">
    <div className="task-title-row">
      {!navigationOpen && <button className="panel-toggle-btn" onClick={onToggleNavigation} aria-label={zh ? "展开侧栏" : "Expand sidebar"} title={zh ? "展开侧栏" : "Expand sidebar"}><PanelLeftOpen size={17} /></button>}
      {editing ? <input className="session-title-editable" aria-label={t("session.name", lang)} value={title} onChange={event => setTitle(event.target.value)} onBlur={saveTitle} onKeyDown={event => {
        if (event.key === "Enter") saveTitle();
        if (event.key === "Escape") { setTitle(currentSession.title); setEditing(false); }
      }} autoFocus /> : <h1 onDoubleClick={() => { setTitle(currentSession.title); setEditing(true); }}>{currentSession.title || (coding ? (zh ? "新任务" : "New task") : t("session.new", lang))}</h1>}
      <button className="panel-toggle-btn task-rename" title={t("ui.rename-session", lang)} aria-label={t("ui.rename-session", lang)} onClick={() => { setTitle(currentSession.title); setEditing(true); }}><Pencil size={13} /></button>
    </div>
    <div className="workbench-modes" role="group" aria-label={zh ? "工作模式" : "Workspace mode"}>
      <button disabled={disabled} aria-pressed={!coding} onClick={() => onModeChange("chat")}>{zh ? "聊天" : "Chat"}</button>
      <button disabled={disabled} aria-pressed={coding} onClick={() => onModeChange("code")}>{zh ? "工作" : "Work"}</button>
    </div>
    <div className="task-header-actions">
        <span className={`task-save-state ${sessionSaveStatus}`} role="status">{sessionSaveStatus === "saving" ? t("ui.saving", lang) : sessionSaveStatus === "error" ? t("ui.save-failed", lang) : ""}</span>
        {coding && currentSession.messages.length > 0 && <button className={`panel-toggle-btn task-run-state state-${status}`} onClick={onShowRun} title={`${taskStateLabel(status, lang)} · ${zh ? "运行记录" : "Run history"}`} aria-label={zh ? "运行记录" : "Run history"}>{runtime || preparing ? <Loader2 size={15} className="spin" /> : <CircleCheck size={15} />}</button>}
        <button ref={sessionSettingsToggleRef} className="panel-toggle-btn" onClick={() => setSessionSettingsOpen(!sessionSettingsOpen)} title={t("session.settings", lang)} aria-label={t("session.settings", lang)} aria-haspopup="dialog" aria-expanded={sessionSettingsOpen}><Settings2 size={16} /></button>
        <button className="panel-toggle-btn task-panel-toggle" onClick={() => setRightPanelOpen(!rightPanelOpen)} title={rightPanelOpen ? t("ui.close-workspace-panel", lang) : t("ui.open-right-panel", lang)} aria-label={rightPanelOpen ? t("ui.close-workspace-panel", lang) : t("ui.open-right-panel", lang)} aria-expanded={rightPanelOpen}>
          {rightPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
    </div>
  </header>;
}
