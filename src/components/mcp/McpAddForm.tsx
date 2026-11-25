import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, PlusCircle } from "lucide-react";
import { AppConfig } from "../../types";
import { parseMcpArguments, parseMcpEnvironment } from "../../utils/mcpConfig";
import { useAppStore } from "../../store/appStore";

export function McpAddForm({ setConfig, addLog, lang, t, config }: {
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  addLog: (text: string, type: "info" | "success" | "error" | "cmd") => void;
  lang: string;
  t: (key: string, lang: string, vars?: Record<string, string>) => string;
  config: AppConfig;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useAppStore(state => Boolean(state.activeRunSessionId || state.preparingRequestSessionId));

  const handleAdd = async () => {
    if (!name.trim() || !command.trim() || busy || locked) return;
    setError("");
    if (config.mcp_servers[name.trim()]) { setError(lang === "zh" ? "此服务名称已存在" : "This server name already exists"); return; }
    setBusy(true);
    try {
      const updated = await invoke<AppConfig>("save_mcp_server", {
        currentConfig: config,
        name: name.trim(),
        command: command.trim(),
        args: parseMcpArguments(args),
        env: parseMcpEnvironment(envText),
      });
      setConfig(updated);
      setName("");
      setCommand("");
      setArgs("");
      setEnvText("");
      setOpen(false);
      addLog(`MCP server "${name}" added`, "success");
    } catch (e) {
      setError(String(e));
      addLog(String(e), "error");
    } finally { setBusy(false); }
  };

  if (!open) return <button className="btn" disabled={locked} onClick={() => setOpen(true)}><PlusCircle size={15} />{t("mcp.addServer", lang)}</button>;
  return (
    <div className="mcp-add-form">
      <label>{t("mcp.serverName", lang)}
      <input
        aria-label={t("mcp.serverName", lang)}
        type="text"
        className="input-text mcp-input"
        placeholder={t("mcp.serverName", lang)}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
      />
      </label>
      <label>{t("mcp.command", lang)}
      <input
        aria-label={t("mcp.command", lang)}
        type="text"
        className="input-text mcp-input"
        placeholder={t("mcp.command", lang)}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        disabled={busy}
      />
      </label>
      <label>{lang === "zh" ? "启动参数（JSON 数组或每行一个）" : "Arguments (JSON array or one per line)"}
      <textarea
        aria-label={lang === "zh" ? "启动参数（JSON 数组或每行一个）" : "Arguments (JSON array or one per line)"}
        className="input-text mcp-input"
        placeholder={'["-y", "@example/mcp-server"]'}
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        rows={3}
        disabled={busy}
      />
      </label>
      <label>{lang === "zh" ? "环境变量（NAME=value，每行一个）" : "Environment variables (NAME=value, one per line)"}
      <textarea
        aria-label={lang === "zh" ? "环境变量（NAME=value，每行一个）" : "Environment variables (NAME=value, one per line)"}
        className="input-text mcp-textarea"
        placeholder={t("mcp.envVars", lang)}
        value={envText}
        onChange={(e) => setEnvText(e.target.value)}
        rows={2}
        disabled={busy}
      />
      </label>
      {error && <p className="lab-error" role="alert">{error}</p>}
      <button
        className="btn btn-secondary"
        onClick={handleAdd}
        disabled={!name.trim() || !command.trim() || busy || locked}
      >
        {busy ? <Loader2 size={15} className="spin" /> : <PlusCircle size={15} />} {t("mcp.addServer", lang)}
      </button>
      <button className="btn" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>{lang === "zh" ? "取消" : "Cancel"}</button>
    </div>
  );
}
