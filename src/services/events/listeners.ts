import { listen } from "@tauri-apps/api/event";
import { t } from "../../i18n";
import {
  comparableWorkspacePath,
  estimateTextTokens,
  resolveWorkspacePath,
  type AgentEventPayload,
} from "../../appDefaults";
import { normalizeLearningContext, normalizeSnapshots } from "../../utils/learning";
import type { ContextSnapshot, LearningContext, PendingApproval, SearchStatus, ToolAction } from "../../types";
import { useAppStore } from "../../store/appStore";
import { useCodexStore, type CodexQuestion } from "../../store/codexStore";
import { useWorkspaceViewStore } from "../../store/workspaceViewStore";
import { runtime } from "../agentRuntime";
import { addLog } from "./notifications";
import {
  agentEventSessionId,
  ensureRequestAssistant,
  findRequestAssistantIndex,
  isCurrentRequestPayload,
  payloadContent,
  payloadRequestId,
  updateRequestAssistantAction,
} from "./helpers";
import { discardStreamBuffer, flushStreamBufferNow, queueStreamChunk } from "./streamBuffer";
import { finishStreamingLocally, refreshWorkspace, requestGeneratedSessionTitle, upsertToolActions } from "./sessionSync";

const store = () => useAppStore.getState();

async function registerContextAndCodexListeners(unlisteners: (() => void)[]) {
  unlisteners.push(await listen<{ requestId: string; snapshot: ContextSnapshot }>("agent-context", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const snapshots = normalizeSnapshots([event.payload.snapshot]);
    if (!snapshots?.length) return;
    const sessionId = agentEventSessionId(event.payload);
    store().setSessions((previous) => previous.map((session) => {
      if (session.id !== sessionId) return session;
      const messages = [...session.messages];
      const index = ensureRequestAssistant(messages, event.payload.requestId);
      messages[index] = {
        ...messages[index],
        contextSnapshots: [...(messages[index].contextSnapshots || []), ...snapshots].slice(-6),
      };
      return { ...session, messages };
    }));
  }));

  unlisteners.push(await listen<{ requestId: string; learning: LearningContext }>("agent-learning-context", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const learningContext = normalizeLearningContext(event.payload.learning);
    if (!learningContext) return;
    const sessionId = agentEventSessionId(event.payload);
    store().setSessions((previous) => previous.map((session) => {
      if (session.id !== sessionId) return session;
      const messages = [...session.messages];
      const index = ensureRequestAssistant(messages, event.payload.requestId);
      messages[index] = { ...messages[index], learningContext };
      return { ...session, messages };
    }));
  }));

  unlisteners.push(await listen<{ requestId: string; threadId: string; workDir: string; model?: string }>("agent-codex-thread", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    runtime.activeCodexTurnStarted = true;
    const sessionId = agentEventSessionId(event.payload);
    const { threadId, workDir, model } = event.payload;
    if (model) runtime.activeRequestModel = model;
    store().setSessions((sessions) => sessions.map((session) => (
      session.id === sessionId ? { ...session, codexThread: { id: threadId, workDir, historyKey: "" } } : session
    )));
  }));

  unlisteners.push(await listen<{ requestId: string; question: CodexQuestion | null }>("agent-codex-question", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    useCodexStore.getState().setQuestion(agentEventSessionId(event.payload), event.payload.question);
  }));

  unlisteners.push(await listen<void>("open-settings", () => {
    store().setSettingsOpen(true);
  }));

  unlisteners.push(await listen<string>("config-import-rekey", (event) => {
    addLog(event.payload, "error");
    store().setSettingsOpen(true);
  }));

  unlisteners.push(await listen<string>("config-import-warning", (event) => {
    addLog(event.payload, "info", true);
  }));
}

