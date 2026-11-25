import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { createEmptyWorkspaceState } from "../../appDefaults";
import { normalizeGeneratedTitle } from "../../utils/sessionTitle";
import type { Message, ToolAction } from "../../types";
import { useAppStore } from "../../store/appStore";
import { useCodexStore } from "../../store/codexStore";
import { runtime, uiCallbacks } from "../agentRuntime";
import { rememberCodexHistory } from "../codexWorkflow";
import { ensureRequestAssistant, findRequestAssistantIndex } from "./helpers";
import { flushStreamBufferNow } from "./streamBuffer";
import type { DirectoryNode } from "../../components/workspace/WorkspaceTree";
import type { GitStatusEntry } from "../../components/workspace/WorkspaceChanges";

const store = () => useAppStore.getState();

export const finishStreamingLocally = (
  expectedRequestId = runtime.activeRequestId,
  status?: "completed" | "stopped" | "error",
) => {
  if (expectedRequestId && runtime.activeRequestId && expectedRequestId !== runtime.activeRequestId) return;
  flushStreamBufferNow();
  const sessionId = runtime.activeRequestSessionId;
  if (sessionId && expectedRequestId) {
    const finalStatus = status || (store().runtimeBySession[sessionId]?.status === "stopping" ? "stopped" : "completed");
    store().setSessions((sessions) => sessions.map((session) => {
      if (session.id !== sessionId) return session;
      const index = findRequestAssistantIndex(session.messages, expectedRequestId);
      if (index < 0) return session;
      const messages = [...session.messages];
      const message = messages[index];
      messages[index] = {
        ...message,
        actions: message.actions?.map((action) => (
          ["drafting", "executing", "pending_approval"].includes(action.status)
            ? {
                ...action,
                status: finalStatus === "error" ? "error" : "blocked",
                output: action.output || (finalStatus === "stopped" ? "Run stopped before this action completed." : "Run ended before this action completed."),
              }
            : action
        )),
        run: {
          requestId: expectedRequestId,
          startedAt: message.run?.startedAt || message.timestamp || Date.now(),
          status: finalStatus,
          finishedAt: Date.now(),
        },
      };
      return { ...session, messages, updatedAt: Date.now() };
    }));
    if (runtime.activeRequestEngine === "codex" && runtime.activeCodexTurnStarted && (finalStatus === "completed" || finalStatus === "stopped")) {
      rememberCodexHistory(sessionId, runtime.activeCodexHistoryComplete);
    }
  }
  if (expectedRequestId) {
    delete runtime.requestSessionById[expectedRequestId];
    delete runtime.assistantMessageIdByRequest[expectedRequestId];
  }
  runtime.isStreaming = false;
  runtime.activeCodexTurnStarted = false;
  runtime.activeCodexHistoryComplete = false;
  runtime.activeRequestEngine = "native";
  runtime.activeRequestId = "";
  runtime.activeRequestSessionId = "";
  if (sessionId) {
    useCodexStore.getState().setQuestion(sessionId, null);
    store().setPendingApprovalsBySession((previous) => ({ ...previous, [sessionId]: null }));
    store().setApprovalSubmittingBySession((previous) => ({ ...previous, [sessionId]: false }));
    store().setRuntimeBySession((previous) => ({ ...previous, [sessionId]: null }));
  }
  store().setActiveRunSessionId(null);
  setTimeout(() => uiCallbacks.focusComposer(), 100);
};

export const upsertToolActions = (
  messages: Message[],
  incoming: ToolAction[],
  requestId = runtime.activeRequestId,
) => {
  const next = [...messages];
  const assistantIndex = ensureRequestAssistant(next, requestId);
  const assistant = { ...next[assistantIndex] };
  const actions = assistant.actions ? [...assistant.actions] : [];
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
  assistant.actions = actions;
  next[assistantIndex] = assistant;
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
