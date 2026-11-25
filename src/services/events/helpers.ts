import { useAppStore } from "../../store/appStore";
import { runtime } from "../agentRuntime";
import { newMessageId, type AgentEventPayload } from "../../appDefaults";
import type { Message, ToolAction } from "../../types";

const store = () => useAppStore.getState();

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

export const findRequestAssistantIndex = (messages: Message[], requestId: string) => {
  const messageId = requestId ? runtime.assistantMessageIdByRequest[requestId] : "";
  if (!messageId) return -1;
  return messages.findIndex((message) => message.id === messageId && message.role === "assistant");
};

export const ensureRequestAssistant = (
  messages: Message[],
  requestId: string,
  initial: Partial<Message> = {},
) => {
  const existingIndex = findRequestAssistantIndex(messages, requestId);
  if (existingIndex >= 0) {
    if (requestId && messages[existingIndex].run?.requestId !== requestId) {
      messages[existingIndex] = { ...messages[existingIndex], run: { requestId, status: "running", startedAt: Date.now() } };
    }
    return existingIndex;
  }
  if (!requestId && messages.length > 0 && messages[messages.length - 1].role === "assistant") {
    return messages.length - 1;
  }

  const message: Message = {
    id: newMessageId(),
    role: "assistant",
    content: "",
    actions: [],
    timestamp: Date.now(),
    model: runtime.activeRequestModel,
    contextTokens: runtime.activeRequestContextTokens,
    run: { requestId, status: "running", startedAt: Date.now() },
    ...initial,
  };
  messages.push(message);
  runtime.assistantMessageIdByRequest[requestId] = message.id!;
  return messages.length - 1;
};

export const updateRequestAssistantAction = (
  messages: Message[],
  requestId: string,
  actionId: string,
  update: (action: ToolAction) => ToolAction,
) => {
  const assistantIndex = findRequestAssistantIndex(messages, requestId);
  if (assistantIndex < 0) return;
  const assistant = { ...messages[assistantIndex] };
  if (!assistant.actions) return;
  assistant.actions = assistant.actions.map((action) => (action.id === actionId ? update(action) : action));
  messages[assistantIndex] = assistant;
};
