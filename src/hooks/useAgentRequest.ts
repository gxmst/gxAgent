/**
 * The agent request pipeline: serializing history for the API, manual and
 * rolling auto-compaction, the guarded startAgentRequest state machine, and
 * the user-facing send / stop / steer / retry-branch / edit-branch handlers.
 *
 * Extracted verbatim from App.tsx. Sessions, runtime status, approvals and
 * checkpoints live in the zustand store; App-local state (config, models,
 * prompt drafts, attachments, edit state) flows in as params.
 */
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type {
  AppConfig,
  Attachment,
  ChatSession,
  ContextSummary,
  Message,
  ModelInfo,
  SessionConfig,
} from "../types";
import {
  createSession,
  estimateTextTokens,
  fitAttachmentBudget,
  isSendableAttachment,
  modelContextLimitForConfig,
  newMessageId,
} from "../appDefaults";
import { parseCommand, sessionToMarkdown } from "../utils/helpers";
import { formatQuoteReply } from "../utils/quote";
import { resolveRequestConfig } from "../utils/requestConfig";
import { fallbackSessionTitle } from "../utils/sessionTitle";
import { useAppStore } from "../store/appStore";
import { runtime } from "../services/agentRuntime";
import { addLog, notify, finishStreamingLocally } from "../services/agentEvents";

