import { create } from "zustand";
import type { ChatSession, UsageStats, PendingApproval } from "../types";
import {
  readLocalSessions,
  type ToastNotice,
  type SessionRuntime,
  type RunCheckpoint,
  type WorkspaceViewState,
} from "../appDefaults";
// Type-only import: erased at compile time, so no runtime module cycle.
import type { McpServerView } from "../components/mcp/McpServerManager";

type Updater<T> = T | ((previous: T) => T);
const resolve = <T,>(next: Updater<T>, previous: T): T =>
  typeof next === "function" ? (next as (p: T) => T)(previous) : next;

export type McpStatus = Pick<McpServerView, "state" | "toolCount" | "message">;
export type TerminalLogEntry = { text: string; type: "info" | "success" | "error" | "cmd" };
export type ModifiedFileEntry = { old: string; new: string };
export type PreviewConsoleLog = { text: string; type: "log" | "error" | "warn" | "info" };
export type WorkspaceTab = "activity" | "files" | "preview";

interface AppStoreState {
  sessions: ChatSession[];
  setSessions: (next: Updater<ChatSession[]>) => void;
  currentSessionId: string;
  setCurrentSessionId: (next: Updater<string>) => void;
  activeRunSessionId: string | null;
  setActiveRunSessionId: (next: Updater<string | null>) => void;
  preparingRequestSessionId: string | null;
  setPreparingRequestSessionId: (next: Updater<string | null>) => void;
  runtimeBySession: Record<string, SessionRuntime | null>;
  setRuntimeBySession: (next: Updater<Record<string, SessionRuntime | null>>) => void;
  checkpointBySession: Record<string, RunCheckpoint | null>;
  setCheckpointBySession: (next: Updater<Record<string, RunCheckpoint | null>>) => void;
  pendingApprovalsBySession: Record<string, PendingApproval | null>;
  setPendingApprovalsBySession: (next: Updater<Record<string, PendingApproval | null>>) => void;
  approvalSubmittingBySession: Record<string, boolean>;
  setApprovalSubmittingBySession: (next: Updater<Record<string, boolean>>) => void;
  usageStatsBySession: Record<string, UsageStats | null>;
  setUsageStatsBySession: (next: Updater<Record<string, UsageStats | null>>) => void;
  mcpStatusByName: Record<string, McpStatus>;
  setMcpStatusByName: (next: Updater<Record<string, McpStatus>>) => void;
  terminalLogsBySession: Record<string, TerminalLogEntry[]>;
  setTerminalLogsBySession: (next: Updater<Record<string, TerminalLogEntry[]>>) => void;
  modifiedFilesBySession: Record<string, Record<string, ModifiedFileEntry>>;
  setModifiedFilesBySession: (next: Updater<Record<string, Record<string, ModifiedFileEntry>>>) => void;
  previewBySession: Record<string, string>;
  setPreviewBySession: (next: Updater<Record<string, string>>) => void;
  toasts: ToastNotice[];
  setToasts: (next: Updater<ToastNotice[]>) => void;
  workspaceBySession: Record<string, WorkspaceViewState>;
  setWorkspaceBySession: (next: Updater<Record<string, WorkspaceViewState>>) => void;
  fileContent: string | null;
  setFileContent: (next: Updater<string | null>) => void;
  selectedFile: string | null;
  setSelectedFile: (next: Updater<string | null>) => void;
  activeTab: WorkspaceTab;
  setActiveTab: (next: Updater<WorkspaceTab>) => void;
  settingsOpen: boolean;
  setSettingsOpen: (next: Updater<boolean>) => void;
  previewConsoleLogsBySession: Record<string, PreviewConsoleLog[]>;
  setPreviewConsoleLogsBySession: (next: Updater<Record<string, PreviewConsoleLog[]>>) => void;
}

export const useAppStore = create<AppStoreState>((set) => ({
  sessions: readLocalSessions(),
  setSessions: (next) => set((s) => ({ sessions: resolve(next, s.sessions) })),
  currentSessionId: localStorage.getItem("gx_current_session") || "default",
  setCurrentSessionId: (next) => set((s) => ({ currentSessionId: resolve(next, s.currentSessionId) })),
  activeRunSessionId: null,
  setActiveRunSessionId: (next) => set((s) => ({ activeRunSessionId: resolve(next, s.activeRunSessionId) })),
  preparingRequestSessionId: null,
  setPreparingRequestSessionId: (next) =>
    set((s) => ({ preparingRequestSessionId: resolve(next, s.preparingRequestSessionId) })),
  runtimeBySession: {},
  setRuntimeBySession: (next) => set((s) => ({ runtimeBySession: resolve(next, s.runtimeBySession) })),
  checkpointBySession: {},
  setCheckpointBySession: (next) => set((s) => ({ checkpointBySession: resolve(next, s.checkpointBySession) })),
  pendingApprovalsBySession: {},
  setPendingApprovalsBySession: (next) =>
    set((s) => ({ pendingApprovalsBySession: resolve(next, s.pendingApprovalsBySession) })),
  approvalSubmittingBySession: {},
  setApprovalSubmittingBySession: (next) =>
    set((s) => ({ approvalSubmittingBySession: resolve(next, s.approvalSubmittingBySession) })),
  usageStatsBySession: {},
  setUsageStatsBySession: (next) => set((s) => ({ usageStatsBySession: resolve(next, s.usageStatsBySession) })),
  mcpStatusByName: {},
  setMcpStatusByName: (next) => set((s) => ({ mcpStatusByName: resolve(next, s.mcpStatusByName) })),
  terminalLogsBySession: {},
  setTerminalLogsBySession: (next) =>
    set((s) => ({ terminalLogsBySession: resolve(next, s.terminalLogsBySession) })),
  modifiedFilesBySession: {},
  setModifiedFilesBySession: (next) =>
    set((s) => ({ modifiedFilesBySession: resolve(next, s.modifiedFilesBySession) })),
  previewBySession: {},
  setPreviewBySession: (next) => set((s) => ({ previewBySession: resolve(next, s.previewBySession) })),
  toasts: [],
  setToasts: (next) => set((s) => ({ toasts: resolve(next, s.toasts) })),
  workspaceBySession: {},
  setWorkspaceBySession: (next) => set((s) => ({ workspaceBySession: resolve(next, s.workspaceBySession) })),
  fileContent: null,
  setFileContent: (next) => set((s) => ({ fileContent: resolve(next, s.fileContent) })),
  selectedFile: null,
  setSelectedFile: (next) => set((s) => ({ selectedFile: resolve(next, s.selectedFile) })),
  activeTab: "activity",
  setActiveTab: (next) => set((s) => ({ activeTab: resolve(next, s.activeTab) })),
  settingsOpen: false,
  setSettingsOpen: (next) => set((s) => ({ settingsOpen: resolve(next, s.settingsOpen) })),
  previewConsoleLogsBySession: {},
  setPreviewConsoleLogsBySession: (next) =>
    set((s) => ({ previewConsoleLogsBySession: resolve(next, s.previewConsoleLogsBySession) })),
}));
