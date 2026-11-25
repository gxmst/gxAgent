import { create } from "zustand";
import type { SessionConfig } from "../types";
import type { RolePreset } from "../rolePresets";
import type { ToolStatsDialog } from "../appDefaults";
import type { SettingsTab } from "../components/settings/settingsNavigation";
import { useAppStore } from "./appStore";
import { useWorkspaceViewStore } from "./workspaceViewStore";

type Updater<T> = T | ((previous: T) => T);
const resolve = <T,>(next: Updater<T>, previous: T): T =>
  typeof next === "function" ? (next as (p: T) => T)(previous) : next;

function hasStorage(): boolean {
  return typeof localStorage !== "undefined" && typeof localStorage.getItem === "function";
}

function readInitialDrafts(): Record<string, string> {
  if (!hasStorage()) return {};
  try {
    const saved = localStorage.getItem("gx_drafts");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    }
    const legacy = localStorage.getItem("gx_draft");
    if (legacy) {
      return { [localStorage.getItem("gx_current_session") || "default"]: legacy };
    }
  } catch { /* ignore corrupt drafts */ }
  return {};
}

function readInitialCustomPresets(): RolePreset[] {
  if (!hasStorage()) return [];
  try {
    const saved = localStorage.getItem("gx_custom_presets");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed as RolePreset[];
    }
  } catch { /* ignore corrupt presets */ }
  return [];
}

function readStoredWidth(key: string, fallback: number, min = 0): number {
  if (!hasStorage()) return fallback;
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 && Number.isFinite(value) ? Math.max(min, value) : fallback;
  } catch {
    return fallback;
  }
}

export interface UIStoreState {
  navigationOpen: boolean;
  setNavigationOpen: (next: Updater<boolean>) => void;
  rightPanelOpen: boolean;
  setRightPanelOpen: (next: Updater<boolean>) => void;
  mobilePane: "conversation" | "review";
  setMobilePane: (next: Updater<"conversation" | "review">) => void;
  sidebarWidth: number;
  setSidebarWidth: (next: Updater<number>) => void;
  rightPanelWidth: number;
  setRightPanelWidth: (next: Updater<number>) => void;
  sidebarNav: SessionConfig["mode"];
  setSidebarNav: (next: Updater<SessionConfig["mode"]>) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (next: Updater<SettingsTab>) => void;
  sessionSettingsOpen: boolean;
  setSessionSettingsOpen: (next: Updater<boolean>) => void;
  toolStatsDialog: ToolStatsDialog | null;
  setToolStatsDialog: (next: Updater<ToolStatsDialog | null>) => void;
  selectedRunBySession: Record<string, string | undefined>;
  setSelectedRunBySession: (next: Updater<Record<string, string | undefined>>) => void;
  expandedActions: Record<string, boolean>;
  setExpandedActions: (next: Updater<Record<string, boolean>>) => void;
  toggleActionExpanded: (id: string) => void;
  editingMessageIdxBySession: Record<string, number | null>;
  setEditingMessageIdxBySession: (next: Updater<Record<string, number | null>>) => void;
  editTextBySession: Record<string, string>;
  setEditTextBySession: (next: Updater<Record<string, string>>) => void;
  draftsBySession: Record<string, string>;
  setDraftsBySession: (next: Updater<Record<string, string>>) => void;
  setPromptForSession: (sessionId: string, next: Updater<string>) => void;
  customPresets: RolePreset[];
  setCustomPresets: (next: Updater<RolePreset[]>) => void;
  showRun: (sessionId: string, messageId?: string) => void;
  openSettings: (tab?: SettingsTab) => void;
}

export const useUIStore = create<UIStoreState>((set) => ({
  navigationOpen: typeof window !== "undefined" ? window.innerWidth > 800 : true,
  setNavigationOpen: (next) => set((s) => ({ navigationOpen: resolve(next, s.navigationOpen) })),
  rightPanelOpen: false,
  setRightPanelOpen: (next) => set((s) => ({ rightPanelOpen: resolve(next, s.rightPanelOpen) })),
  mobilePane: "conversation",
  setMobilePane: (next) => set((s) => ({ mobilePane: resolve(next, s.mobilePane) })),
  sidebarWidth: readStoredWidth("gx_sidebar_width", 280),
  setSidebarWidth: (next) => set((s) => ({ sidebarWidth: resolve(next, s.sidebarWidth) })),
  rightPanelWidth: readStoredWidth("gx_right_panel_width", 480, 320),
  setRightPanelWidth: (next) => set((s) => ({ rightPanelWidth: resolve(next, s.rightPanelWidth) })),
  sidebarNav: "chat",
  setSidebarNav: (next) => set((s) => ({ sidebarNav: resolve(next, s.sidebarNav) })),
  settingsTab: "model",
  setSettingsTab: (next) => set((s) => ({ settingsTab: resolve(next, s.settingsTab) })),
  sessionSettingsOpen: false,
  setSessionSettingsOpen: (next) => set((s) => ({ sessionSettingsOpen: resolve(next, s.sessionSettingsOpen) })),
  toolStatsDialog: null,
  setToolStatsDialog: (next) => set((s) => ({ toolStatsDialog: resolve(next, s.toolStatsDialog) })),
  selectedRunBySession: {},
  setSelectedRunBySession: (next) => set((s) => ({ selectedRunBySession: resolve(next, s.selectedRunBySession) })),
  expandedActions: {},
  setExpandedActions: (next) => set((s) => ({ expandedActions: resolve(next, s.expandedActions) })),
  toggleActionExpanded: (id) => set((s) => ({
    expandedActions: { ...s.expandedActions, [id]: !s.expandedActions[id] },
  })),
  editingMessageIdxBySession: {},
  setEditingMessageIdxBySession: (next) => set((s) => ({
    editingMessageIdxBySession: resolve(next, s.editingMessageIdxBySession),
  })),
  editTextBySession: {},
  setEditTextBySession: (next) => set((s) => ({ editTextBySession: resolve(next, s.editTextBySession) })),
  draftsBySession: readInitialDrafts(),
  setDraftsBySession: (next) => set((s) => ({ draftsBySession: resolve(next, s.draftsBySession) })),
  setPromptForSession: (sessionId, next) => set((s) => ({
    draftsBySession: {
      ...s.draftsBySession,
      [sessionId]: resolve(next, s.draftsBySession[sessionId] || ""),
    },
  })),
  customPresets: readInitialCustomPresets(),
  setCustomPresets: (next) => set((s) => ({ customPresets: resolve(next, s.customPresets) })),
  showRun: (sessionId, messageId) => {
    useWorkspaceViewStore.getState().setTab(sessionId, "activity");
    set((s) => ({
      selectedRunBySession: { ...s.selectedRunBySession, [sessionId]: messageId },
      rightPanelOpen: true,
      mobilePane: "review",
    }));
  },
  openSettings: (tab) => {
    if (tab) set({ settingsTab: tab });
    useAppStore.getState().setSettingsOpen(true);
  },
}));
