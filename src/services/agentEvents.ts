/**
 * Tauri event pipeline for agent runs, registered once per app lifetime.
 *
 * Everything here used to live inside App.tsx effects and closures. Handlers
 * now operate purely on the zustand store (`useAppStore.getState()` + stable
 * setters) and the module-level `runtime` singleton, so streaming no longer
 * re-registers or reconciles through React component closures.
 */
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";
import { runtime, uiCallbacks } from "./agentRuntime";
import { t } from "../i18n";
import {
  newMessageId,
  createEmptyWorkspaceState,
  resolveWorkspacePath,
  comparableWorkspacePath,
  estimateTextTokens,
  type AgentEventPayload,
} from "../appDefaults";
import { normalizeGeneratedTitle } from "../utils/sessionTitle";
import type { Message, ToolAction, PendingApproval, SearchStatus } from "../types";
// Type-only imports: erased at compile time, so no runtime dependency on components.
import type { DirectoryNode } from "../components/workspace/WorkspaceTree";
import type { GitStatusEntry } from "../components/workspace/WorkspaceChanges";

const store = () => useAppStore.getState();

// ==========================================
// Toasts & terminal logs
// ==========================================

const MAX_LOG_LINES = 500;

export const notify = (
  text: string,
  type: "info" | "success" | "error" | "cmd" = "info",
  options?: { actionLabel?: string; onAction?: () => void; duration?: number },
) => {
  const id = Date.now() + Math.random();
  store().setToasts((prev) => [...prev.slice(-3), {
    id,
    text,
    type,
    actionLabel: options?.actionLabel,
    onAction: options?.onAction,
  }]);
  window.setTimeout(() => {
    store().setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, options?.duration ?? 3200);
};

export const addLog = (
  text: string,
  type: "info" | "success" | "error" | "cmd" = "info",
  showToast = false,
  sessionId = store().currentSessionId,
) => {
  store().setTerminalLogsBySession((previous) => {
    const next = [...(previous[sessionId] || []), { text, type }];
    return {
      ...previous,
      [sessionId]: next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next,
    };
  });
  if (showToast) notify(text, type);
};

// ==========================================
// Payload helpers
// ==========================================

export const isCurrentRequestPayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return true;
  const requestId = (payload as { requestId?: string }).requestId;
  return !requestId || requestId === runtime.activeRequestId;
};

export const payloadContent = (payload: AgentEventPayload) =>
  typeof payload === "string" ? payload : String(payload.content || "");

export const payloadRequestId = (payload?: unknown) => {
  if (!payload || typeof payload !== "object") return "";
  return String((payload as { requestId?: string }).requestId || "");
};

export const agentEventSessionId = (payload?: unknown) => {
  const requestId = payloadRequestId(payload);
  return (requestId && runtime.requestSessionById[requestId])
    || runtime.activeRequestSessionId
    || store().currentSessionId;
};

// ==========================================
// Stream token batching: accumulate chunks and flush once per animation frame
// so a burst of tokens triggers one setSessions/render instead of one per token.
// ==========================================

let streamBuffer: {
  requestId: string;
  sessionId: string;
  text: string;
  model: string;
  contextTokens: number;
} | null = null;
let streamFlushRaf: number | null = null;

/**
 * Apply all buffered stream text in a single state update. Safe to call
 * synchronously (e.g. right before a tool/done event mutates the last
 * message) — it cancels any pending frame and applies immediately.
 */
export const flushStreamBufferNow = () => {
  if (streamFlushRaf !== null) {
    cancelAnimationFrame(streamFlushRaf);
    streamFlushRaf = null;
  }
  const buffered = streamBuffer;
  if (!buffered?.text) return;
  streamBuffer = null;
  store().setSessions((prev) =>
    prev.map((s) => {
      if (s.id !== buffered.sessionId) return s;
      const messages = [...s.messages];
      if (
        messages.length === 0 ||
        messages[messages.length - 1].role !== "assistant"
      ) {
        messages.push({
          id: newMessageId(),
          role: "assistant",
          content: buffered.text,
          actions: [],
          variants: [buffered.text],
          currentVariantIndex: 0,
          timestamp: Date.now(),
          model: buffered.model,
          contextTokens: buffered.contextTokens,
        });
      } else {
        const last = { ...messages[messages.length - 1] };
        last.content += buffered.text;
        if (last.variants) {
          last.variants[last.currentVariantIndex || 0] = last.content;
        } else {
          last.variants = [last.content];
          last.currentVariantIndex = 0;
        }
        messages[messages.length - 1] = last;
      }
      return { ...s, messages };
    })
  );
};

