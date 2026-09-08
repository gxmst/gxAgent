import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Play, RefreshCw } from "lucide-react";
import type { AppConfig } from "../../types";
import type { ConfirmationOptions } from "../shared/ConfirmDialog";
import { useAppStore } from "../../store/appStore";

type Tool = { name: string; description?: string; inputSchema?: unknown };
type CallResult = {
  result: { isError?: boolean; [key: string]: unknown };
  durationMs: number;
};
export function McpInspector({
  config,
  lang,
  requestConfirmation,
}: {
  config: AppConfig;
  lang: string;
  requestConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
}) {
  const zh = lang === "zh";
  const [server, setServer] = useState("");
  const selected = config.mcp_servers[server]
    ? server
    : Object.keys(config.mcp_servers)[0] || "";
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolName, setToolName] = useState("");
  const [catalogKey, setCatalogKey] = useState("");
  const key = JSON.stringify([selected, config.mcp_servers[selected]]);
  const tool =
    catalogKey === key ? tools.find((t) => t.name === toolName) : undefined;
  const [argumentsText, setArgumentsText] = useState("{}");
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useAppStore((s) =>
    Boolean(s.activeRunSessionId || s.preparingRequestSessionId),
  );
  const inspect = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const catalog = await invoke<Tool[]>("inspect_mcp_tools", {
        config: config.mcp_servers[selected],
      });
      setTools(catalog);
      setCatalogKey(key);
      setToolName(catalog[0]?.name || "");
      setArgumentsText("{}");
    } catch (e) {
      setError(String(e));
      setTools([]);
    } finally {
      setBusy(false);
    }
  };
  const call = async () => {
    if (!tool) return;
    setError("");
    setResult(null);
    let args: unknown;
    try {
      args = JSON.parse(argumentsText);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error(
          zh ? "参数必须是 JSON 对象" : "Arguments must be a JSON object",
        );
    } catch (e) {
      setError(String(e));
      return;
    }
    if (
      !(await requestConfirmation({
        title: zh ? "调用 MCP 工具" : "Call MCP tool",
        message: `${selected} / ${tool.name}\n${argumentsText}`,
        confirmLabel: zh ? "调用" : "Call",
        cancelLabel: zh ? "取消" : "Cancel",
      }))
    )
      return;
    if (
      useAppStore.getState().activeRunSessionId ||
      useAppStore.getState().preparingRequestSessionId
    )
      return;
    setBusy(true);
    try {
      setResult(
        await invoke<CallResult>("call_mcp_debug", {
          config: config.mcp_servers[selected],
          tool: tool.name,
          arguments: args,
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="lab-section">
      <h4>{zh ? "MCP 调试" : "MCP inspector"}</h4>
      <div className="lab-toolbar">
        <select
          aria-label={zh ? "调试服务" : "Debug server"}
          value={selected}
          disabled={busy}
          onChange={(e) => {
            setServer(e.target.value);
            setResult(null);
            setError("");
          }}
        >
          {!selected && (
            <option value="">{zh ? "暂无服务" : "No servers"}</option>
          )}
          {Object.keys(config.mcp_servers).map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <button
          className="btn"
          disabled={!selected || busy || running}
          onClick={() => void inspect()}
        >
          {busy ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {zh ? "读取工具" : "Inspect tools"}
        </button>
      </div>
      {catalogKey === key && tools.length > 0 && (
        <>
          <label className="lab-field">
            {zh ? "工具" : "Tool"}
            <select
              value={toolName}
              disabled={busy}
              onChange={(e) => {
                setToolName(e.target.value);
                setResult(null);
                setArgumentsText("{}");
              }}
            >
              {tools.map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
            </select>
          </label>
          {tool?.description && <p className="lab-muted">{tool.description}</p>}
          <details className="context-entry">
            <summary>JSON Schema</summary>
            <pre>{JSON.stringify(tool?.inputSchema, null, 2)}</pre>
          </details>
          <label className="lab-field">
            {zh ? "调用参数" : "Arguments"}
            <textarea
              spellCheck={false}
              rows={6}
              value={argumentsText}
              disabled={busy}
              onChange={(e) => setArgumentsText(e.target.value)}
            />
          </label>
          <button
            className="btn"
            disabled={busy || running || !tool}
            onClick={() => void call()}
          >
            <Play size={14} />
            {zh ? "调用工具" : "Call tool"}
          </button>
        </>
      )}
      {error && (
        <p className="lab-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div role={result.result.isError ? "alert" : "status"}>
          <p>
            {result.result.isError
              ? zh
                ? "工具执行失败"
                : "Tool returned an error"
              : zh
                ? "调用完成"
                : "Call completed"}{" "}
            · {result.durationMs} ms
          </p>
          <pre className="lab-json">
            {JSON.stringify(result.result, null, 2)}
          </pre>
        </div>
      )}
    </section>
  );
}
