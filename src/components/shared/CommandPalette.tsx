import { useEffect, useMemo, useState } from "react";
import { Dialog } from "radix-ui";
import {
  Command,
  FolderGit2,
  MessageSquarePlus,
  Minimize2,
  Moon,
  PanelRight,
  Search,
  Settings,
  Shield,
  Sun,
  Terminal,
} from "lucide-react";
import type { AppConfig, ChatSession, SessionConfig } from "../../types";
import type { SettingsTab } from "../settings/settingsNavigation";

interface CommandPaletteAction {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  lang,
  config,
  sessions,
  currentSession,
  onNewSession,
  onSelectSession,
  onSwitchMode,
  onTogglePlanMode,
  onCompact,
  onToggleRightPanel,
  onThemeChange,
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lang: string;
  config: AppConfig;
  sessions: ChatSession[];
  currentSession: ChatSession;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onSwitchMode: (mode: SessionConfig["mode"]) => void;
  onTogglePlanMode: () => void;
  onCompact: () => void;
  onToggleRightPanel: () => void;
  onThemeChange: (theme: "system" | "light" | "dark") => void;
  onOpenSettings: (tab?: SettingsTab) => void;
}) {
  const zh = lang === "zh";
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [open]);

  const actions = useMemo<CommandPaletteAction[]>(() => {
    const currentMode = currentSession.sessionConfig.mode || "chat";
    const items: CommandPaletteAction[] = [
      {
        id: "new-session",
        group: zh ? "操作" : "Actions",
        label: zh ? "新建对话" : "New conversation",
        hint: "Ctrl+N",
        icon: <MessageSquarePlus size={14} />,
        run: onNewSession,
      },
      {
        id: "switch-mode",
        group: zh ? "操作" : "Actions",
        label: currentMode === "chat"
          ? (zh ? "切换到编码工作模式" : "Switch to Code mode")
          : (zh ? "切换到对话模式" : "Switch to Chat mode"),
        hint: "Ctrl+Shift+N",
        icon: <Terminal size={14} />,
        run: () => onSwitchMode(currentMode === "chat" ? "code" : "chat"),
      },
      {
        id: "toggle-plan",
        group: zh ? "操作" : "Actions",
        label: config.plan_mode
          ? (zh ? "退出只读规划模式" : "Exit read-only Plan mode")
          : (zh ? "开启只读规划模式" : "Enable read-only Plan mode"),
        icon: <Shield size={14} />,
        run: onTogglePlanMode,
      },
      {
        id: "compact-history",
        group: zh ? "操作" : "Actions",
        label: zh ? "压缩当前对话上下文 (/compact)" : "Compact conversation context (/compact)",
        icon: <Minimize2 size={14} />,
        run: onCompact,
      },
      {
        id: "toggle-review",
        group: zh ? "工作区" : "Workspace",
        label: zh ? "打开 / 收起右侧工作区与 Diff 审阅面板" : "Toggle workspace & Diff review panel",
        icon: <PanelRight size={14} />,
        run: onToggleRightPanel,
      },
      {
        id: "theme-system",
        group: zh ? "外观" : "Appearance",
        label: zh ? "主题：跟随系统" : "Theme: System",
        icon: <Command size={14} />,
        run: () => onThemeChange("system"),
      },
      {
        id: "theme-light",
        group: zh ? "外观" : "Appearance",
        label: zh ? "主题：浅色" : "Theme: Light",
        icon: <Sun size={14} />,
        run: () => onThemeChange("light"),
      },
      {
        id: "theme-dark",
        group: zh ? "外观" : "Appearance",
        label: zh ? "主题：深色" : "Theme: Dark",
        icon: <Moon size={14} />,
        run: () => onThemeChange("dark"),
      },
      {
        id: "settings-model",
        group: zh ? "设置" : "Settings",
        label: zh ? "打开连接与模型设置" : "Open connections & model settings",
        hint: "Ctrl+,",
        icon: <Settings size={14} />,
        run: () => onOpenSettings("model"),
      },
      {
        id: "settings-tools",
        group: zh ? "设置" : "Settings",
        label: zh ? "打开工具与 MCP 设置" : "Open tools & MCP settings",
        icon: <Settings size={14} />,
        run: () => onOpenSettings("tools"),
      },
    ];

    for (const session of sessions.slice(0, 20)) {
      items.push({
        id: `session:${session.id}`,
        group: zh ? "会话" : "Conversations",
        label: session.title || (zh ? "未命名对话" : "Untitled conversation"),
        hint: session.sessionConfig.mode === "code" ? (zh ? "编码" : "Code") : (zh ? "对话" : "Chat"),
        icon: <FolderGit2 size={14} />,
        run: () => onSelectSession(session.id),
      });
    }
    return items;
  }, [
    config.plan_mode,
    currentSession.sessionConfig.mode,
    onCompact,
    onNewSession,
    onOpenSettings,
    onSelectSession,
    onSwitchMode,
    onThemeChange,
    onTogglePlanMode,
    onToggleRightPanel,
    sessions,
    zh,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((item) => `${item.group} ${item.label} ${item.hint || ""}`.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const execute = (item: CommandPaletteAction | undefined) => {
    if (!item) return;
    onOpenChange(false);
    item.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="command-palette"
          aria-label={zh ? "命令面板" : "Command palette"}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelectedIndex((idx) => (filtered.length ? (idx + 1) % filtered.length : 0));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedIndex((idx) => (filtered.length ? (idx - 1 + filtered.length) % filtered.length : 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              execute(filtered[selectedIndex]);
            }
          }}
        >
          <Dialog.Title className="sr-only">{zh ? "命令面板" : "Command palette"}</Dialog.Title>
          <Dialog.Description className="sr-only">
            {zh ? "搜索操作或切换会话" : "Search commands or switch conversations"}
          </Dialog.Description>
          <div className="command-palette-search">
            <Search size={15} />
            <input
              autoFocus
              value={query}
              onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }}
              placeholder={zh ? "搜索命令、设置或切换会话…" : "Search commands, settings, or conversations..."}
            />
            <kbd className="command-palette-kbd">Esc</kbd>
          </div>
          <div className="command-palette-list" role="listbox">
            {filtered.length === 0 ? (
              <div className="command-palette-empty">{zh ? "没有匹配的命令或会话" : "No matching commands or conversations"}</div>
            ) : (
              filtered.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={idx === selectedIndex}
                  className={`command-palette-item ${idx === selectedIndex ? "selected" : ""}`}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => execute(item)}
                >
                  <span className="command-palette-icon">{item.icon}</span>
                  <span className="command-palette-label">{item.label}</span>
                  <span className="command-palette-meta">{item.hint || item.group}</span>
                </button>
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
