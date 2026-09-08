/**
 * Per-session settings panel: overrides that resolve on top of the global
 * config (null = inherit), plus session title, work dir, and history
 * compaction controls.
 *
 * Extracted verbatim from App.tsx; state stays in App and flows in
 * through props.
 */
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "radix-ui";
import { RotateCcw, X } from "lucide-react";
import { t } from "../../i18n";
import type { AppConfig, ChatSession, ModelInfo, SessionConfig } from "../../types";
import {
  CONTEXT_BUDGET_OPTIONS,
  DEFAULT_SESSION_CONFIG,
  MAX_CONTEXT_BUDGET,
  formatContextBudget,
  type SessionRuntime,
} from "../../appDefaults";
import type { ConfirmationOptions } from "../shared/ConfirmDialog";
import { sortModels, sortProfileEntries } from "../../utils/modelSorting";
import type { RolePreset } from "../../rolePresets";
import { RolePresetManager } from "./RolePresetManager";
import { SessionLearningSettings } from "./SessionLearningSettings";

export interface SessionSettingsPanelProps {
  lang: string;
  config: AppConfig;
  currentSession: ChatSession;
  currentSessionId: string;
  resolvedCurrentConfig: AppConfig;
  models: ModelInfo[];
  runtimeBySession: Record<string, SessionRuntime | null>;
  sessionMutationLocked: boolean;
  customSessionContextBudget: Record<string, boolean>;
  setCustomSessionContextBudget: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  sessionSettingsPanelRef: RefObject<HTMLDivElement | null>;
  closeSessionSettings: (restoreFocus?: boolean) => void;
  patchSessionConfig: (patch: Partial<SessionConfig>) => void;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  undoCompact: () => void;
  requestConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
  customPresets: RolePreset[];
  setCustomPresets: React.Dispatch<React.SetStateAction<RolePreset[]>>;
}

