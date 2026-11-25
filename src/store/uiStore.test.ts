// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "./uiStore";
import { useAppStore } from "./appStore";
import { useWorkspaceViewStore } from "./workspaceViewStore";

describe("useUIStore", () => {
  beforeEach(() => {
    useWorkspaceViewStore.getState().clear();
    useAppStore.setState({ settingsOpen: false });
    useUIStore.setState({
      rightPanelOpen: false,
      mobilePane: "conversation",
      sidebarWidth: 280,
      rightPanelWidth: 480,
      settingsTab: "model",
      expandedActions: {},
      selectedRunBySession: {},
      draftsBySession: {},
    });
  });

  it("updates per-session prompt drafts cleanly", () => {
    const store = useUIStore.getState();
    store.setPromptForSession("s1", "hello");
    store.setPromptForSession("s1", (prev) => `${prev} world`);
    store.setPromptForSession("s2", "other");
    expect(useUIStore.getState().draftsBySession).toEqual({
      s1: "hello world",
      s2: "other",
    });
  });

  it("toggles tool action expansion state", () => {
    const store = useUIStore.getState();
    store.toggleActionExpanded("act-1");
    expect(useUIStore.getState().expandedActions["act-1"]).toBe(true);
    store.toggleActionExpanded("act-1");
    expect(useUIStore.getState().expandedActions["act-1"]).toBe(false);
  });

  it("opens activity workspace tab and review drawer via showRun", () => {
    useUIStore.getState().showRun("sess-1", "msg-9");
    expect(useWorkspaceViewStore.getState().tabs["sess-1"]).toBe("activity");
    expect(useUIStore.getState().selectedRunBySession["sess-1"]).toBe("msg-9");
    expect(useUIStore.getState().rightPanelOpen).toBe(true);
    expect(useUIStore.getState().mobilePane).toBe("review");
  });

  it("sets panel widths and opens settings to an optional tab", () => {
    useUIStore.getState().setSidebarWidth(340);
    useUIStore.getState().setRightPanelWidth((prev) => prev + 40);
    expect(useUIStore.getState().sidebarWidth).toBe(340);
    expect(useUIStore.getState().rightPanelWidth).toBe(520);

    useUIStore.getState().openSettings("tools");
    expect(useUIStore.getState().settingsTab).toBe("tools");
    expect(useAppStore.getState().settingsOpen).toBe(true);

    useUIStore.getState().setCommandPaletteOpen(true);
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);
  });
});