async function registerStreamListeners(unlisteners: (() => void)[]) {
  unlisteners.push(await listen<{ requestId?: string; attempt: number; maxAttempts: number; delaySeconds: number; reason: string }>("agent-retry", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const sessionId = agentEventSessionId(event.payload);
    addLog(
      runtime.lang === "zh"
        ? ("模型请求失败，" + event.payload.delaySeconds + " 秒后进行第 " + event.payload.attempt + "/" + event.payload.maxAttempts + " 次尝试（" + event.payload.reason + "）")
        : ("Model request failed; retry " + event.payload.attempt + "/" + event.payload.maxAttempts + " in " + event.payload.delaySeconds + "s (" + event.payload.reason + ")"),
      "info",
      false,
      sessionId,
    );
  }));

  unlisteners.push(await listen<AgentEventPayload>("agent-stream-chunk", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    let payload = payloadContent(event.payload);
    if (!payload) return;
    if (payload.includes("DSML")) {
      payload = payload.replace(/<[｜|][｜|][^>]*>/g, "");
      payload = payload.replace(/<\/[｜|][｜|][^>]*>/g, "");
      if (!payload.trim()) return;
    }
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    const sessionId = agentEventSessionId(event.payload);
    queueStreamChunk(requestId, sessionId, payload);
  }));

  unlisteners.push(await listen<SearchStatus>("agent-search-status", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const status = event.payload;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    store().setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = [...s.messages];
      const existingIndex = findRequestAssistantIndex(messages, requestId);
      if (existingIndex < 0 && status.type === "searching") return s;
      const assistantIndex = existingIndex >= 0
        ? existingIndex
        : ensureRequestAssistant(messages, requestId, { searchStatus: [status] });
      if (existingIndex < 0) return { ...s, messages };
      const assistant = { ...messages[assistantIndex] };
      if (assistant.role !== "assistant") return s;
      const existing = assistant.searchStatus || [];
      if (status.type === "searching") {
        assistant.searchStatus = [...existing, status];
      } else if (status.type === "results" || status.type === "error") {
        const lastSearchIdx = [...existing].reverse().findIndex((item) => item.type === "searching" && item.query === status.query);
        if (lastSearchIdx !== -1) {
          const realIdx = existing.length - 1 - lastSearchIdx;
          const updated = [...existing];
          updated[realIdx] = { ...updated[realIdx], ...status };
          assistant.searchStatus = updated;
        } else {
          assistant.searchStatus = [...existing, status];
        }
      }
      messages[assistantIndex] = assistant;
      return { ...s, messages };
    }));
  }));

  unlisteners.push(await listen<AgentEventPayload>("agent-reasoning-chunk", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const payload = payloadContent(event.payload);
    if (!payload) return;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    store().setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = [...s.messages];
      const existingIndex = findRequestAssistantIndex(messages, requestId);
      const assistantIndex = existingIndex >= 0
        ? existingIndex
        : ensureRequestAssistant(messages, requestId, { reasoningContent: payload });
      if (existingIndex >= 0) {
        const assistant = { ...messages[assistantIndex] };
        assistant.reasoningContent = (assistant.reasoningContent || "") + payload;
        messages[assistantIndex] = assistant;
      }
      return { ...s, messages };
    }));
  }));
}

