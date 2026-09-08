import { useLayoutEffect, useState, type ClipboardEvent } from "react";
import { Popover } from "radix-ui";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, ChevronDown, CircleStop, FileText, Loader2, Paperclip, Quote, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { t } from "../../i18n";
import type { AppConfig, Attachment, ChatSession, ModelInfo, SessionConfig } from "../../types";
import { isSendableAttachment, newMessageId } from "../../appDefaults";
import { useAppStore } from "../../store/appStore";
import { notify } from "../../services/agentEvents";
import { sortModels, sortProfileEntries } from "../../utils/modelSorting";
import { CommandSuggestions } from "../shared/CommandSuggestions";
import { ApprovalCard, messageHasPendingApproval } from "./ApprovalCard";
import { ProjectPicker } from "./ProjectPicker";
import { AgentQuestion } from "./AgentQuestion";
import { useCodexStore, type CodexModel } from "../../store/codexStore";

export interface ComposerProps {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  currentSession: ChatSession;
  resolvedCurrentConfig: AppConfig;
  sessionStorageReady: boolean;
  isAttachmentLoading: boolean;
  attachments: Attachment[];
  setAttachments: (next: Attachment[] | ((previous: Attachment[]) => Attachment[])) => void;
  prompt: string;
  setPrompt: (next: string | ((previous: string) => string)) => void;
  chatTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  handleSendMessage: () => Promise<void>;
  handleStopStreaming: () => Promise<void>;
  handleSteeringMessage: () => Promise<void>;
  addFilesAsAttachments: (files: File[]) => Promise<void>;
  pickAndParseAttachments: () => Promise<void>;
  patchSessionConfig: (patch: Partial<SessionConfig>) => void;
  getModelDisplayName: (modelId: string) => string;
  cacheModelDisplayName: (modelId: string, displayName: string) => void;
  modelsForCurrentConfig: ModelInfo[];
  onSettings: () => void;
  effectiveWorkDir: string;
  branch: string;
}

