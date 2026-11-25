import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { notify } from "../../services/agentEvents";
import logo from "../../assets/logo.png";

export function WindowTitleBar({ lang }: { lang: string }) {
  const [maximized, setMaximized] = useState(false);
  const desktop = isTauri();
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const window = getCurrentWindow();
    const update = async () => { const value = await window.isMaximized(); if (!disposed) setMaximized(value); };
    void update().catch(() => {});
    void window.onResized(() => { void update().catch(() => {}); }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);
  const operate = async (action: "minimize" | "maximize" | "close") => {
    try { const window = getCurrentWindow(); if (action === "minimize") await window.minimize(); else if (action === "maximize") await window.toggleMaximize(); else await window.close(); }
    catch (error) { notify(String(error), "error"); }
  };
  return <div className="window-titlebar">
    <div className="window-drag-area" data-tauri-drag-region>
      <img src={logo} alt="" /><span>gxAgent Studio</span>
    </div>
    {desktop && <div className="window-controls"><button type="button" aria-label={lang === "zh" ? "最小化" : "Minimize"} onClick={() => void operate("minimize")}><Minus size={15} /></button><button type="button" aria-label={lang === "zh" ? (maximized ? "还原窗口" : "最大化") : (maximized ? "Restore window" : "Maximize")} onClick={() => void operate("maximize")}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button><button type="button" className="window-close" aria-label={lang === "zh" ? "关闭窗口" : "Close window"} onClick={() => void operate("close")}><X size={17} /></button></div>}
  </div>;
}
