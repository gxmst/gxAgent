import { useAppStore } from "../../store/appStore";
import { runtime } from "../agentRuntime";
import { ensureRequestAssistant, findRequestAssistantIndex } from "./helpers";

const store = () => useAppStore.getState();

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
      const existingIndex = findRequestAssistantIndex(messages, buffered.requestId);
      const assistantIndex = existingIndex >= 0
        ? existingIndex
        : ensureRequestAssistant(messages, buffered.requestId, {
            content: buffered.text,
            variants: [buffered.text],
            currentVariantIndex: 0,
            model: buffered.model,
            contextTokens: buffered.contextTokens,
          });
      if (existingIndex >= 0) {
        const assistant = { ...messages[assistantIndex] };
        const variantIndex = assistant.currentVariantIndex || 0;
        const currentContent = assistant.variants?.[variantIndex] ?? assistant.content;
        assistant.content = currentContent + buffered.text;
        assistant.variants = assistant.variants
          ? [...assistant.variants]
          : [currentContent];
        assistant.variants[variantIndex] = assistant.content;
        assistant.currentVariantIndex = variantIndex;
        messages[assistantIndex] = assistant;
      }
      return { ...s, messages };
    }),
  );
};

export const queueStreamChunk = (requestId: string, sessionId: string, payload: string) => {
  if (streamBuffer && (streamBuffer.requestId !== requestId || streamBuffer.sessionId !== sessionId)) {
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
};

/** Drop any buffered stream text without applying it (full UI reset). */
export const discardStreamBuffer = () => {
  if (streamFlushRaf !== null) {
    cancelAnimationFrame(streamFlushRaf);
    streamFlushRaf = null;
  }
  streamBuffer = null;
};
