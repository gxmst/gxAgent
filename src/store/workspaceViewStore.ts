import { create } from "zustand";

export type WorkspaceTab = "changes" | "files" | "activity" | "preview" | "context";
export interface WorkspaceFileView {
  workDir: string;
  path: string | null;
  content: string | null;
  loading: boolean;
  error: string;
}
export const EMPTY_FILE_VIEW: WorkspaceFileView = { workDir: "", path: null, content: null, loading: false, error: "" };

interface WorkspaceViewStore {
  files: Record<string, WorkspaceFileView>;
  tabs: Record<string, WorkspaceTab>;
  setFile: (sessionId: string, patch: Partial<WorkspaceFileView>) => void;
  setTab: (sessionId: string, tab: WorkspaceTab) => void;
  clear: (sessionId?: string) => void;
}

export const useWorkspaceViewStore = create<WorkspaceViewStore>(set => ({
  files: {},
  tabs: {},
  setFile: (sessionId, patch) => set(state => ({ files: {
    ...state.files,
    [sessionId]: { ...(state.files[sessionId] || EMPTY_FILE_VIEW), ...patch },
  } })),
  setTab: (sessionId, tab) => set(state => ({ tabs: { ...state.tabs, [sessionId]: tab } })),
  clear: sessionId => set(state => {
    if (!sessionId) return { files: {}, tabs: {} };
    const files = { ...state.files };
    const tabs = { ...state.tabs };
    delete files[sessionId];
    delete tabs[sessionId];
    return { files, tabs };
  }),
}));
