import { useEffect, useRef } from "react";
import type { SessionConfig } from "../types";
import { useGlobalHotkeys } from "../components/shared/CommandSuggestions";
import type { ConfirmationOptions } from "../components/shared/ConfirmDialog";
import { useAppStore } from "../store/appStore";
import { useUIStore } from "../store/uiStore";

/**
 * Global keyboard shortcuts and layered Escape dismissal order across the
 * workbench shell, modals, and drawers.
 */
export function useWorkbenchHotkeys({
  confirmation,
  settleConfirmation,
  contextMenu,
  closeSessionContextMenu,
  navigationOverlay,
  closeSessionSettings,
  createNewSession,
  switchSessionMode,
}: {
  confirmation: ConfirmationOptions | null;
  settleConfirmation: (confirmed: boolean) => void;
  contextMenu: { sessionId: string; x: number; y: number } | null;
  closeSessionContextMenu: () => void;
  navigationOverlay: boolean;
  closeSessionSettings: (restoreFocus?: boolean) => void;
  createNewSession: () => void;
  switchSessionMode: (mode: SessionConfig["mode"]) => void;
}) {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const navigationOpen = useUIStore((s) => s.navigationOpen);
  const setNavigationOpen = useUIStore((s) => s.setNavigationOpen);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen);
  const sessionSettingsOpen = useUIStore((s) => s.sessionSettingsOpen);
  const toolStatsDialog = useUIStore((s) => s.toolStatsDialog);
  const setToolStatsDialog = useUIStore((s) => s.setToolStatsDialog);
  const sidebarNav = useUIStore((s) => s.sidebarNav);

  const sidebarNavRef = useRef(sidebarNav);
  const createNewSessionRef = useRef(createNewSession);
  const switchSessionModeRef = useRef(switchSessionMode);
  sidebarNavRef.current = sidebarNav;
  createNewSessionRef.current = createNewSession;
  switchSessionModeRef.current = switchSessionMode;

  useGlobalHotkeys(() => createNewSessionRef.current());

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape" && confirmation) {
        e.preventDefault();
        settleConfirmation(false);
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        switchSessionModeRef.current(sidebarNavRef.current === "chat" ? "code" : "chat");
        return;
      }
      if (ctrl && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        createNewSessionRef.current();
      }
      if (ctrl && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if (e.key === "Escape") {
        if (contextMenu) { closeSessionContextMenu(); return; }
        if (toolStatsDialog) { setToolStatsDialog(null); return; }
        if (settingsOpen) return;
        if (sessionSettingsOpen) { closeSessionSettings(true); return; }
        if (navigationOpen && navigationOverlay) { setNavigationOpen(false); return; }
        if (rightPanelOpen && window.matchMedia("(max-width: 980px)").matches) {
          setRightPanelOpen(false);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    confirmation,
    contextMenu,
    navigationOpen,
    navigationOverlay,
    rightPanelOpen,
    sessionSettingsOpen,
    settingsOpen,
    settleConfirmation,
    toolStatsDialog,
  ]);
}
