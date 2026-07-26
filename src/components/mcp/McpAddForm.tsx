import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PlusCircle } from "lucide-react";
import { AppConfig } from "../../types";

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

  const handleAdd = async () => {
    if (!name.trim() || !command.trim()) return;
    const env: Record<string, string> = {};
    if (envText.trim()) {
      for (const line of envText.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
        }
      }
    }
    try {
      const updated = await invoke<AppConfig>("save_mcp_server", {
        currentConfig: config,
        name: name.trim(),
        command: command.trim(),
        args: args.trim() ? args.split(",").map(a => a.trim()) : [],
        env,
      });
      setConfig(updated);
      setName("");
      setCommand("");
      setArgs("");
      setEnvText("");
      addLog(`MCP server "${name}" added`, "success");
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  return (
    <div className="mcp-add-form">
      <input
        type="text"
        className="input-text mcp-input"
        placeholder={t("mcp.serverName", lang)}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="text"
        className="input-text mcp-input"
        placeholder={t("mcp.command", lang)}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
      />
      <input
        type="text"
        className="input-text mcp-input"
        placeholder={t("mcp.args", lang)}
        value={args}
        onChange={(e) => setArgs(e.target.value)}
      />
      <textarea
        className="input-text mcp-textarea"
        placeholder={t("mcp.envVars", lang)}
        value={envText}
        onChange={(e) => setEnvText(e.target.value)}
        rows={2}
      />
      <button
        className="btn btn-secondary"
        style={{ fontSize: "0.72rem", width: "100%" }}
        onClick={handleAdd}
        disabled={!name.trim() || !command.trim()}
      >
        <PlusCircle size={12} /> {t("mcp.addServer", lang)}
      </button>
    </div>
  );
}