async function registerToolListeners(unlisteners: (() => void)[]) {
  unlisteners.push(await listen<{
    requestId?: string;
    status: string;
    serverStatuses: Array<{
      name: string;
      status: "started" | "error";
      toolCount: number;
      error?: string | null;
    }>;
  }>("agent-mcp-status", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const requestId = event.payload.requestId || runtime.activeRequestId;
    const sessionId = agentEventSessionId(event.payload);
    const startedNames = event.payload.serverStatuses
      .filter((server) => server.status === "started")
      .map((server) => server.name);
    if (requestId) runtime.mcpRuntimeNamesByRequest[requestId] = startedNames;
    store().setMcpStatusByName((previous) => {
      const next = { ...previous };
      for (const server of event.payload.serverStatuses) {
        next[server.name] = server.status === "started"
          ? {
              state: "ready",
              toolCount: server.toolCount,
              message: runtime.lang === "zh" ? "本轮已启动" : "Active in this run",
            }
          : {
              state: "error",
              toolCount: 0,
              message: server.error || (runtime.lang === "zh" ? "启动失败" : "Failed to start"),
            };
      }
      return next;
    });
    for (const server of event.payload.serverStatuses.filter((item) => item.status === "error")) {
      addLog(`MCP ${server.name}: ${server.error || "Failed to start"}`, "error", true, sessionId);
    }
  }));

  unlisteners.push(await listen<{ index: number; id: string; name: string; arguments: string }>("agent-tool-drafting", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const { id: toolId, name, arguments: args } = event.payload;
    if (!toolId) return;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    store().setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = [...s.messages];
      const assistantIndex = ensureRequestAssistant(messages, requestId);
      const assistant = { ...messages[assistantIndex] };
      const actions = assistant.actions ? [...assistant.actions] : [];
      const index = actions.findIndex((action) => action.id === toolId);
      if (index < 0) {
        actions.push({ id: toolId, name, arguments: args, status: "drafting" });
      } else if (actions[index].status === "drafting") {
        actions[index] = { ...actions[index], name: name || actions[index].name, arguments: args };
      }
      assistant.actions = actions;
      messages[assistantIndex] = assistant;
      return { ...s, messages };
    }));
  }));

  unlisteners.push(await listen<{
    id: string;
    name: string;
    arguments: string;
    path?: string;
    beforeExists?: boolean;
    beforeContent?: string | null;
  }>("agent-tool-executing", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const { id, name, arguments: args } = event.payload;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    addLog(`[Exec] ${name}: ${args.substring(0, 200)}`, "cmd", false, sessionId);
    if (name === "write_file" || name === "edit_file") {
      try {
        const parsed = JSON.parse(args);
        const filePath = event.payload.path || parsed.path || "";
        if (filePath) {
          const oldContent = event.payload.beforeExists ? (event.payload.beforeContent || "") : "";
          const optimisticNewContent = name === "write_file" ? (parsed.content || "") : oldContent;
          store().setModifiedFilesBySession((previous) => {
            const existing = previous[sessionId]?.[filePath];
            return {
              ...previous,
              [sessionId]: {
                ...(previous[sessionId] || {}),
                [filePath]: { old: existing?.old ?? oldContent, new: optimisticNewContent },
              },
            };
          });
        }
      } catch {}
    }
    store().setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = upsertToolActions(s.messages, [{ id, name, arguments: args, status: "executing" as const }], requestId);
      updateRequestAssistantAction(messages, requestId, id, (action) => ({ ...action, status: "executing" as const }));
      return { ...s, messages };
    }));
  }));

  unlisteners.push(await listen<{ requestId?: string; id: string; name: string; stream: string; content: string }>("agent-tool-output-chunk", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = event.payload.requestId || runtime.activeRequestId;
    runtime.streamedToolOutputKeys.add(`${requestId}:${event.payload.id}`);
    if (event.payload.content) {
      addLog(event.payload.content, event.payload.stream === "stderr" ? "error" : "cmd", false, sessionId);
    }
  }));

  unlisteners.push(await listen<{
    requestId?: string;
    status: string;
    reference?: string;
    commit?: string;
    createdAt?: number;
    label?: string;
    error?: string;
  }>("agent-checkpoint", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const sessionId = agentEventSessionId(event.payload);
    if (event.payload.status === "created" && event.payload.reference && event.payload.commit) {
      store().setCheckpointBySession((previous) => previous[sessionId] ? previous : {
        ...previous,
        [sessionId]: {
          reference: event.payload.reference!,
          commit: event.payload.commit!,
          createdAt: event.payload.createdAt || Date.now(),
          label: event.payload.label || "before tool execution",
          workDir: runtime.activeRequestWorkDir,
        },
      });
    } else if (event.payload.error) {
      addLog(event.payload.error, "info", false, sessionId);
    }
  }));

  unlisteners.push(await listen<{
    requestId?: string;
    id: string;
    name: string;
    output: string;
    path?: string;
    afterExists?: boolean;
    afterContent?: string | null;
  }>("agent-tool-output", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const { id, name, output } = event.payload;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    const outputKey = `${requestId}:${id}`;
    const isErrorOutput = output.trimStart().startsWith("Error:");
    if (!runtime.streamedToolOutputKeys.has(outputKey)) {
      addLog(
        `[${isErrorOutput ? "Error" : "Done"}] ${name}: ${output.substring(0, 200)}${output.length > 200 ? "..." : ""}`,
        isErrorOutput ? "error" : "success",
        false,
        sessionId,
      );
    }
    if (!isErrorOutput && ["write_file", "edit_file", "execute_command", "run_python"].includes(name)) {
      const requestWorkDir = runtime.activeRequestWorkDir;
      void refreshWorkspace(sessionId, requestWorkDir);
      const visibleSessionId = store().currentSessionId;
      if (visibleSessionId !== sessionId && runtime.effectiveWorkDir === requestWorkDir) {
        void refreshWorkspace(visibleSessionId, requestWorkDir);
      }
    }
    if (name === "write_file" || name === "edit_file") {
      const filePath = event.payload.path || "";
      const content = event.payload.afterContent;
      if (filePath) {
        store().setModifiedFilesBySession((previous) => {
          const files = { ...(previous[sessionId] || {}) };
          const old = files[filePath]?.old || "";
          if (event.payload.afterExists && typeof content === "string" && content !== old) {
            files[filePath] = { old, new: content };
          } else {
            delete files[filePath];
          }
          return { ...previous, [sessionId]: files };
        });
      }
      if (filePath && event.payload.afterExists && typeof content === "string") {
        if (!isErrorOutput && /\.(html?|svg)$/i.test(filePath)) {
          store().setPreviewBySession((previous) => ({ ...previous, [sessionId]: content }));
        }
        const absoluteFilePath = resolveWorkspacePath(runtime.activeRequestWorkDir, filePath);
        const views = useWorkspaceViewStore.getState();
        for (const [viewSessionId, file] of Object.entries(views.files)) {
          if (comparableWorkspacePath(file.workDir) !== comparableWorkspacePath(runtime.activeRequestWorkDir)
            || !file.path
            || comparableWorkspacePath(resolveWorkspacePath(file.workDir, file.path)) !== comparableWorkspacePath(absoluteFilePath)) continue;
          runtime.fileRequestSequence[viewSessionId] = (runtime.fileRequestSequence[viewSessionId] || 0) + 1;
          views.setFile(viewSessionId, { content, loading: false, error: "" });
        }
      }
    }
    store().setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = upsertToolActions(s.messages, [{
        id,
        name,
        arguments: "",
        status: isErrorOutput ? "error" as const : "done" as const,
        output,
      }], requestId);
      updateRequestAssistantAction(messages, requestId, id, (action) => ({
        ...action,
        status: isErrorOutput ? "error" as const : "done" as const,
        output,
      }));
      return { ...s, messages };
    }));
  }));

  unlisteners.push(await listen<{ requestId?: string; id: string; name: string; reason: string }>("agent-tool-blocked", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const { id, name, reason } = event.payload;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    addLog(`[Blocked] ${name}: ${reason}`, "error", false, sessionId);
    store().setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = upsertToolActions(s.messages, [{
        id,
        name,
        arguments: "",
        status: "blocked" as const,
        output: reason,
      }], requestId);
      updateRequestAssistantAction(messages, requestId, id, (action) => ({
        ...action,
        status: "blocked" as const,
        output: reason,
      }));
      return { ...s, messages };
    }));
  }));

  unlisteners.push(await listen<PendingApproval>("agent-tool-approval-request", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    store().setPendingApprovalsBySession((previous) => ({ ...previous, [sessionId]: event.payload }));
    const pendingActions: ToolAction[] = event.payload.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: "pending_approval" as const,
    }));
    store().setSessions((prev) => prev.map((s) => (
      s.id === sessionId ? { ...s, messages: upsertToolActions(s.messages, pendingActions, requestId) } : s
    )));
  }));

  unlisteners.push(await listen<{ requestId?: string; approvalRequestId?: string }>("agent-tool-approval-cancelled", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    const pending = store().pendingApprovalsBySession[sessionId];
    if (event.payload.approvalRequestId && pending?.request_id !== event.payload.approvalRequestId) return;
    const itemIds = new Set(pending?.tool_calls.map((call) => call.id));
    store().setPendingApprovalsBySession((previous) => ({ ...previous, [sessionId]: null }));
    store().setSessions((prev) => prev.map((session) => {
      if (session.id !== sessionId) return session;
      const messages = [...session.messages];
      const assistantIndex = findRequestAssistantIndex(messages, requestId);
      if (assistantIndex < 0) return session;
      const assistant = { ...messages[assistantIndex] };
      if (assistant.role !== "assistant" || !assistant.actions) return session;
      assistant.actions = assistant.actions.map((action) => action.status === "pending_approval" && (!pending || itemIds.has(action.id))
        ? { ...action, status: "blocked" as const, output: "Approval is no longer pending." }
        : action);
      messages[assistantIndex] = assistant;
      return { ...session, messages };
    }));
  }));

  unlisteners.push(await listen<{ requestId: string; approvalRequestId: string; itemId: string; approved: boolean }>("agent-tool-approval-resolved", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const { requestId, approvalRequestId, itemId, approved } = event.payload;
    const sessionId = agentEventSessionId(event.payload);
    store().setPendingApprovalsBySession((previous) => (
      previous[sessionId]?.request_id === approvalRequestId ? { ...previous, [sessionId]: null } : previous
    ));
    store().setSessions((previous) => previous.map((session) => {
      if (session.id !== sessionId) return session;
      const messages = [...session.messages];
      updateRequestAssistantAction(messages, requestId, itemId, (action) => action.status === "pending_approval"
        ? { ...action, status: approved ? "executing" : "blocked", ...(approved ? {} : { output: "Declined by user." }) }
        : action);
      return { ...session, messages };
    }));
  }));
}

