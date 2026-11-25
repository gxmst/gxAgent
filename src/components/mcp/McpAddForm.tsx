import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, PlusCircle } from "lucide-react";
import { AppConfig } from "../../types";
import { parseMcpArguments, parseMcpEnvironment, parseMcpHeaders } from "../../utils/mcpConfig";
import { useAppStore } from "../../store/appStore";

export function McpAddForm({ setConfig, addLog, lang, t, config }: {
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  addLog: (text: string, type: "info" | "success" | "error" | "cmd") => void;
  lang: string;
  t: (key: string, lang: string, vars?: Record<string, string>) => string;
  config: AppConfig;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useAppStore(state => Boolean(state.activeRunSessionId || state.preparingRequestSessionId));

  const ready = transport === "http" ? Boolean(url.trim()) : Boolean(command.trim());

  const handleAdd = async () => {
    if (!name.trim() || !ready || busy || locked) return;
    setError("");
    if (config.mcp_servers[name.trim()]) { setError(lang === "zh" ? "此服务名称已存在" : "This server name already exists"); return; }
    setBusy(true);
    try {
      const updated = await invoke<AppConfig>("save_mcp_server", {
        currentConfig: config,
        name: name.trim(),
        transport,
        command: transport === "stdio" ? command.trim() : "",
        args: transport === "stdio" ? parseMcpArguments(args) : [],
        env: transport === "stdio" ? parseMcpEnvironment(envText) : {},
        url: transport === "http" ? url.trim() : "",
        headers: transport === "http" ? parseMcpHeaders(headersText) : {},
      });
      setConfig(updated);
      setName("");
      setTransport("stdio");
      setCommand("");
      setArgs("");
      setEnvText("");
      setUrl("");
      setHeadersText("");
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
      <label>{lang === "zh" ? "传输方式" : "Transport"}
      <select
        aria-label={lang === "zh" ? "传输方式" : "Transport"}
        className="input-text mcp-input"
        value={transport}
        onChange={(e) => setTransport(e.target.value === "http" ? "http" : "stdio")}
        disabled={busy}
      >
        <option value="stdio">{lang === "zh" ? "本地命令 (Stdio)" : "Local command (Stdio)"}</option>
        <option value="http">{lang === "zh" ? "远程服务 (Streamable HTTP / SSE)" : "Remote endpoint (Streamable HTTP / SSE)"}</option>
      </select>
      </label>
      {transport === "stdio" ? (
        <>
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
        </>
      ) : (
        <>
          <label>{lang === "zh" ? "服务 URL" : "Endpoint URL"}
          <input
            aria-label={lang === "zh" ? "服务 URL" : "Endpoint URL"}
            type="url"
            className="input-text mcp-input"
            placeholder="https://example.com/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
          />
          </label>
          <label>{lang === "zh" ? "HTTP 请求头（Header: value，每行一个）" : "HTTP Headers (Name: value, one per line)"}
          <textarea
            aria-label={lang === "zh" ? "HTTP 请求头（Header: value，每行一个）" : "HTTP Headers (Name: value, one per line)"}
            className="input-text mcp-textarea"
            placeholder="Authorization: Bearer ..."
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            rows={2}
            disabled={busy}
          />
          </label>
        </>
      )}
      {error && <p className="lab-error" role="alert">{error}</p>}
      <button
        className="btn btn-secondary"
        onClick={handleAdd}
        disabled={!name.trim() || !ready || busy || locked}
      >
        {busy ? <Loader2 size={15} className="spin" /> : <PlusCircle size={15} />} {t("mcp.addServer", lang)}
      </button>
      <button className="btn" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>{lang === "zh" ? "取消" : "Cancel"}</button>
    </div>
  );
}
