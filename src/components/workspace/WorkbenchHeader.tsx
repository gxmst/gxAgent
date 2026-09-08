import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Moon, PanelLeftClose, PanelLeftOpen, Pin, Settings, Sun } from "lucide-react";
import type { AppConfig } from "../../types";
import { themeMode } from "../../appDefaults";
import { notify } from "../../services/agentEvents";
import logo from "../../assets/logo.png";

export function WorkbenchHeader({ lang, config, setConfig, navigationOpen, onToggleNavigation, onSettings }: {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  navigationOpen: boolean;
  onToggleNavigation: () => void;
  onSettings: () => void;
}) {
  const zh = lang === "zh";
  const [pinned, setPinned] = useState(false);
  return <header className="workbench-header">
    <div className="workbench-brand"><img src={logo} alt="" /><span>gxAgent</span></div>
    <button type="button" className="panel-toggle-btn navigation-toggle" onClick={onToggleNavigation} aria-expanded={navigationOpen} aria-controls="workbench-navigation" aria-label={zh ? "收起侧栏" : "Collapse sidebar"} title={zh ? "收起侧栏" : "Collapse sidebar"}>{navigationOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
    <div className="workbench-global-actions">
      <button className="panel-toggle-btn desktop-action" onClick={async () => {
        try { setPinned(await invoke<boolean>("toggle_always_on_top")); }
        catch (error) { notify(String(error), "error"); }
      }} aria-pressed={pinned} aria-label={zh ? "窗口置顶" : "Keep on top"} title={zh ? "窗口置顶" : "Keep on top"}><Pin size={15} /></button>
      <button className="panel-toggle-btn desktop-action" onClick={() => setConfig(previous => ({ ...previous, theme: themeMode(previous.theme) === "dark" ? "light" : "dark" }))} aria-label={zh ? "切换主题" : "Toggle theme"} title={zh ? "切换主题" : "Toggle theme"}>
        {themeMode(config.theme) === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button className="panel-toggle-btn" onClick={onSettings} aria-label={zh ? "设置" : "Settings"} title={zh ? "设置" : "Settings"}><Settings size={16} /></button>
    </div>
  </header>;
}