export function Composer({ lang, config, setConfig, currentSession, resolvedCurrentConfig, sessionStorageReady, isAttachmentLoading, attachments, setAttachments, prompt, setPrompt, chatTextareaRef, handleSendMessage, handleStopStreaming, handleSteeringMessage, addFilesAsAttachments, pickAndParseAttachments, patchSessionConfig, getModelDisplayName, cacheModelDisplayName, modelsForCurrentConfig, onSettings, effectiveWorkDir, branch }: ComposerProps) {
  const zh = lang === "zh";
  const sessionId = currentSession.id;
  const coding = currentSession.sessionConfig.mode === "code";
  const codex = coding && resolvedCurrentConfig.code_engine === "codex";
  const codexModels = useCodexStore(state => state.models);
  const question = useCodexStore(state => state.questions[sessionId]);
  const sessions = useAppStore(state => state.sessions);
  const setSessions = useAppStore(state => state.setSessions);
  const setCurrentSessionId = useAppStore(state => state.setCurrentSessionId);
  const activeId = useAppStore(state => state.activeRunSessionId);
  const preparingId = useAppStore(state => state.preparingRequestSessionId);
  const runtime = useAppStore(state => state.runtimeBySession[sessionId]);
  const approval = useAppStore(state => state.pendingApprovalsBySession[sessionId]);
  const quote = useAppStore(state => state.quoteBySession[sessionId]);
  const setQuote = useAppStore(state => state.setQuoteBySession);
  const usage = useAppStore(state => state.usageStatsBySession[sessionId]);
  const streaming = activeId === sessionId;
  const otherRun = sessions.find(session => session.id === activeId && session.id !== sessionId);
  const locked = !sessionStorageReady || isAttachmentLoading || preparingId !== null;
  const canSend = !locked && !otherRun && (!!prompt.trim() || attachments.some(isSendableAttachment) || !!quote);
  const [dragOver, setDragOver] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [checkingCodex, setCheckingCodex] = useState(false);
  const [codexError, setCodexError] = useState("");
  const displayModel = codex ? resolvedCurrentConfig.codex_model || (zh ? "Codex 默认" : "Codex default") : getModelDisplayName(resolvedCurrentConfig.model);
  const profiles = sortProfileEntries(Object.entries(config.profiles), lang).filter(([, profile]) => `${profile.name} ${profile.default_model}`.toLowerCase().includes(modelSearch.toLowerCase()));
  const models = sortModels(modelsForCurrentConfig, lang).filter(model => model.id.toLowerCase().includes(modelSearch.toLowerCase()));
  const searchEnabled = config.tools_enabled.includes("web_search");

  useLayoutEffect(() => {
    const field = chatTextareaRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = Math.min(field.scrollHeight, 160) + "px";
  }, [prompt, chatTextareaRef]);
  const pasteImages = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    if (!locked) await addFilesAsAttachments(files);
  };
  const permissionLabel = resolvedCurrentConfig.plan_mode ? (zh ? "只读规划" : "Read-only planning") : resolvedCurrentConfig.approval_policy === "unrestricted" ? (zh ? "信任所有操作" : "All operations trusted") : resolvedCurrentConfig.approval_policy === "strict" ? (codex ? (zh ? "谨慎审批" : "Cautious approvals") : (zh ? "逐次确认" : "Ask each time")) : (zh ? "按策略确认" : "Policy approvals");

  return <div className={`chat-input-wrapper ${dragOver ? "drag-over" : ""}`} onDragOver={event => { event.preventDefault(); if (!locked) setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={async event => { event.preventDefault(); setDragOver(false); if (!locked) await addFilesAsAttachments(Array.from(event.dataTransfer.files)); }}>
    {dragOver && <div className="drag-overlay">{t("attach.drop", lang)}</div>}
    {otherRun && <button className="active-run-jump" onClick={() => setCurrentSessionId(otherRun.id)}><Loader2 size={13} className="spin" /><span>{zh ? "正在运行：" : "Running: "}{otherRun.title || t("session.untitled", lang)}</span></button>}
    {(isAttachmentLoading || preparingId === sessionId) && <div className="attachment-loading-status" role="status"><Loader2 size={13} className="spin" />{isAttachmentLoading ? t("ui.parsing-attachments", lang) : t("ui.validating-and-preparing-request", lang)}</div>}
    {approval && <div className={`approval-dock ${currentSession.messages.some(message => messageHasPendingApproval(message, approval)) ? "has-inline" : ""}`}><ApprovalCard lang={lang} config={config} setConfig={setConfig} className="approval-card-dock" /></div>}
    {question && <AgentQuestion key={question.interactionId} question={question} sessionId={sessionId} lang={lang} />}
    {quote && <div className="quote-chip"><Quote size={13} /><span className="quote-chip-text">{quote.excerpt}</span><button className="panel-toggle-btn" onClick={() => setQuote(previous => ({ ...previous, [sessionId]: null }))} aria-label={t("quote.dismiss", lang)}><X size={12} /></button></div>}
    {!!attachments.length && <div className="attachments-bar">{attachments.map((attachment, index) => <div className={`attachment-chip ${attachment.type}`} key={`${index}:${attachment.name}`}>
      {attachment.type === "image" ? <img className="attachment-thumb" src={attachment.data} alt={attachment.name} /> : <FileText size={13} />}
      <span className="attachment-name" title={attachment.warning || attachment.path}>{attachment.name}{attachment.truncated ? (zh ? "（截断）" : " (truncated)") : ""}</span>
      <button className="attachment-remove" disabled={locked} aria-label={`${t("ui.remove-attachment", lang)}: ${attachment.name}`} onClick={() => setAttachments(previous => previous.filter((_, item) => item !== index))}><X size={12} /></button>
    </div>)}</div>}
    {coding && <ProjectPicker lang={lang} workDir={effectiveWorkDir} branch={branch} disabled={locked || !!activeId} onSelect={workDir => patchSessionConfig({ workDir })} />}
    <div className={`chat-input-container ${streaming && coding ? "steering-active" : ""}`}>
      <CommandSuggestions input={prompt} onSelect={setPrompt} lang={lang} />
      <textarea ref={chatTextareaRef} className="chat-textarea" aria-label={zh ? "消息" : "Message"} value={prompt} onChange={event => setPrompt(event.target.value)} onPaste={pasteImages} rows={2}
        placeholder={streaming && coding ? t("input.steering", lang) : coding ? (zh ? "描述任务，或补充要求…" : "Describe a task or add requirements...") : (zh ? "发送消息…" : "Send a message...")}
        disabled={!sessionStorageReady || (streaming && !coding) || preparingId === sessionId}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          if (streaming && coding && prompt.trim()) void handleSteeringMessage();
          else if (canSend && !streaming) void handleSendMessage();
          else if (otherRun) notify(t("ui.another-session-is-running-view", lang), "info");
        }} />
      <div className="composer-toolbar">
        <button className="panel-toggle-btn" disabled={locked} onClick={() => { void pickAndParseAttachments(); }} aria-label={zh ? "添加附件" : "Attach files"} title={zh ? "添加附件" : "Attach files"}><Paperclip size={16} /></button>
        <Popover.Root open={modelOpen} onOpenChange={setModelOpen}>
          <Popover.Trigger asChild><button className="composer-model" disabled={!sessionStorageReady} title={displayModel}><span>{displayModel || (zh ? "选择模型" : "Select model")}</span><ChevronDown size={12} /></button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="workbench-popover model-menu" side="top" align="start" collisionPadding={12} sideOffset={10} aria-label={zh ? "选择模型" : "Select model"}>
            <div className="model-menu-search"><Search size={14} /><input aria-label={zh ? "搜索模型" : "Search models"} placeholder={zh ? "搜索模型" : "Search models"} value={modelSearch} onChange={event => setModelSearch(event.target.value)} /></div>
            <div className="model-menu-list">
              {codex ? <>
                <button className="model-menu-item" onClick={() => { patchSessionConfig({ codexModel: null }); setModelOpen(false); }}><span>{zh ? "使用 Codex 默认" : "Use Codex default"}</span><small>{config.codex_model}</small></button>
                {codexModels.filter(model => `${model.model} ${model.displayName}`.toLowerCase().includes(modelSearch.toLowerCase())).map(model => <button className="model-menu-item" key={model.id} aria-pressed={resolvedCurrentConfig.codex_model === model.model} onClick={() => { patchSessionConfig({ codexModel: model.model }); setModelOpen(false); }}>{model.displayName || model.model}<small>{model.model}</small></button>)}
                <button className="model-menu-item" disabled={checkingCodex} onClick={async () => {
                  setCheckingCodex(true); setCodexError("");
                  try { const result = await invoke<{ models: CodexModel[] }>("inspect_codex", { executable: config.codex_executable || "codex" }); useCodexStore.setState({ models: result.models || [], executable: config.codex_executable || "codex" }); }
                  catch (error) { setCodexError(String(error)); }
                  finally { setCheckingCodex(false); }
                }}>{checkingCodex ? (zh ? "正在读取..." : "Loading...") : (zh ? "刷新 Codex 模型" : "Refresh Codex models")}</button>
                {codexError && <div className="workspace-inline-state error" role="alert">{codexError}</div>}
              </> : <>
              <button className="model-menu-item" onClick={() => { patchSessionConfig({ profileId: null, model: null }); setModelOpen(false); }}><span>{zh ? "使用全局默认" : "Use global default"}</span><small>{config.model}</small></button>
              {profiles.map(([id, profile]) => <button key={id} className="model-menu-item" aria-pressed={currentSession.sessionConfig.profileId === id && !currentSession.sessionConfig.model} onClick={() => { cacheModelDisplayName(profile.default_model, profile.name); patchSessionConfig({ profileId: id, model: null }); setModelOpen(false); }}><span>{profile.name}</span><small>{profile.default_model}</small></button>)}
              {models.map(model => <button key={model.id} className="model-menu-item" aria-pressed={resolvedCurrentConfig.model === model.id} onClick={() => { patchSessionConfig({ model: model.id }); setModelOpen(false); }}>{model.id}</button>)}
              {!profiles.length && !models.length && modelSearch && <div className="model-menu-empty">{zh ? "没有匹配的模型" : "No matching models"}</div>}
              </>}
            </div>
          </Popover.Content></Popover.Portal>
        </Popover.Root>
        {coding && <button className="composer-permission" onClick={onSettings} title={permissionLabel}><ShieldCheck size={13} /><span>{permissionLabel}</span></button>}
        <Popover.Root open={optionsOpen} onOpenChange={setOptionsOpen}>
          <Popover.Trigger asChild><button className="panel-toggle-btn" disabled={!sessionStorageReady} aria-label={zh ? "回复选项" : "Response options"} title={zh ? "回复选项" : "Response options"}><Settings2 size={16} /></button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="workbench-popover composer-options" side="top" align="end" sideOffset={10} collisionPadding={12}>
            {coding && <label>{zh ? "编码引擎" : "Coding engine"}<select disabled={!!activeId || preparingId !== null} value={currentSession.sessionConfig.engine || ""} onChange={event => patchSessionConfig({ engine: (event.target.value || undefined) as SessionConfig["engine"] })}><option value="">{zh ? "继承默认" : "Inherit default"}</option><option value="native">gxAgent</option><option value="codex">Codex</option></select></label>}
            <label>{t("session.thinkingLevel", lang)}<select value={currentSession.sessionConfig.thinkingLevel || "inherit"} onChange={event => patchSessionConfig({ thinkingLevel: event.target.value === "inherit" ? null : event.target.value as SessionConfig["thinkingLevel"] })}>
              <option value="inherit">{zh ? "继承默认" : "Inherit default"}</option><option value="low">{zh ? "低" : "Low"}</option><option value="medium">{zh ? "中" : "Medium"}</option><option value="high">{zh ? "高" : "High"}</option>
            </select></label>
            <label>{zh ? "联网搜索" : "Web search"}<select disabled={!searchEnabled} value={searchEnabled ? currentSession.sessionConfig.searchMode : "off"} onChange={event => patchSessionConfig({ searchMode: event.target.value as SessionConfig["searchMode"] })}>
              <option value="off">{zh ? "关闭" : "Off"}</option><option value="auto">{zh ? "自动" : "Auto"}</option><option value="force">{zh ? "每次搜索" : "Always"}</option>
            </select></label>
            <button className="btn" disabled={!!activeId || preparingId !== null} onClick={() => { setSessions(previous => previous.map(session => session.id === sessionId ? { ...session, messages: [...session.messages, { id: newMessageId(), role: "context_divider", content: "" }], updatedAt: Date.now() } : session)); setOptionsOpen(false); }}>{t("context.isolate", lang)}</button>
            <button className="btn" onClick={() => { setOptionsOpen(false); onSettings(); }}>{t("session.settings", lang)}</button>
          </Popover.Content></Popover.Portal>
        </Popover.Root>
        <div className="composer-send-actions">
          {streaming && coding && prompt.trim() && <button className="panel-toggle-btn" disabled={runtime?.status === "stopping"} onClick={() => { void handleSteeringMessage(); }} aria-label={zh ? "补充当前任务" : "Steer current task"} title={zh ? "补充当前任务" : "Steer current task"}><ArrowUp size={16} /></button>}
          <button className={`composer-send ${streaming ? "stopping" : ""}`} disabled={streaming ? runtime?.status === "stopping" : !canSend} onClick={() => { void (streaming ? handleStopStreaming() : handleSendMessage()); }} aria-label={streaming ? t("ui.stop-current-output", lang) : t("ui.send-message", lang)} title={streaming ? t("ui.stop-current-output", lang) : t("ui.send-message", lang)}>
            {streaming ? <CircleStop size={17} /> : <ArrowUp size={17} />}
          </button>
        </div>
      </div>
    </div>
    {usage && <div className="usage-footer"><span>{usage.totalPromptTokens + usage.totalCompletionTokens} tokens</span><span>{usage.loopCount} {zh ? "轮执行" : "iterations"}</span></div>}
  </div>;
}
