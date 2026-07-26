/**
 * Chat pane header: session title with inline rename, work-dir / save-status
 * subtitle, mode indicator, and the theme / session-settings / right-panel /
 * always-on-top toggles.
 *
 * Extracted verbatim from App.tsx. Title edits go through the zustand store;
 * the title-editing and always-on-top flags are component-local because
 * nothing else in App reads them.
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MessageSquare,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Settings2,
  Sun,
  Terminal as TerminalIcon,
} from "lucide-react";
import { t } from "../../i18n";
import type { AppConfig, ChatSession } from "../../types";
import { THEME_OPTIONS } from "../../appDefaults";
import { useAppStore } from "../../store/appStore";

export interface ChatHeaderProps {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  currentSession: ChatSession;
  effectiveWorkDir: string;
  sessionSaveStatus: "idle" | "saving" | "saved" | "error";
  sessionSettingsOpen: boolean;
  setSessionSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sessionSettingsToggleRef: React.RefObject<HTMLButtonElement | null>;
  rightPanelOpen: boolean;
  setRightPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function ChatHeader({
  lang,
  config,
  setConfig,
  currentSession,
  effectiveWorkDir,
  sessionSaveStatus,
  sessionSettingsOpen,
  setSessionSettingsOpen,
  sessionSettingsToggleRef,
  rightPanelOpen,
  setRightPanelOpen,
}: ChatHeaderProps) {
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setSessions = useAppStore((s) => s.setSessions);
  const currentMode = currentSession.sessionConfig.mode || "chat";

  const [editingSessionTitle, setEditingSessionTitle] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);

  // Header quick-toggle: flip between light and dark. If the active theme is a
  // custom dark theme, this jumps to the plain light theme and vice versa.
  const toggleTheme = () => {
    setConfig((prev) => {
      const current = THEME_OPTIONS.find((th) => th.value === prev.theme);
      const isDark = current?.mode === "dark";
      return { ...prev, theme: isDark ? "light" : "dark" };
    });
  };

  return (
    <header className="panel-header">
      <div className="panel-heading">
        {editingSessionTitle ? (
          <input
            className="session-title-editable"
            value={currentSession.title}
            onChange={(e) => {
              setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, title: e.target.value } : s));
            }}
            onBlur={() => setEditingSessionTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setEditingSessionTitle(false);
              if (e.key === 'Escape') setEditingSessionTitle(false);
            }}
            autoFocus
          />
        ) : (
          <span
            className="panel-title"
            style={{ fontSize: "var(--font-ui)", cursor: "pointer" }}
            onDoubleClick={() => setEditingSessionTitle(true)}
            title={t("ui.rename-title-hint", lang)}
          >
            {currentSession.title || t("session.new", lang)}
          </span>
        )}
        <div className="panel-subtitle">
          {effectiveWorkDir || "."}
          {sessionSaveStatus === "saving" && ` · ${t("ui.saving", lang)}`}
          {sessionSaveStatus === "error" && (
            <span className="panel-subtitle-error"> · {t("ui.save-failed", lang)}</span>
          )}
        </div>
      </div>
      <div className="panel-header-controls">
        <div className="panel-status-cluster">
          <span className={`mode-indicator ${currentMode}`}>
            {currentMode === "chat" ? <MessageSquare size={11} /> : <TerminalIcon size={11} />}
            {currentMode === "chat" ? t("mode.chat", lang) : t("mode.code", lang)}
          </span>
        </div>
        <div className="panel-action-cluster">
          <button
            className="panel-toggle-btn"
            onClick={toggleTheme}
            title={t("ui.toggle-theme", lang)}
            aria-label={t("ui.toggle-theme", lang)}
          >
            {config.theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button
            ref={sessionSettingsToggleRef}
            className="panel-toggle-btn"
            onClick={() => setSessionSettingsOpen(!sessionSettingsOpen)}
            title={t("session.settings", lang)}
            aria-haspopup="dialog"
            aria-expanded={sessionSettingsOpen}
          >
            <Settings2 size={14} />
          </button>
          <button
            className="panel-toggle-btn"
            onClick={() => setRightPanelOpen(!rightPanelOpen)}
            title={rightPanelOpen ? t("ui.close-workspace-panel", lang) : t("ui.open-right-panel", lang)}
            aria-expanded={rightPanelOpen}
          >
            {rightPanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
          <button
            className={`panel-toggle-btn ${alwaysOnTop ? "active" : ""}`}
            aria-pressed={alwaysOnTop}
            onClick={async () => {
              const result = await invoke<boolean>("toggle_always_on_top");
              setAlwaysOnTop(result);
            }}
            title={alwaysOnTop ? t("window.unpin", lang) : t("window.pin", lang)}
          >
            <Pin size={14} />
          </button>
        </div>
      </div>
    </header>
  );
}