async function registerLifecycleListeners(unlisteners: (() => void)[]) {
  unlisteners.push(await listen<{
    requestId?: string;
    content?: string;
    authoritative?: boolean;
    loopCount?: number;
    ttftMs?: number;
    responseTimeMs?: number;
  }>("agent-stream-done", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    flushStreamBufferNow();
    const done = event.payload || {};
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    store().setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = [...s.messages];
      const authoritative = done.authoritative === true && typeof done.content === "string";
      const assistantIndex = authoritative
        ? ensureRequestAssistant(messages, requestId)
        : findRequestAssistantIndex(messages, requestId);
      if (assistantIndex < 0) return s;
      const assistant = { ...messages[assistantIndex] };
      if (assistant.role !== "assistant") return s;
      if (authoritative) {
        const variantIndex = assistant.currentVariantIndex || 0;
        assistant.content = done.content!;
        assistant.variants = [...(assistant.variants || [assistant.content])];
        assistant.variants[variantIndex] = assistant.content;
        assistant.currentVariantIndex = variantIndex;
      }
      const usage = assistant.usage || {
        promptTokens: assistant.contextTokens || runtime.activeRequestContextTokens || 0,
        completionTokens: estimateTextTokens(assistant.content),
        totalPromptTokens: assistant.contextTokens || runtime.activeRequestContextTokens || 0,
        totalCompletionTokens: estimateTextTokens(assistant.content),
        ttftMs: done.ttftMs || 0,
        responseTimeMs: done.responseTimeMs || 0,
        loopCount: done.loopCount || 1,
      };
      assistant.model = assistant.model || runtime.activeRequestModel;
      assistant.contextTokens = assistant.contextTokens || runtime.activeRequestContextTokens;
      assistant.usage = {
        ...usage,
        completionTokens: usage.completionTokens || estimateTextTokens(assistant.content),
        ttftMs: done.ttftMs ?? usage.ttftMs,
        responseTimeMs: done.responseTimeMs ?? usage.responseTimeMs,
        loopCount: done.loopCount ?? usage.loopCount,
      };
      messages[assistantIndex] = assistant;
      return { ...s, messages };
    }));
  }));

  unlisteners.push(await listen<AgentEventPayload<{ status?: string }>>("agent-complete", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    flushStreamBufferNow();
    const status = typeof event.payload === "string" ? "" : event.payload.status;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    const mcpRuntimeNames = runtime.mcpRuntimeNamesByRequest[requestId] || [];
    if (mcpRuntimeNames.length > 0) {
      store().setMcpStatusByName((previous) => {
        const next = { ...previous };
        for (const name of mcpRuntimeNames) {
          if (next[name]?.message === "Active in this run" || next[name]?.message === "本轮已启动") {
            next[name] = { state: "stopped" };
          }
        }
        return next;
      });
    }
    delete runtime.mcpRuntimeNamesByRequest[requestId];
    const completedWorkDir = runtime.activeRequestWorkDir;
    void refreshWorkspace(sessionId, completedWorkDir);
    const visibleSessionId = store().currentSessionId;
    if (visibleSessionId !== sessionId && runtime.effectiveWorkDir === completedWorkDir) {
      void refreshWorkspace(visibleSessionId, completedWorkDir);
    }
    finishStreamingLocally(requestId, status === "cancelled" ? "stopped" : status === "error" ? "error" : "completed");
    const eventLang = runtime.lang;
    addLog(status === "cancelled" ? (eventLang === "zh" ? "已停止当前输出。" : "Current output stopped.") : t("log.complete", eventLang), "info", false, sessionId);
    if (status !== "cancelled" && status !== "error" && runtime.pendingTitleBySession[sessionId]) {
      requestAnimationFrame(() => { void requestGeneratedSessionTitle(sessionId); });
    }
  }));

  unlisteners.push(await listen<{
    requestId?: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    cached_tokens?: number;
    cache_creation_tokens?: number;
    total_cached_tokens?: number;
    total_cache_creation_tokens?: number;
    ttft_ms: number;
    response_time_ms: number;
    loop_count: number;
  }>("agent-usage", (event) => {
    if (!isCurrentRequestPayload(event.payload)) return;
    const sessionId = agentEventSessionId(event.payload);
    const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
    const usage = {
      promptTokens: event.payload.prompt_tokens,
      completionTokens: event.payload.completion_tokens,
      totalPromptTokens: event.payload.total_prompt_tokens,
      totalCompletionTokens: event.payload.total_completion_tokens,
      cachedTokens: event.payload.cached_tokens,
      cacheCreationTokens: event.payload.cache_creation_tokens,
      totalCachedTokens: event.payload.total_cached_tokens,
      totalCacheCreationTokens: event.payload.total_cache_creation_tokens,
      ttftMs: event.payload.ttft_ms,
      responseTimeMs: event.payload.response_time_ms,
      loopCount: event.payload.loop_count,
    };
    store().setUsageStatsBySession((previous) => ({ ...previous, [sessionId]: usage }));
    store().setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const messages = [...s.messages];
      if (messages.length === 0) return s;
      const assistantIndex = findRequestAssistantIndex(messages, requestId);
      const targetIndex = assistantIndex >= 0 ? assistantIndex : messages.length - 1;
      const assistant = { ...messages[targetIndex] };
      if (assistant.role !== "assistant") return s;
      assistant.model = assistant.model || runtime.activeRequestModel;
      assistant.contextTokens = usage.promptTokens || assistant.contextTokens || runtime.activeRequestContextTokens;
      assistant.usage = usage;
      messages[targetIndex] = assistant;
      return { ...s, messages };
    }));
  }));
}

let initialized = false;

export async function initAgentEventListeners(): Promise<() => void> {
  if (initialized) return () => {};
  initialized = true;

  const unlisteners: (() => void)[] = [];
  try {
    await registerContextAndCodexListeners(unlisteners);
    await registerStreamListeners(unlisteners);
    await registerToolListeners(unlisteners);
    await registerLifecycleListeners(unlisteners);
  } catch (e) {
    addLog(`Listener setup failed: ${e}`, "error");
  }

  return () => {
    initialized = false;
    discardStreamBuffer();
    unlisteners.splice(0).forEach((fn) => fn());
  };
}