export function SessionSettingsPanel(props: SessionSettingsPanelProps) {
  const {
    lang, config, currentSession, currentSessionId, resolvedCurrentConfig,
    models, runtimeBySession, sessionMutationLocked,
    customSessionContextBudget, setCustomSessionContextBudget,
    sessionSettingsPanelRef, closeSessionSettings, patchSessionConfig,
    setSessions, undoCompact, requestConfirmation, customPresets, setCustomPresets,
  } = props;
  const codex = resolvedCurrentConfig.code_engine === "codex";
  const profileEntries = sortProfileEntries(Object.entries(config.profiles), lang);
  const configuredModelIds = new Set(profileEntries.map(([, profile]) => profile.default_model));
  const otherModels = sortModels(
    models.filter((model) => !configuredModelIds.has(model.id)),
    lang,
  );

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) closeSessionSettings(true);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          ref={sessionSettingsPanelRef}
          className="session-settings-panel"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            sessionSettingsPanelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="session-settings-title"
          tabIndex={-1}
        >
          <div className="session-settings-header">
              <Dialog.Title asChild><span id="session-settings-title" style={{ fontWeight: 600, fontSize: "var(--font-ui)" }}>{t("session.settings", lang)}</span></Dialog.Title>
              <button
                className="panel-toggle-btn"
                onClick={() => closeSessionSettings(true)}
                aria-label={t("settings.close", lang)}
              >
                <X size={14} />
              </button>
          </div>
          <div className="session-settings-body">
              <SessionLearningSettings config={config} session={currentSession.sessionConfig} patch={patchSessionConfig} lang={lang} />
              <div className="session-inheritance">
                <span>{lang === "zh" ? "默认配置来源" : "Default configuration"}</span><strong>{lang === "zh" ? "全局设置" : "Global settings"}</strong>
                <span>{lang === "zh" ? "当前模型来源" : "Model source"}</span><strong>{(codex ? Boolean(currentSession.sessionConfig.codexModel) : currentSession.sessionConfig.model !== null || currentSession.sessionConfig.profileId !== null) ? (lang === "zh" ? "当前会话" : "This conversation") : (lang === "zh" ? "继承默认" : "Inherited")}</strong>
              </div>
              {/* Name */}
              <label className="session-field">
                <span className="session-label">{t("session.name", lang)}</span>
                <input
                  className="session-input"
                  value={currentSession.title}
                  onChange={(e) => {
                    setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, title: e.target.value } : s));
                  }}
                />
              </label>
              <RolePresetManager lang={lang} session={currentSession} customPresets={customPresets} setCustomPresets={setCustomPresets} onChange={patchSessionConfig} />
              {currentSession.sessionConfig.mode === "code" && <label className="session-field"><span className="session-label">{lang === "zh" ? "编码引擎" : "Coding engine"}</span><select className="session-select" disabled={sessionMutationLocked} value={currentSession.sessionConfig.engine || ""} onChange={event => patchSessionConfig({ engine: (event.target.value || undefined) as SessionConfig["engine"] })}><option value="">{lang === "zh" ? "继承全局设置" : "Inherit global settings"}</option><option value="native">gxAgent</option><option value="codex">Codex</option></select></label>}
              {/* System Prompt */}
              <label className="session-field">
                <span className="session-label">{t("session.systemPrompt", lang)}</span>
                <textarea
                  className="session-textarea"
                  rows={3}
                  value={currentSession.sessionConfig.systemPrompt ?? ""}
                  placeholder={config.system_prompt}
                  onChange={(e) => {
                    patchSessionConfig({ systemPrompt: e.target.value || null, activeRolePresetId: null });
                  }}
                />
              </label>
              <label className="session-field">
                <span className="session-label">{codex ? (lang === "zh" ? "Codex 模型" : "Codex model") : "Profile / API"}</span>
                {codex ? <input className="session-input" value={currentSession.sessionConfig.codexModel || ""} placeholder={config.codex_model || (lang === "zh" ? "继承 Codex 默认" : "Inherit Codex default")} onChange={event => patchSessionConfig({ codexModel: event.target.value || null })} /> :
                <select
                  className="session-select"
                  value={currentSession.sessionConfig.profileId || ""}
                  onChange={(event) => {
                    const profileId = event.target.value || null;
                    patchSessionConfig({ profileId, model: null });
                  }}
                >
                  <option value="">{t("ui.inherit-global-connection", lang)}</option>
                  {profileEntries.map(([profileId, profile]) => (
                    <option key={profileId} value={profileId}>{profile.name} ({profile.default_model})</option>
                  ))}
                </select>}
              </label>
              {!codex && <>
              {/* Model */}
              <label className="session-field">
                <span className="session-label">{t("session.model", lang)}</span>
                <select
                  className="session-select"
                  value={currentSession.sessionConfig.model || ""}
                  onChange={(e) => {
                    patchSessionConfig({ model: e.target.value || null });
                  }}
                >
                  <option value="">{t("ui.inherit-value", lang, { value: resolvedCurrentConfig.model })}</option>
                  {models.length > 0 && (
                    <optgroup label={t("ui.available-models", lang)}>
                      {otherModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.id}</option>
                      ))}
                    </optgroup>
                  )}
                  {!Object.values(config.profiles).some(p => p.default_model === config.model) && models.length === 0 && (
                    <option value={config.model}>{config.model}</option>
                  )}
                </select>
              </label>
              {/* Context Limit */}
              <label className="session-field">
                <span className="session-label">{t("session.contextLimit", lang)}</span>
                <select className="session-select" value={customSessionContextBudget[currentSessionId] || (currentSession.sessionConfig.contextLimit !== null && !CONTEXT_BUDGET_OPTIONS.includes(currentSession.sessionConfig.contextLimit as typeof CONTEXT_BUDGET_OPTIONS[number])) ? "custom" : currentSession.sessionConfig.contextLimit === null ? "inherit" : String(currentSession.sessionConfig.contextLimit)} onChange={(event) => {
                  if (event.target.value === "custom") {
                    setCustomSessionContextBudget((previous) => ({ ...previous, [currentSessionId]: true }));
                    patchSessionConfig({ contextLimit: Math.min(MAX_CONTEXT_BUDGET, Math.max(1_000, currentSession.sessionConfig.contextLimit ?? resolvedCurrentConfig.context_limit)) });
                    return;
                  }
                  setCustomSessionContextBudget((previous) => ({ ...previous, [currentSessionId]: false }));
                  const value = event.target.value === "inherit" ? null : Number(event.target.value);
                  patchSessionConfig({ contextLimit: value });
                }}>
                  <option value="inherit">{t("ui.inherit-global-value", lang, { value: formatContextBudget(config.context_limit) })}</option>
                  {CONTEXT_BUDGET_OPTIONS.map((value) => <option key={value} value={value}>{formatContextBudget(value)}</option>)}
                  <option value="custom">{t("ui.custom", lang)}</option>
                </select>
                {(customSessionContextBudget[currentSessionId] || (currentSession.sessionConfig.contextLimit !== null && !CONTEXT_BUDGET_OPTIONS.includes(currentSession.sessionConfig.contextLimit as typeof CONTEXT_BUDGET_OPTIONS[number]))) && <input type="number" className="session-input session-input-sm" min={1000} max={MAX_CONTEXT_BUDGET} step={1000} value={currentSession.sessionConfig.contextLimit ?? resolvedCurrentConfig.context_limit} onChange={(event) => patchSessionConfig({ contextLimit: Math.min(MAX_CONTEXT_BUDGET, Math.max(1000, Number(event.target.value) || 1000)) })} />}
              </label>
              <details className="session-settings-advanced">
                <summary>{t("ui.advanced-generation", lang)}</summary>
                <div className="session-settings-advanced-grid">
              {/* Temperature */}
              <label className="session-field">
                <span className="session-label">{t("session.temperature", lang)}: {resolvedCurrentConfig.temperature}{currentSession.sessionConfig.temperature === null ? ` (${t("ui.inherit", lang)})` : ""}</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={currentSession.sessionConfig.temperature ?? resolvedCurrentConfig.temperature}
                  onChange={(e) => {
                    patchSessionConfig({ temperature: parseFloat(e.target.value) });
                  }}
                />
                <button type="button" className={`session-btn ${currentSession.sessionConfig.temperature === null ? "active" : ""}`} onClick={() => {
                  patchSessionConfig({ temperature: null });
                }}>{t("ui.inherit-2", lang)}</button>
              </label>
              {/* Top P */}
              <label className="session-field">
                <span className="session-label">{t("session.topP", lang)}: {resolvedCurrentConfig.top_p}{currentSession.sessionConfig.topP === null ? ` (${t("ui.inherit", lang)})` : ""}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={currentSession.sessionConfig.topP ?? resolvedCurrentConfig.top_p}
                  onChange={(e) => {
                    patchSessionConfig({ topP: parseFloat(e.target.value) });
                  }}
                />
                <button type="button" className={`session-btn ${currentSession.sessionConfig.topP === null ? "active" : ""}`} onClick={() => {
                  patchSessionConfig({ topP: null });
                }}>{t("ui.inherit-2", lang)}</button>
              </label>
              {/* Max Tokens */}
              <label className="session-field">
                <span className="session-label">{t("session.maxTokens", lang)}</span>
                <select className="session-select" value={currentSession.sessionConfig.maxTokens === "inherit" ? "inherit" : currentSession.sessionConfig.maxTokens === null ? "unlimited" : "custom"} onChange={(event) => {
                  const maxTokens = event.target.value === "inherit" ? "inherit" : event.target.value === "unlimited" ? null : (resolvedCurrentConfig.max_tokens || 4096);
                  patchSessionConfig({ maxTokens });
                }}>
                  <option value="inherit">{t("ui.inherit-global", lang)}</option>
                  <option value="unlimited">{t("ui.unlimited", lang)}</option>
                  <option value="custom">{t("ui.custom", lang)}</option>
                </select>
                {typeof currentSession.sessionConfig.maxTokens === "number" && <input type="number" className="session-input session-input-sm" min={1} value={currentSession.sessionConfig.maxTokens} onChange={(event) => {
                  patchSessionConfig({ maxTokens: Math.max(1, parseInt(event.target.value) || 1) });
                }} />}
              </label>
              {/* Streaming */}
              <label className="session-field session-field-row">
                <span className="session-label">{t("session.streaming", lang)}</span>
                <select className="session-select" value={currentSession.sessionConfig.streaming === null ? "inherit" : String(currentSession.sessionConfig.streaming)} onChange={(event) => {
                  const streaming = event.target.value === "inherit" ? null : event.target.value === "true";
                  patchSessionConfig({ streaming });
                }}>
                  <option value="inherit">{t("ui.inherit-value", lang, { value: t(resolvedCurrentConfig.streaming ? "settings.on" : "settings.off", lang) })}</option>
                  <option value="true">{t("ui.on", lang)}</option>
                  <option value="false">{t("ui.off", lang)}</option>
                </select>
              </label>
                </div>
              </details>
              </>}
              <label className="session-field">
                <span className="session-label">{t("ui.working-directory", lang)}</span>
                <div className="session-workspace-row">
                  <input disabled={Boolean(runtimeBySession[currentSessionId])} className="session-input" value={currentSession.sessionConfig.workDir ?? ""} placeholder={config.default_work_dir || "."} onChange={(event) => {
                    patchSessionConfig({ workDir: event.target.value || null });
                  }} />
                  <button type="button" className="session-btn" disabled={Boolean(runtimeBySession[currentSessionId])} onClick={async () => {
                    const selected = await invoke<string | null>("pick_workspace_directory");
                    if (selected) patchSessionConfig({ workDir: selected });
                  }}>{t("ui.choose", lang)}</button>
                </div>
              </label>
              {(currentSession.sessionConfig.mode || "chat") === "code" && (
                <label className="session-field session-field-row trust-all-field">
                  <span><span className="session-label">{t("ui.trust-all-operations", lang)}</span><small>{codex ? (lang === "zh" ? "Codex 完整访问权限，关闭操作审批" : "Codex full access with approvals disabled") : t("ui.skip-ordinary-approvals-hard-dangerous", lang)}</small></span>
                  <input type="checkbox" disabled={sessionMutationLocked || (codex && resolvedCurrentConfig.plan_mode)} checked={Boolean(currentSession.sessionConfig.trustAllOperations)} onChange={async (event) => {
                    const checked = event.target.checked;
                    if (checked && !await requestConfirmation({
                      title: t("ui.trust-all-title", lang),
                      message: codex ? (lang === "zh" ? "Codex 将获得完整文件和网络访问权限，并跳过操作审批。确认启用？" : "Codex will have full file and network access with operation approvals disabled. Enable full access?") : t("ui.danger-code-mode-will-stop", lang),
                      confirmLabel: t("ui.trust-all-operations", lang),
                      cancelLabel: t("ui.cancel", lang),
                      danger: true,
                    })) return;
                    patchSessionConfig({ trustAllOperations: checked });
                  }} />
                </label>
              )}
              {/* Thinking Level */}
              <details className="session-settings-advanced">
                <summary>{t("ui.display-reasoning", lang)}</summary>
                <div className="session-settings-advanced-grid">
              <label className="session-field">
                <span className="session-label">{t("session.thinkingLevel", lang)}</span>
                <div className="session-btn-group">
                  <button
                    type="button"
                    className={`session-btn ${currentSession.sessionConfig.thinkingLevel === null ? "active" : ""}`}
                    onClick={() => patchSessionConfig({ thinkingLevel: null })}
                  >
                    {t("ui.inherit-2", lang)}
                  </button>
                  {(["low", "medium", "high"] as const).map(level => (
                    <button
                      key={level}
                      className={`session-btn ${currentSession.sessionConfig.thinkingLevel === level ? "active" : ""}`}
                      onClick={() => {
                        patchSessionConfig({ thinkingLevel: level });
                      }}
                    >
                      {t(`session.thinking${level.charAt(0).toUpperCase() + level.slice(1)}`, lang)}
                    </button>
                  ))}
                </div>
              </label>
              {/* Background Image */}
              <label className="session-field">
                <span className="session-label">{t("session.backgroundImage", lang)}</span>
                <input
                  className="session-input"
                  placeholder="URL or path"
                  value={currentSession.sessionConfig.backgroundImage}
                  onChange={(e) => {
                    patchSessionConfig({ backgroundImage: e.target.value });
                  }}
                />
              </label>
                </div>
              </details>
              {/* Reset */}
              <button
                className="btn btn-secondary"
                disabled={sessionMutationLocked}
                style={{ marginTop: 8, width: "100%" }}
                onClick={() => {
                  setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                    ...s,
                    sessionConfig: { ...DEFAULT_SESSION_CONFIG, mode: s.sessionConfig.mode, workDir: s.sessionConfig.workDir },
                    updatedAt: Date.now(),
                  } : s));
                }}
              >
                {t("session.reset", lang)}
              </button>
              {currentSession.compactBackup && (
                <button className="btn btn-secondary" disabled={sessionMutationLocked} style={{ marginTop: 8, width: "100%" }} onClick={undoCompact}>
                  <RotateCcw size={13} /> {t("ui.undo-history-compact", lang)}
                </button>
              )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
