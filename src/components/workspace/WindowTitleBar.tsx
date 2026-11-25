import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Moon, PanelLeftClose, PanelLeftOpen, Pin, Square, Sun, X } from "lucide-react";
import type { AppConfig } from "../../types";
import { themeMode } from "../../appDefaults";
import { bi } from "../../i18n";
import { notify } from "../../services/agentEvents";
import logo from "../../assets/logo.png";

export interface WindowTitleBarProps {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  navigationOpen: boolean;
  onToggleNavigation: () => void;
}

export function WindowTitleBar({
  lang,
  config,
  setConfig,
  navigationOpen,
  onToggleNavigation,
}: WindowTitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const [pinned, setPinned] = useState(false);
  const desktop = isTauri();
  const activeMode = themeMode(config.theme);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    const update = async () => {
      const value = await win.isMaximized();
      if (!disposed) setMaximized(value);
    };
    void update().catch(() => {});
    void win.onResized(() => { void update().catch(() => {}); })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop]);

  const operate = async (action: "minimize" | "maximize" | "close") => {
    try {
      const win = getCurrentWindow();
      if (action === "minimize") await win.minimize();
      else if (action === "maximize") await win.toggleMaximize();
      else await win.close();
    } catch (error) {
      notify(String(error), "error");
    }
  };

  return (
    <header className="window-titlebar">
      <div className="window-chrome-left">
        <div className="window-brand">
          <img src={logo} alt="" />
          <span className="window-brand-name">gxAgent</span>
        </div>
        <button
          type="button"
          className="panel-toggle-btn navigation-toggle"
          onClick={onToggleNavigation}
          aria-expanded={navigationOpen}
          aria-controls="workbench-navigation"
          aria-label={bi(lang, "切换侧栏", "Toggle sidebar")}
          title={navigationOpen ? bi(lang, "收起侧栏", "Collapse sidebar") : bi(lang, "展开侧栏", "Expand sidebar")}
        >
          {navigationOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <button
          type="button"
          className="panel-toggle-btn desktop-action"
          onClick={() => setConfig((previous) => ({ ...previous, theme: themeMode(previous.theme) === "dark" ? "light" : "dark" }))}
          aria-label={bi(lang, "切换主题", "Toggle theme")}
          title={bi(lang, "切换主题", "Toggle theme")}
        >
          {activeMode === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <button
          type="button"
          className="panel-toggle-btn desktop-action window-pin-btn"
          onClick={async () => {
            try { setPinned(await invoke<boolean>("toggle_always_on_top")); }
            catch (error) { notify(String(error), "error"); }
          }}
          aria-pressed={pinned}
          aria-label={bi(lang, "窗口置顶", "Keep on top")}
          title={bi(lang, "窗口置顶", "Keep on top")}
        >
          <Pin size={14} />
        </button>
      </div>
      <div className="window-drag-area" data-tauri-drag-region />
      {desktop && (
        <div className="window-controls">
          <button type="button" aria-label={bi(lang, "最小化", "Minimize")} onClick={() => void operate("minimize")}>
            <Minus size={15} />
          </button>
          <button
            type="button"
            aria-label={maximized ? bi(lang, "还原窗口", "Restore window") : bi(lang, "最大化", "Maximize")}
            onClick={() => void operate("maximize")}
          >
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button type="button" className="window-close" aria-label={bi(lang, "关闭窗口", "Close window")} onClick={() => void operate("close")}>
            <X size={16} />
          </button>
        </div>
      )}
    </header>
  );
}
