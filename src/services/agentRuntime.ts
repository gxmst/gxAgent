/**
 * Module-lifetime request-tracking state for the agent event pipeline.
 *
 * These fields used to live in App.tsx as a family of useRef mirrors so the
 * once-registered Tauri listeners could see current values without
 * re-subscribing. They are plain mutable module state — nothing here is
 * reactive, and nothing here should be: reactive state belongs in the
 * zustand appStore.
 */
import type { AppConfig } from "../types";

export type PendingSessionTitle = {
  userMessage: string;
  fallbackTitle: string;
  config: AppConfig;
};

export const runtime = {
  /** Request id of the in-flight agent run ("" when idle). */
  activeRequestId: "",
  /** Session that owns the in-flight request ("" when idle). */
  activeRequestSessionId: "",
  activeRequestModel: "",
  activeRequestContextTokens: 0,
  activeRequestWorkDir: "",
  /** Mirrors hasActiveRequest; also flipped synchronously around request start/stop. */
  isStreaming: false,
  /** Mirror of the current session's effective working directory. */
  effectiveWorkDir: "",
  /** Mirror of config.language for use inside event handlers. */
  lang: "zh",
  requestSessionById: {} as Record<string, string>,
  mcpRuntimeNamesByRequest: {} as Record<string, string[]>,
  streamedToolOutputKeys: new Set<string>(),
  workspaceRequestSequence: {} as Record<string, number>,
  fileRequestSequence: {} as Record<string, number>,
  pendingTitleBySession: {} as Record<string, PendingSessionTitle>,
  titleRequestInFlight: new Set<string>(),
};

/**
 * Tiny registry for the few DOM-touching callbacks event handlers need.
 * App registers the real implementations once on mount.
 */
export const uiCallbacks = {
  focusComposer: () => {},
};