/** Drop any buffered stream text without applying it (full UI reset). */
export const discardStreamBuffer = () => {
  if (streamFlushRaf !== null) {
    cancelAnimationFrame(streamFlushRaf);
    streamFlushRaf = null;
  }
  streamBuffer = null;
};

// ==========================================
// Shared run helpers
// ==========================================

export const finishStreamingLocally = (expectedRequestId = runtime.activeRequestId) => {
  if (expectedRequestId && runtime.activeRequestId && expectedRequestId !== runtime.activeRequestId) return;
  flushStreamBufferNow();
  const sessionId = runtime.activeRequestSessionId;
  if (expectedRequestId) delete runtime.requestSessionById[expectedRequestId];
  runtime.isStreaming = false;
  runtime.activeRequestId = "";
  runtime.activeRequestSessionId = "";
  if (sessionId) {
    store().setPendingApprovalsBySession((previous) => ({ ...previous, [sessionId]: null }));
    store().setApprovalSubmittingBySession((previous) => ({ ...previous, [sessionId]: false }));
    store().setRuntimeBySession((previous) => ({ ...previous, [sessionId]: null }));
  }
  store().setActiveRunSessionId(null);
  setTimeout(() => uiCallbacks.focusComposer(), 100);
};

export const upsertToolActions = (messages: Message[], incoming: ToolAction[]) => {
  const next = [...messages];
  if (next.length === 0 || next[next.length - 1].role !== "assistant") {
    next.push({
      id: newMessageId(),
      role: "assistant",
      content: "",
      actions: incoming,
      timestamp: Date.now(),
      model: runtime.activeRequestModel,
      contextTokens: runtime.activeRequestContextTokens,
    });
    return next;
  }

  const last = { ...next[next.length - 1] };
  const actions = last.actions ? [...last.actions] : [];
  for (const action of incoming) {
    const idx = actions.findIndex((a) => a.id === action.id);
    if (idx >= 0) {
      const merged = { ...actions[idx], ...action };
      if (!action.arguments && actions[idx].arguments) {
        merged.arguments = actions[idx].arguments;
      }
      actions[idx] = merged;
    } else {
      actions.push(action);
    }
  }
  last.actions = actions;
  next[next.length - 1] = last;
  return next;
};

export const refreshWorkspace = async (
  sessionId = store().currentSessionId,
  workDir = runtime.effectiveWorkDir,
) => {
  const sequence = (runtime.workspaceRequestSequence[sessionId] || 0) + 1;
  runtime.workspaceRequestSequence[sessionId] = sequence;
  if (!workDir.trim()) {
    store().setWorkspaceBySession((previous) => ({
      ...previous,
      [sessionId]: {
        workDir,
        repositoryRoot: "",
        root: null,
        branch: "",
        entries: [],
        selectedPath: null,
        diff: "",
        loading: false,
        treeError: t("ui.choose-a-working-directory-first", runtime.lang),
        changesError: "",
      },
    }));
    return;
  }
  store().setWorkspaceBySession((previous) => ({
    ...previous,
    [sessionId]: {
      ...(previous[sessionId] || createEmptyWorkspaceState()),
      workDir,
      loading: true,
      selectedPath: null,
      diff: "",
      treeError: "",
      changesError: "",
    },
  }));
  const [treeResult, statusResult] = await Promise.allSettled([
    invoke<DirectoryNode>("list_directory_tree", { workDir, maxDepth: 5, includeHidden: false }),
    invoke<{ repositoryRoot: string; branch: string; entries: GitStatusEntry[] }>("get_git_status", { workDir }),
  ]);
  if (runtime.workspaceRequestSequence[sessionId] !== sequence) return;
  store().setWorkspaceBySession((previous) => ({
    ...previous,
    [sessionId]: {
      ...(previous[sessionId] || createEmptyWorkspaceState()),
      root: treeResult.status === "fulfilled" ? treeResult.value : null,
      repositoryRoot: statusResult.status === "fulfilled" ? statusResult.value.repositoryRoot : "",
      branch: statusResult.status === "fulfilled" ? statusResult.value.branch : "",
      entries: statusResult.status === "fulfilled" ? statusResult.value.entries : [],
      loading: false,
      treeError: treeResult.status === "rejected" ? String(treeResult.reason) : "",
      changesError: statusResult.status === "rejected" ? String(statusResult.reason) : "",
    },
  }));
};