export function useAgentRequest({
  lang,
  config,
  sessionStorageReady,
  sessionMutationLocked,
  requestStartingRef,
  models,
  modelCatalogSourceKey,
  resolvedCurrentConfig,
  currentSession,
  prompt,
  setPrompt,
  attachments,
  isAttachmentLoading,
  setDraftsBySession,
  setAttachmentsBySession,
  setSidebarNav,
  editText,
  setEditingMessageIdx,
}: {
  lang: string;
  config: AppConfig;
  sessionStorageReady: boolean;
  sessionMutationLocked: boolean;
  requestStartingRef: React.MutableRefObject<boolean>;
  models: ModelInfo[];
  modelCatalogSourceKey: string | null;
  resolvedCurrentConfig: AppConfig;
  currentSession: ChatSession;
  prompt: string;
  setPrompt: (next: string | ((previous: string) => string)) => void;
  attachments: Attachment[];
  isAttachmentLoading: boolean;
  setDraftsBySession: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setAttachmentsBySession: React.Dispatch<React.SetStateAction<Record<string, Attachment[]>>>;
  setSidebarNav: React.Dispatch<React.SetStateAction<"chat" | "code">>;
  editText: string;
  setEditingMessageIdx: (value: number | null) => void;
}) {
  const sessions = useAppStore((s) => s.sessions);
  const setSessions = useAppStore((s) => s.setSessions);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setCurrentSessionId = useAppStore((s) => s.setCurrentSessionId);
  const activeRunSessionId = useAppStore((s) => s.activeRunSessionId);
  const setActiveRunSessionId = useAppStore((s) => s.setActiveRunSessionId);
  const setPreparingRequestSessionId = useAppStore((s) => s.setPreparingRequestSessionId);
  const setRuntimeBySession = useAppStore((s) => s.setRuntimeBySession);
  const currentRuntime = useAppStore((s) => s.runtimeBySession[s.currentSessionId] || null);
  const checkpointBySession = useAppStore((s) => s.checkpointBySession);
  const setCheckpointBySession = useAppStore((s) => s.setCheckpointBySession);
  const setPendingApprovalsBySession = useAppStore((s) => s.setPendingApprovalsBySession);
  const setUsageStatsBySession = useAppStore((s) => s.setUsageStatsBySession);
  const setModifiedFilesBySession = useAppStore((s) => s.setModifiedFilesBySession);
  const currentQuote = useAppStore((s) => s.quoteBySession[s.currentSessionId] || null);
  const setQuoteBySession = useAppStore((s) => s.setQuoteBySession);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const isStreaming = activeRunSessionId === currentSessionId;
  const currentMode = currentSession.sessionConfig.mode || "chat";

  const createRequestId = () => `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const formatTokenCount = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);

  const imageAttachmentsForApi = (list: Attachment[]) =>
    list.filter((att) => att.type === "image" && att.data);

  const buildPromptWithAttachments = (message: string, list: Attachment[]) => {
    const usable = list.filter(isSendableAttachment);
    if (usable.length === 0) return message;
    const parts = usable.map((att) => {
      if (att.type === "image") {
        return `[Attached Image: ${att.name}]`;
      }
      const longestFence = Math.max(2, ...(att.data.match(/`+/g) || []).map((run) => run.length));
      const fence = "`".repeat(longestFence + 1);
      return `[Attached File: ${att.name}]\n${fence}\n${att.data}\n${fence}`;
    });
    const trimmed = message.trim();
    return trimmed ? `${parts.join("\n\n")}\n\n${trimmed}` : parts.join("\n\n");
  };

  const serializeMessageForApi = (message: Message) => {
    if (!["user", "assistant", "system"].includes(message.role)) return null;
    const imgs = imageAttachmentsForApi(message.attachments || []);
    const rawContent = message.variants
      ? (message.variants[message.currentVariantIndex || 0] || message.content)
      : message.content;
    const content = message.role === "user"
      ? buildPromptWithAttachments(rawContent, message.attachments || [])
      : rawContent;
    if (message.role === "assistant" && !content.trim()) return null;
    return {
      role: message.role,
      content,
      ...(message.role === "user" && imgs.length > 0 ? { attachments: imgs } : {}),
    };
  };

  const handleCompact = async () => {
    if (!sessionStorageReady || runtime.isStreaming || requestStartingRef.current) return;
    const sessionId = currentSession.id;
    const messages = currentSession.messages;
    if (messages.length < 3) {
      addLog(t("compact.tooShort", lang), "info");
      return;
    }
    if (requestNeedsApiKey(resolvedCurrentConfig)) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error", true, sessionId);
      return;
    }
    const requestId = `compact-${createRequestId()}`;
    runtime.activeRequestId = requestId;
    runtime.activeRequestSessionId = sessionId;
    runtime.requestSessionById[requestId] = sessionId;
    runtime.isStreaming = true;
    setActiveRunSessionId(sessionId);
    setRuntimeBySession((previous) => ({ ...previous, [sessionId]: { requestId, status: "running" } }));
    addLog(t("compact.start", lang), "info", false, sessionId);
    try {
      const result = await invoke<string>("compact_history", {
        currentConfig: resolvedCurrentConfig,
        requestId,
        contextTokenLimit: Math.min(
          modelContextLimitForConfig(resolvedCurrentConfig.model, models, modelCatalogSourceKey, resolvedCurrentConfig),
          resolvedCurrentConfig.context_limit,
        ),
        messages: messages.flatMap((message) => {
          const serialized = serializeMessageForApi(message);
          return serialized ? [{ role: serialized.role, content: serialized.content }] : [];
        }),
      });
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            compactBackup: messages,
            compactBackupContextSummary: s.contextSummary,
            messages: [
              { id: newMessageId(), role: "assistant" as const, content: result, actions: [], timestamp: Date.now() },
            ],
            contextSummary: undefined,
            updatedAt: Date.now(),
          };
        })
      );
      addLog(t("compact.done", lang), "success", false, sessionId);
    } catch (e) {
      const message = String(e);
      if (message.toLowerCase().includes("cancelled")) {
        addLog(t("ui.history-compaction-cancelled", lang), "info", false, sessionId);
      } else {
        addLog(t("compact.failed", lang) + message, "error", true, sessionId);
      }
    } finally {
      finishStreamingLocally(requestId);
    }
  };

  const undoCompact = () => {
    if (sessionMutationLocked || !currentSession.compactBackup) return;
    setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
      ...session,
      messages: session.compactBackup || session.messages,
      contextSummary: session.compactBackupContextSummary,
      compactBackup: undefined,
      compactBackupContextSummary: undefined,
      updatedAt: Date.now(),
    } : session));
    notify(t("ui.conversation-restored", lang), "success");
  };

  // Outbound history is everything after the last context divider. Each
  // serialized message keeps a reference to its source so the auto-compact
  // boundary can be mapped back to a concrete message id.
  const activeHistoryPairs = (messages: Message[]) => {
    let lastDividerIdx = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "context_divider") {
        lastDividerIdx = index;
        break;
      }
    }
    return messages.slice(lastDividerIdx + 1).flatMap((message) => {
      const serialized = serializeMessageForApi(message);
      return serialized ? [{ serialized, source: message }] : [];
    });
  };

  const lastContextDivider = (messages: Message[]) =>
    [...messages].reverse().find((message) => message.role === "context_divider") ?? null;

  const summaryAsOutboundMessage = (summary: ContextSummary) => ({
    role: "user" as const,
    content: `${t("ui.summary-preamble", lang)}\n${summary.summary}`,
  });

  const resolveSessionRequest = (sessionConfig: SessionConfig) => {
    const sessionSearchMode = config.tools_enabled.includes("web_search")
      ? sessionConfig.searchMode
      : "off";
    return {
      requestConfig: resolveRequestConfig(config, sessionConfig, sessionSearchMode),
      searchMode: sessionSearchMode,
    };
  };

  const requestNeedsApiKey = (requestConfig: AppConfig) => (
    !requestConfig.api_key.trim()
    && requestConfig.provider !== "ollama"
    && (requestConfig.base_url.includes("deepseek") || requestConfig.base_url.includes("openai.com"))
  );

  const startAgentRequest = async ({
    targetSessionId,
    sessionConfig,
    history,
    userMessage,
    requestAttachments,
    label = "send",
    onAccepted,
    sessionSnapshot,
    assistantMessageId,
  }: {
    targetSessionId: string;
    sessionConfig: SessionConfig;
    history: Message[];
    userMessage: string;
    requestAttachments: Attachment[];
    label?: string;
    onAccepted?: () => void;
    sessionSnapshot?: ChatSession;
    /** Existing assistant row to receive this run (used by retry variants). */
    assistantMessageId?: string;
  }): Promise<boolean> => {
    if (!sessionStorageReady || runtime.isStreaming || requestStartingRef.current) return false;
    const { requestConfig, searchMode: requestSearchMode } = resolveSessionRequest(sessionConfig);
    if (requestNeedsApiKey(requestConfig)) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error", true, targetSessionId);
      return false;
    }

    const requestId = createRequestId();
    const finalMessage = buildPromptWithAttachments(userMessage, requestAttachments);
    const imageAttachments = imageAttachmentsForApi(requestAttachments);
    const instructionTokens = estimateTextTokens(requestConfig.system_prompt)
      + (requestConfig.role_prompt ? estimateTextTokens(requestConfig.role_prompt) + 24 : 0);
    const reportedModelLimit = modelContextLimitForConfig(
      requestConfig.model,
      models,
      modelCatalogSourceKey,
      requestConfig,
    );
    const requestContextLimit = Math.min(
      reportedModelLimit,
      Math.max(1_000, requestConfig.context_limit || reportedModelLimit),
    );
    requestConfig.context_limit = requestContextLimit;

    // Outbound history: messages after the last divider, with the persisted
    // rolling summary standing in for everything that divider hides. The
    // summary only applies while its own divider is still the latest one.
    const targetSession = sessions.find((session) => session.id === targetSessionId) || sessionSnapshot;
    const historyDivider = lastContextDivider(history);
    const activeSummary = targetSession?.contextSummary
      && historyDivider?.id === targetSession.contextSummary.dividerId
      ? targetSession.contextSummary
      : null;
    const outboundPairs = activeHistoryPairs(history);
    let sessionMessages = [
      ...(activeSummary ? [summaryAsOutboundMessage(activeSummary)] : []),
      ...outboundPairs.map((pair) => pair.serialized),
    ];
    const estimateOutboundTokens = (outbound: typeof sessionMessages) => outbound.reduce((sum, message) => (
      sum
      + estimateTextTokens(String(message.content || ""))
      + ((message as { attachments?: Attachment[] }).attachments || []).length * 1100
      + 6
    ), instructionTokens) + estimateTextTokens(finalMessage) + imageAttachments.length * 1100;
    let estimatedRequestTokens = estimateOutboundTokens(sessionMessages);

    requestStartingRef.current = true;
    setPreparingRequestSessionId(targetSessionId);
    const finishPreparingRequest = () => {
      requestStartingRef.current = false;
      setPreparingRequestSessionId((current) => current === targetSessionId ? null : current);
    };

    // Rolling auto-compact, Claude Code style: past half the model window,
    // fold everything but a recent tail into an LLM summary. The summary is
    // persisted on the session (keyed to a context divider), so it is paid
    // for once and rolls forward as the conversation keeps growing.
    const AUTO_COMPACT_TRIGGER_RATIO = 0.5;
    const AUTO_COMPACT_KEEP_TAIL = 8;
    if (
      estimatedRequestTokens > requestContextLimit * AUTO_COMPACT_TRIGGER_RATIO
      && sessionMessages.length > AUTO_COMPACT_KEEP_TAIL + 4
    ) {
      const cutOutbound = sessionMessages.length - AUTO_COMPACT_KEEP_TAIL;
      // Last source-backed message inside the folded range — the new divider
      // lands right after it. (Index shifts by one when a previous summary
      // occupies slot 0 of the outbound array.)
      const coveredPairs = outboundPairs.slice(0, cutOutbound - (activeSummary ? 1 : 0));
      const boundarySource = coveredPairs[coveredPairs.length - 1]?.source;
      if (boundarySource?.id) {
        addLog(
          t("ui.auto-compacting", lang, { tokens: formatTokenCount(estimatedRequestTokens), count: String(cutOutbound) }),
          "info",
          false,
          targetSessionId,
        );
        try {
          const summaryText = await invoke<string>("compact_history", {
            currentConfig: requestConfig,
            requestId: `autocompact-${requestId}`,
            contextTokenLimit: requestContextLimit,
            messages: sessionMessages.slice(0, cutOutbound).map((message) => ({
              role: message.role,
              content: message.content,
            })),
          });
          if (summaryText && summaryText.trim()) {
            const dividerId = newMessageId();
            const supersededDividerId = activeSummary ? targetSession?.contextSummary?.dividerId ?? null : null;
            const nextSummary: ContextSummary = {
              summary: summaryText.trim(),
              dividerId,
              createdAt: Date.now(),
            };
            if (sessionSnapshot && !sessions.some((session) => session.id === targetSessionId)) {
              const kept = sessionSnapshot.messages.filter((message) => message.id !== supersededDividerId);
              const boundaryIdx = kept.findIndex((message) => message.id === boundarySource.id);
              if (boundaryIdx >= 0) {
                sessionSnapshot.messages = [
                  ...kept.slice(0, boundaryIdx + 1),
                  { id: dividerId, role: "context_divider" as const, content: "" },
                  ...kept.slice(boundaryIdx + 1),
                ];
                sessionSnapshot.contextSummary = nextSummary;
                sessionSnapshot.updatedAt = Date.now();
              }
            }
            setSessions((previous) => previous.map((session) => {
              if (session.id !== targetSessionId) return session;
              const kept = session.messages.filter((message) => message.id !== supersededDividerId);
              const boundaryIdx = kept.findIndex((message) => message.id === boundarySource.id);
              if (boundaryIdx < 0) return session;
              const nextMessages = [
                ...kept.slice(0, boundaryIdx + 1),
                { id: dividerId, role: "context_divider" as const, content: "" },
                ...kept.slice(boundaryIdx + 1),
              ];
              return { ...session, messages: nextMessages, contextSummary: nextSummary, updatedAt: Date.now() };
            }));
            sessionMessages = [summaryAsOutboundMessage(nextSummary), ...sessionMessages.slice(cutOutbound)];
            estimatedRequestTokens = estimateOutboundTokens(sessionMessages);
            addLog(
              t("ui.compacted-summary", lang, { tokens: formatTokenCount(estimatedRequestTokens) }),
              "success",
              false,
              targetSessionId,
            );
          }
        } catch (error) {
          addLog(
            t("ui.auto-compact-failed", lang, { error: String(error) }),
            "error",
            false,
            targetSessionId,
          );
        }
      }
    }

    if (estimatedRequestTokens > requestContextLimit * 0.9) {
      finishPreparingRequest();
      addLog(
        t("ui.context-near-limit", lang, { tokens: formatTokenCount(estimatedRequestTokens), limit: formatTokenCount(requestContextLimit) }),
        "error",
        true,
        targetSessionId,
      );
      return false;
    }

    // Only consume the previous restore point after every pure validation has
    // passed. A rejected oversized request must not destroy the user's ability
    // to restore the last successful run.
    const previousCheckpoint = checkpointBySession[targetSessionId];
    if (previousCheckpoint) {
      try {
        await invoke("delete_git_checkpoint", {
          workDir: previousCheckpoint.workDir,
          reference: previousCheckpoint.reference,
        });
        setCheckpointBySession((previous) => ({ ...previous, [targetSessionId]: null }));
      } catch (error) {
        finishPreparingRequest();
        addLog(`${t("ui.could-not-accept-the-previous", lang)}: ${error}`, "error", true, targetSessionId);
        return false;
      }
    }

    try {
      onAccepted?.();
    } catch (error) {
      finishPreparingRequest();
      addLog(`${t("ui.could-not-start-request", lang)}: ${error}`, "error", true, targetSessionId);
      return false;
    }

    runtime.activeRequestId = requestId;
    runtime.activeRequestSessionId = targetSessionId;
    if (assistantMessageId) {
      runtime.assistantMessageIdByRequest[requestId] = assistantMessageId;
    }
    runtime.activeRequestModel = requestConfig.model;
    runtime.activeRequestWorkDir = requestConfig.default_work_dir;
    runtime.activeRequestContextTokens = estimatedRequestTokens;
    runtime.requestSessionById[requestId] = targetSessionId;
    runtime.isStreaming = true;
    setActiveRunSessionId(targetSessionId);
    setRuntimeBySession((previous) => ({
      ...previous,
      [targetSessionId]: { requestId, status: "running" },
    }));
    setPendingApprovalsBySession((previous) => ({ ...previous, [targetSessionId]: null }));
    setUsageStatsBySession((previous) => ({ ...previous, [targetSessionId]: null }));
    setCheckpointBySession((previous) => ({ ...previous, [targetSessionId]: null }));
    setModifiedFilesBySession((previous) => ({ ...previous, [targetSessionId]: {} }));
    finishPreparingRequest();

    addLog(
      `[Request:${label} ${requestId}] mode=${sessionConfig.mode} model=${requestConfig.model} history=${sessionMessages.length}`,
      "info",
      false,
      targetSessionId,
    );

    try {
      await invoke("start_agent_session", {
        requestId,
        prompt: finalMessage,
        config: requestConfig,
        sessionMessages,
        sessionMode: sessionConfig.mode,
        searchMode: requestSearchMode,
        imageAttachments,
      });
      if (runtime.activeRequestId === requestId) finishStreamingLocally(requestId);
      return true;
    } catch (error) {
      if (runtime.activeRequestId === requestId) finishStreamingLocally(requestId);
      addLog(`Agent error: ${error}`, "error", true, targetSessionId);
      const errorContent = `Error: ${error}`;
      setSessions((previous) => previous.map((session) => {
        if (session.id !== targetSessionId) return session;
        const assistantIndex = assistantMessageId
          ? session.messages.findIndex((message) => message.id === assistantMessageId && message.role === "assistant")
          : -1;
        if (assistantIndex < 0) {
          return {
            ...session,
            messages: [
              ...session.messages,
              { id: newMessageId(), role: "assistant", content: errorContent, actions: [], timestamp: Date.now() },
            ],
            updatedAt: Date.now(),
          };
        }
        const messages = [...session.messages];
        const assistant = { ...messages[assistantIndex] };
        const variants = assistant.variants && assistant.variants.length > 0
          ? [...assistant.variants]
          : [assistant.content];
        const variantIndex = Math.max(0, Math.min(variants.length - 1, assistant.currentVariantIndex || 0));
        variants[variantIndex] = errorContent;
        assistant.variants = variants;
        assistant.currentVariantIndex = variantIndex;
        assistant.content = errorContent;
        messages[assistantIndex] = assistant;
        return { ...session, messages, updatedAt: Date.now() };
      }));
      return false;
    }
  };

  const createBranchSession = (source: ChatSession, messages: Message[]) => {
    const branch = createSession(
      source.sessionConfig.mode,
      `${source.title || t("session.new", lang)} ${t("ui.branch", lang)}`,
      messages,
    );
    branch.sessionConfig = { ...source.sessionConfig };
    branch.contextSummary = source.contextSummary
      && messages.some((message) => message.id === source.contextSummary?.dividerId)
      ? source.contextSummary
      : undefined;
    return branch;
  };

  const handleSendMessage = async () => {
    if (!sessionStorageReady) return;
    const sendableAttachments = fitAttachmentBudget([], attachments).accepted;
    if ((!prompt.trim() && sendableAttachments.length === 0 && !currentQuote) || runtime.isStreaming || requestStartingRef.current || isAttachmentLoading) return;

    // Quick commands using helper
    const { isCommand, command } = parseCommand(prompt.trim());
    if (isCommand && sendableAttachments.length === 0) {
      setPrompt("");

      if (command === "clear") {
        setSessions(prev => prev.map(s => s.id === currentSessionId ? {
          ...s,
          messages: [...s.messages, { id: newMessageId(), role: "context_divider" as const, content: "" }]
        } : s));
        return;
      }

      if (command === "compact") {
        await handleCompact();
        return;
      }

      if (command === "export") {
        const session = sessions.find(s => s.id === currentSessionId);
        if (session) {
          const md = sessionToMarkdown(session.title, session.messages);
          const blob = new Blob([md], { type: 'text/markdown' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${session.title}.md`;
          a.click();
          URL.revokeObjectURL(url);
          notify("已导出为 Markdown", "success");
        }
        return;
      }

      if (command === "help") {
        notify("快捷命令：/clear /compact /export /help", "info");
        return;
      }
    }

    const { requestConfig } = resolveSessionRequest(currentSession.sessionConfig);
    if (requestNeedsApiKey(requestConfig)) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error", true, currentSessionId);
      return;
    }

    const targetSessionId = currentSessionId;
    const targetSession = currentSession;
    // A pending quote draft rides along as a markdown blockquote prefix — the
    // rendered user bubble shows it as a normal quote, no schema changes.
    const quote = currentQuote;
    const userMessage = quote
      ? formatQuoteReply(quote.excerpt, prompt.trim())
      : prompt.trim();
    const pendingAttachments = [...sendableAttachments];
    const shouldGenerateTitle = targetSession.messages.length === 0 && !targetSession.title.trim();
    const localTitle = fallbackSessionTitle(userMessage, pendingAttachments[0]?.name);
    await startAgentRequest({
      targetSessionId,
      sessionConfig: targetSession.sessionConfig,
      history: targetSession.messages,
      userMessage,
      requestAttachments: pendingAttachments,
      onAccepted: () => {
        if (shouldGenerateTitle) {
          runtime.pendingTitleBySession[targetSessionId] = {
            userMessage: userMessage || pendingAttachments.map((attachment) => attachment.name).join(", "),
            fallbackTitle: localTitle,
            config: requestConfig,
          };
        }
        setDraftsBySession((previous) => ({ ...previous, [targetSessionId]: "" }));
        setAttachmentsBySession((previous) => ({ ...previous, [targetSessionId]: [] }));
        if (quote) setQuoteBySession((previous) => ({ ...previous, [targetSessionId]: null }));
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== targetSessionId) return s;
            const title = s.messages.length === 0 && !s.title.trim() ? localTitle : s.title;
            return {
              ...s,
              title,
              messages: [
                ...s.messages,
                {
                  id: newMessageId(),
                  role: "user" as const,
                  content: userMessage,
                  attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
                  timestamp: Date.now(),
                },
              ],
              compactBackup: undefined,
              updatedAt: Date.now(),
            };
          })
        );
      },
    });
  };

  const handleStopStreaming = async () => {
    const requestId = runtime.activeRequestId;
    const sessionId = runtime.activeRequestSessionId;
    if (!requestId || !runtime.isStreaming || sessionId !== currentSessionId || currentRuntime?.status === "stopping") return;

    try {
      setRuntimeBySession((previous) => ({
        ...previous,
        [sessionId]: { requestId, status: "stopping" },
      }));
      await invoke("cancel_agent_session", { requestId });
      addLog(t("ui.stop-requested-for-current-output", lang), "info", false, sessionId);
    } catch (e) {
      addLog(`Stop request failed: ${e}`, "error", true, sessionId);
      if (runtime.activeRequestId === requestId) {
        setRuntimeBySession((previous) => ({
          ...previous,
          [sessionId]: { requestId, status: "running" },
        }));
      }
    }
  };

  const handleSteeringMessage = async () => {
    const message = prompt.trim();
    const sessionId = runtime.activeRequestSessionId;
    const requestId = runtime.activeRequestId;
    if (!message || !isStreaming || sessionId !== currentSessionId || !requestId || currentMode !== "code") return;
    try {
      await invoke("push_steering_message", { requestId, message });
      setSessions(prev => prev.map(s => s.id === sessionId ? {
        ...s,
        messages: [...s.messages, { id: newMessageId(), role: "user" as const, content: `[Steering] ${message}`, timestamp: Date.now() }],
        updatedAt: Date.now(),
      } : s));
      setPrompt("");
      addLog(t("ui.steering-message-sent", lang), "info", false, sessionId);
    } catch (e) {
      addLog(`Steering error: ${e}`, "error", true, sessionId);
    }
  };

  const handleRetry = async (msgIdx: number) => {
    if (!sessionStorageReady || runtime.isStreaming || requestStartingRef.current) return;
    const msgs = currentSession.messages;
    let userIndex = -1;
    for (let i = msgIdx; i >= 0; i--) {
      if (msgs[i].role === "user") {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;
    const userMessage = msgs[userIndex];
    const userAttachments = [...(userMessage.attachments || [])];
    const userText = userMessage.content;
    if (!userText && userAttachments.length === 0) return;

    const assistantMessage = msgs[msgIdx];
    if (!assistantMessage || assistantMessage.role !== "assistant") return;
    const assistantMessageId = assistantMessage.id || newMessageId();
    const existingVariants = assistantMessage.variants && assistantMessage.variants.length > 0
      ? [...assistantMessage.variants]
      : [assistantMessage.content];
    const activeVariantIndex = Math.max(
      0,
      Math.min(existingVariants.length - 1, assistantMessage.currentVariantIndex || 0),
    );
    // `content` is the active variant in the persisted shape. Repair a stale
    // legacy value before adding the fresh slot so the visible answer is not
    // duplicated or lost when the user clicks retry.
    existingVariants[activeVariantIndex] = assistantMessage.content;
    const nextVariantIndex = existingVariants.length;

    await startAgentRequest({
      targetSessionId: currentSession.id,
      sessionConfig: currentSession.sessionConfig,
      history: msgs.slice(0, userIndex),
      userMessage: userText,
      requestAttachments: userAttachments,
      label: "retry",
      assistantMessageId,
      onAccepted: () => {
        setSessions((previous) => previous.map((session) => {
          if (session.id !== currentSession.id) return session;
          const messages = session.messages.map((message) => {
            if (message.id !== assistantMessageId || message.role !== "assistant") return message;
            return {
              ...message,
              id: assistantMessageId,
              content: "",
              variants: [...existingVariants, ""],
              currentVariantIndex: nextVariantIndex,
              actions: [],
              reasoningContent: undefined,
              usage: undefined,
              contextTokens: undefined,
              searchStatus: undefined,
              timestamp: Date.now(),
            };
          });
          return { ...session, messages, updatedAt: Date.now() };
        }));
      },
    });
  };

  const handleEditBranch = async (msgIdx: number) => {
    if (!sessionStorageReady || runtime.isStreaming || requestStartingRef.current) return;
    const sourceMessage = currentSession.messages[msgIdx];
    if (!sourceMessage) return;
    const editedMessage: Message = {
      ...sourceMessage,
      content: editText,
      variants: undefined,
      currentVariantIndex: undefined,
      timestamp: Date.now(),
    };
    const branch = createBranchSession(
      currentSession,
      [...currentSession.messages.slice(0, msgIdx), editedMessage],
    );
    if (editedMessage.role !== "user") {
      setSessions((previous) => [...previous, branch]);
      setCurrentSessionId(branch.id);
      setSidebarNav(branch.sessionConfig.mode);
      setEditingMessageIdx(null);
      return;
    }
    const editedAttachments = [...(editedMessage.attachments || [])];
    if (!editedMessage.content.trim() && editedAttachments.length === 0) {
      setSessions((previous) => [...previous, branch]);
      setCurrentSessionId(branch.id);
      setSidebarNav(branch.sessionConfig.mode);
      setEditingMessageIdx(null);
      return;
    }
    await startAgentRequest({
      targetSessionId: branch.id,
      sessionConfig: branch.sessionConfig,
      history: currentSession.messages.slice(0, msgIdx),
      sessionSnapshot: branch,
      userMessage: editedMessage.content,
      requestAttachments: editedAttachments,
      label: "edit-branch",
      onAccepted: () => {
        setSessions((previous) => [...previous, branch]);
        setCurrentSessionId(branch.id);
        setSidebarNav(branch.sessionConfig.mode);
        setEditingMessageIdx(null);
      },
    });
  };

  const handleBranchFromMessage = (msgIdx: number) => {
    if (!sessionStorageReady || runtime.isStreaming || requestStartingRef.current) return;
    const sourceMessage = currentSession.messages[msgIdx];
    if (!sourceMessage || sourceMessage.role === "context_divider") return;
    const branch = createBranchSession(currentSession, currentSession.messages.slice(0, msgIdx + 1).map((message) => ({ ...message })));
    setSessions((previous) => [...previous, branch]);
    setCurrentSessionId(branch.id);
    setSidebarNav(branch.sessionConfig.mode);
  };

  return {
    formatTokenCount,
    undoCompact,
    handleSendMessage,
    handleStopStreaming,
    handleSteeringMessage,
    handleRetry,
    handleEditBranch,
    handleBranchFromMessage,
  };
}
