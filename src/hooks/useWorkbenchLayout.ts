import { useCallback, useEffect, useRef, useState } from "react";
import { workbenchLayout } from "../utils/workbenchLayout";
import { useUIStore } from "../store/uiStore";

/**
 * Computes responsive panel layout, manages auto-collapsing/restoring sidebar
 * overlays, and handles pointer + keyboard resizing for sidebar and review panels.
 */
export function useWorkbenchLayout() {
  const navigationOpen = useUIStore((s) => s.navigationOpen);
  const setNavigationOpen = useUIStore((s) => s.setNavigationOpen);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth);

  const [draggingSidebar, setDraggingSidebar] = useState(false);
  const [draggingRight, setDraggingRight] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  const layout = workbenchLayout(viewportWidth, sidebarWidth, rightPanelWidth, navigationOpen, rightPanelOpen);
  const { maxSidebarWidth, maxReviewWidth } = layout;
  const restoreNavigationRef = useRef(false);

  useEffect(() => {
    if (layout.navigationOverlay) {
      restoreNavigationRef.current = navigationOpen;
      setNavigationOpen(false);
    } else if (restoreNavigationRef.current) {
      restoreNavigationRef.current = false;
      setNavigationOpen(true);
    }
    // Capture visibility only when entering the drawer layout so manual opens stay open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.navigationOverlay]);

  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 801px)");
    const onChange = () => setNavigationOpen(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [setNavigationOpen]);

  const handleSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingSidebar(true);
    const startX = e.clientX;
    const startWidth = layout.sidebarWidth;
    let latestWidth = startWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(180, Math.min(maxSidebarWidth, startWidth + delta));
      latestWidth = newWidth;
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      setDraggingSidebar(false);
      try { localStorage.setItem("gx_sidebar_width", String(latestWidth)); } catch { /* ignore */ }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [layout.sidebarWidth, maxSidebarWidth, setSidebarWidth]);

  const handleRightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingRight(true);
    const startX = e.clientX;
    const startWidth = layout.reviewWidth;
    let latestWidth = startWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const newWidth = Math.max(320, Math.min(maxReviewWidth, startWidth + delta));
      latestWidth = newWidth;
      setRightPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      setDraggingRight(false);
      try { localStorage.setItem("gx_right_panel_width", String(latestWidth)); } catch { /* ignore */ }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [layout.reviewWidth, maxReviewWidth, setRightPanelWidth]);

  const nudgeSidebarWidth = useCallback((delta: number) => {
    const nextWidth = Math.max(180, Math.min(maxSidebarWidth, layout.sidebarWidth + delta));
    setSidebarWidth(nextWidth);
    try { localStorage.setItem("gx_sidebar_width", String(nextWidth)); } catch { /* ignore */ }
  }, [layout.sidebarWidth, maxSidebarWidth, setSidebarWidth]);

  const nudgeRightPanelWidth = useCallback((delta: number) => {
    const nextWidth = Math.max(320, Math.min(maxReviewWidth, layout.reviewWidth + delta));
    setRightPanelWidth(nextWidth);
    try { localStorage.setItem("gx_right_panel_width", String(nextWidth)); } catch { /* ignore */ }
  }, [layout.reviewWidth, maxReviewWidth, setRightPanelWidth]);

  return {
    layout,
    draggingSidebar,
    draggingRight,
    handleSidebarDrag,
    handleRightDrag,
    nudgeSidebarWidth,
    nudgeRightPanelWidth,
  };
}