export const requestGeneratedSessionTitle = async (sessionId: string) => {
  const pending = runtime.pendingTitleBySession[sessionId];
  if (!pending || runtime.titleRequestInFlight.has(sessionId)) return;
  const session = store().sessions.find((item) => item.id === sessionId);
  const assistantMessage = [...(session?.messages || [])]
    .reverse()
    .find((message) => message.role === "assistant" && message.content.trim())?.content || "";
  if (!assistantMessage) return;

  runtime.titleRequestInFlight.add(sessionId);
  delete runtime.pendingTitleBySession[sessionId];
  try {
    const generated = await invoke<string>("generate_session_title", {
      currentConfig: pending.config,
      userMessage: pending.userMessage,
      assistantMessage,
    });
    const title = normalizeGeneratedTitle(generated);
    if (!title) return;
    store().setSessions((previous) => previous.map((item) => (
      item.id === sessionId && item.title === pending.fallbackTitle
        ? { ...item, title, updatedAt: Date.now() }
        : item
    )));
  } catch (error) {
    console.debug("Session title generation failed; keeping local fallback.", error);
  } finally {
    runtime.titleRequestInFlight.delete(sessionId);
  }
};

// ==========================================
// Listener registration
// ==========================================

let initialized = false;

export async function initAgentEventListeners(): Promise<() => void> {
  if (initialized) return () => {};
  initialized = true;

  const unlisteners: (() => void)[] = [];

  async function setup() {
    unlisteners.push(
      await listen<void>("open-settings", () => {
        store().setSettingsOpen(true);
      }),
    );

    unlisteners.push(
      await listen<string>("config-import-rekey", (event) => {
        addLog(event.payload, "error");
        store().setSettingsOpen(true);
      }),
    );

    unlisteners.push(
      await listen<string>("config-import-warning", (event) => {
        addLog(event.payload, "info", true);
      }),
    );

    unlisteners.push(
      await listen<{ requestId?: string; attempt: number; maxAttempts: number; delaySeconds: number; reason: string }>("agent-retry", (event) => {
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
      }),
    );

    unlisteners.push(
      await listen<AgentEventPayload>("agent-stream-chunk", (event) => {
        if (!isCurrentRequestPayload(event.payload)) return;
        let payload = payloadContent(event.payload);
        if (!payload) return;
        if (payload.includes("DSML")) {
          payload = payload.replace(/<[｜|][｜|][^>]*>/g, "");
          payload = payload.replace(/<\/[｜|][｜|][^>]*>/g, "");
          if (!payload.trim()) return;
        }
        // Accumulate and flush once per frame instead of one render per token.
        const requestId = payloadRequestId(event.payload) || runtime.activeRequestId;
        const sessionId = agentEventSessionId(event.payload);
        if (streamBuffer
          && (streamBuffer.requestId !== requestId || streamBuffer.sessionId !== sessionId)) {
          flushStreamBufferNow();
        }
        if (!streamBuffer) {
          streamBuffer = {
            requestId,
            sessionId,
            text: "",
            model: runtime.activeRequestModel,
            contextTokens: runtime.activeRequestContextTokens,
          };
        }
        streamBuffer.text += payload;
        if (streamFlushRaf === null) {
          streamFlushRaf = requestAnimationFrame(flushStreamBufferNow);
        }
      })
    );

    unlisteners.push(
      await listen<SearchStatus>("agent-search-status", (event) => {
        if (!isCurrentRequestPayload(event.payload)) return;
        const status = event.payload;
        const sessionId = agentEventSessionId(event.payload);
        store().setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            if (messages.length === 0) return s;
            const last = { ...messages[messages.length - 1] };
            // If last message is not assistant (e.g. user msg during force search),
            // only create assistant message when we have results, not for "searching" status
            if (last.role !== "assistant") {
              if (status.type === "searching") {
                // Don't create empty assistant message yet, wait for results or stream start
                return s;
              }
              // Create assistant message now that we have results or error
              const assistantMsg: Message = {
                id: newMessageId(),
                role: "assistant",
                content: "",
                searchStatus: [status],
                actions: [],
              };
              messages.push(assistantMsg);
              return { ...s, messages };
            }
            const existing = last.searchStatus || [];
            if (status.type === "searching") {
              last.searchStatus = [...existing, status];
            } else if (status.type === "results" || status.type === "error") {
              const lastSearchIdx = [...existing].reverse().findIndex((s) => s.type === "searching" && s.query === status.query);
              if (lastSearchIdx !== -1) {
                const realIdx = existing.length - 1 - lastSearchIdx;
                const updated = [...existing];
                updated[realIdx] = { ...updated[realIdx], ...status };
                last.searchStatus = updated;
              } else {
                last.searchStatus = [...existing, status];
              }
            }
            messages[messages.length - 1] = last;
            return { ...s, messages };
          })
        );
      })
    );

    unlisteners.push(
      await listen<AgentEventPayload>("agent-reasoning-chunk", (event) => {
        if (!isCurrentRequestPayload(event.payload)) return;
        const payload = payloadContent(event.payload);
        if (!payload) return;
        const sessionId = agentEventSessionId(event.payload);
        store().setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            if (
              messages.length === 0 ||
              messages[messages.length - 1].role !== "assistant"
            ) {
              messages.push({
                id: newMessageId(),
                role: "assistant",
                content: "",
                actions: [],
                reasoningContent: payload,
                timestamp: Date.now(),
                model: runtime.activeRequestModel,
                contextTokens: runtime.activeRequestContextTokens,
              });
            } else {
              const last = { ...messages[messages.length - 1] };
              last.reasoningContent = (last.reasoningContent || "") + payload;
              messages[messages.length - 1] = last;
            }
            return { ...s, messages };
          })
        );
      })
    );

    unlisteners.push(
      await listen<{
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
      }),
    );

    unlisteners.push(
      await listen<{ index: number; id: string; name: string; arguments: string }>(
        "agent-tool-drafting",
        (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const { index, id: toolId, name, arguments: args } = event.payload;
          const sessionId = agentEventSessionId(event.payload);
          store().setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const messages = [...s.messages];
              if (messages.length === 0 || messages[messages.length - 1].role !== "assistant") {
                messages.push({
                  id: newMessageId(),
                  role: "assistant",
                  content: "",
                  actions: [],
                  timestamp: Date.now(),
                  model: runtime.activeRequestModel,
                  contextTokens: runtime.activeRequestContextTokens,
                });
              }
              const last = { ...messages[messages.length - 1] };
              const actions = last.actions ? [...last.actions] : [];
              if (index >= actions.length || !actions[index]) {
                actions[index] = {
                  id: toolId || `tc-${index}-${Date.now()}`,
                  name,
                  arguments: args,
                  status: "drafting",
                };
              } else {
                actions[index] = { ...actions[index], arguments: args };
                if (toolId && actions[index].id.startsWith("tc-")) {
                  actions[index].id = toolId;
                }
              }
              last.actions = actions;
              messages[messages.length - 1] = last;
              return { ...s, messages };
            })
          );
        }
      )
    );

    unlisteners.push(
      await listen<{
        id: string;
        name: string;
        arguments: string;
        path?: string;
        beforeExists?: boolean;
        beforeContent?: string | null;
      }>(
        "agent-tool-executing",
        (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const { id, name, arguments: args } = event.payload;
          const sessionId = agentEventSessionId(event.payload);
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
          store().setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const messages = upsertToolActions(s.messages, [{
                id,
                name,
                arguments: args,
                status: "executing" as const,
              }]);
              if (messages.length === 0) return s;
              const last = { ...messages[messages.length - 1] };
              if (last.role !== "assistant" || !last.actions) return s;
              last.actions = last.actions.map((a) =>
                a.id === id ? { ...a, status: "executing" as const } : a
              );
              messages[messages.length - 1] = last;
              return { ...s, messages };
            })
          );
        }
      )
    );

    unlisteners.push(
      await listen<{
        requestId?: string;
        id: string;
        name: string;
        stream: string;
        content: string;
      }>("agent-tool-output-chunk", (event) => {
        if (!isCurrentRequestPayload(event.payload)) return;
        const sessionId = agentEventSessionId(event.payload);
        const requestId = event.payload.requestId || runtime.activeRequestId;
        runtime.streamedToolOutputKeys.add(`${requestId}:${event.payload.id}`);
        if (event.payload.content) {
          addLog(event.payload.content, event.payload.stream === "stderr" ? "error" : "cmd", false, sessionId);
        }
      }),
    );

    unlisteners.push(
      await listen<{
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
      }),
    );

    unlisteners.push(
      await listen<{
        requestId?: string;
        id: string;
        name: string;
        output: string;
        path?: string;
        afterExists?: boolean;
        afterContent?: string | null;
      }>(
        "agent-tool-output",
        (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const { id, name, output } = event.payload;
          const sessionId = agentEventSessionId(event.payload);
          const requestId = event.payload.requestId || runtime.activeRequestId;
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
                if (store().currentSessionId === sessionId) store().setActiveTab("preview");
              }
              const absoluteFilePath = resolveWorkspacePath(runtime.activeRequestWorkDir, filePath);
              const selectedFile = store().selectedFile;
              if (runtime.effectiveWorkDir === runtime.activeRequestWorkDir
                && selectedFile
                && comparableWorkspacePath(selectedFile) === comparableWorkspacePath(absoluteFilePath)) {
                const visibleSessionId = store().currentSessionId;
                runtime.fileRequestSequence[visibleSessionId] = (runtime.fileRequestSequence[visibleSessionId] || 0) + 1;
                store().setFileContent(content);
              }
            }
          }
          store().setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const messages = upsertToolActions(s.messages, [{
                id,
                name,
                arguments: "",
                status: isErrorOutput ? "error" as const : "done" as const,
                output,
              }]);
              if (messages.length === 0) return s;
              const last = { ...messages[messages.length - 1] };
              if (last.role !== "assistant" || !last.actions) return s;
              last.actions = last.actions.map((a) =>
                a.id === id ? { ...a, status: isErrorOutput ? "error" as const : "done" as const, output } : a
              );
              messages[messages.length - 1] = last;
              return { ...s, messages };
            })
          );
        }
      )
    );

    unlisteners.push(
      await listen<{ requestId?: string; id: string; name: string; reason: string }>(
        "agent-tool-blocked",
        (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const { id, name, reason } = event.payload;
          const sessionId = agentEventSessionId(event.payload);
          addLog(`[Blocked] ${name}: ${reason}`, "error", false, sessionId);
          store().setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const messages = upsertToolActions(s.messages, [{
                id,
                name,
                arguments: "",
                status: "blocked" as const,
                output: reason,
              }]);
              if (messages.length === 0) return s;
              const last = { ...messages[messages.length - 1] };
              if (last.role !== "assistant" || !last.actions) return s;
              last.actions = last.actions.map((a) =>
                a.id === id ? { ...a, status: "blocked" as const, output: reason } : a
              );
              messages[messages.length - 1] = last;
              return { ...s, messages };
            })
          );
        }
      )
    );

    unlisteners.push(
      await listen<PendingApproval>("agent-tool-approval-request", (event) => {
        if (!isCurrentRequestPayload(event.payload)) return;
        const sessionId = agentEventSessionId(event.payload);
        store().setPendingApprovalsBySession((previous) => ({ ...previous, [sessionId]: event.payload }));
        const pendingActions: ToolAction[] = event.payload.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: "pending_approval" as const,
        }));
        store().setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            return { ...s, messages: upsertToolActions(s.messages, pendingActions) };
          })
        );
      })
    );

    unlisteners.push(
      await listen<{
        requestId?: string;
        content?: string;
        loopCount?: number;
        ttftMs?: number;
        responseTimeMs?: number;
      }>("agent-stream-done", (event) => {
        if (!isCurrentRequestPayload(event.payload)) return;
        flushStreamBufferNow();
        const done = event.payload || {};
        const sessionId = agentEventSessionId(event.payload);
        store().setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            if (messages.length === 0) return s;
            const last = { ...messages[messages.length - 1] };
            if (last.role !== "assistant") return s;
            const usage = last.usage || {
              promptTokens: last.contextTokens || runtime.activeRequestContextTokens || 0,
              completionTokens: estimateTextTokens(last.content),
              totalPromptTokens: last.contextTokens || runtime.activeRequestContextTokens || 0,
              totalCompletionTokens: estimateTextTokens(last.content),
              ttftMs: done.ttftMs || 0,
              responseTimeMs: done.responseTimeMs || 0,
              loopCount: done.loopCount || 1,
            };
            last.model = last.model || runtime.activeRequestModel;
            last.contextTokens = last.contextTokens || runtime.activeRequestContextTokens;
            last.usage = {
              ...usage,
              completionTokens: usage.completionTokens || estimateTextTokens(last.content),
              ttftMs: done.ttftMs ?? usage.ttftMs,
              responseTimeMs: done.responseTimeMs ?? usage.responseTimeMs,
              loopCount: done.loopCount ?? usage.loopCount,
            };
            messages[messages.length - 1] = last;
            return { ...s, messages };
          })
        );
      })
    );

    unlisteners.push(
      await listen<AgentEventPayload<{ status?: string }>>("agent-complete", (event) => {
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
        finishStreamingLocally(requestId);
        const eventLang = runtime.lang;
        addLog(status === "cancelled" ? (eventLang === "zh" ? "已停止当前输出。" : "Current output stopped.") : t("log.complete", eventLang), "info", false, sessionId);
        if (status !== "cancelled" && runtime.pendingTitleBySession[sessionId]) {
          requestAnimationFrame(() => { void requestGeneratedSessionTitle(sessionId); });
        }
      })
    );

    unlisteners.push(
      await listen<{
        requestId?: string;
        prompt_tokens: number;
        completion_tokens: number;
        total_prompt_tokens: number;
        total_completion_tokens: number;
        ttft_ms: number;
        response_time_ms: number;
        loop_count: number;
      }>("agent-usage", (event) => {
        if (!isCurrentRequestPayload(event.payload)) return;
        const sessionId = agentEventSessionId(event.payload);
        const usage = {
          promptTokens: event.payload.prompt_tokens,
          completionTokens: event.payload.completion_tokens,
          totalPromptTokens: event.payload.total_prompt_tokens,
          totalCompletionTokens: event.payload.total_completion_tokens,
          ttftMs: event.payload.ttft_ms,
          responseTimeMs: event.payload.response_time_ms,
          loopCount: event.payload.loop_count,
        };
        store().setUsageStatsBySession((previous) => ({ ...previous, [sessionId]: usage }));
        store().setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            if (messages.length === 0) return s;
            const last = { ...messages[messages.length - 1] };
            if (last.role !== "assistant") return s;
            last.model = last.model || runtime.activeRequestModel;
            last.contextTokens = usage.promptTokens || last.contextTokens || runtime.activeRequestContextTokens;
            last.usage = usage;
            messages[messages.length - 1] = last;
            return { ...s, messages };
          })
        );
      })
    );
  }

  try {
    await setup();
  } catch (e) {
    addLog(`Listener setup failed: ${e}`, "error");
  }

  return () => {
    initialized = false;
    discardStreamBuffer();
    unlisteners.splice(0).forEach((fn) => fn());
  };
}
