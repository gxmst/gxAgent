import { Loader2, Play, RefreshCw, Server, Square, Trash2, Wrench } from "lucide-react";

export type McpServerState = "stopped" | "starting" | "ready" | "error";

export interface McpServerView {
  name: string;
  command: string;
  args: string[];
  state: McpServerState;
  toolCount?: number;
  message?: string;
}

export function McpServerManager({
  lang,
  servers,
  onTest,
  onStop,
  onDelete,
}: {
  lang: string;
  servers: McpServerView[];
  onTest: (name: string) => void;
  onStop?: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const zh = lang === "zh";
  return (
    <section className="mcp-manager" aria-label={zh ? "MCP 服务" : "MCP servers"}>
      {servers.length === 0 ? (
        <div className="mcp-manager-empty">
          <Server size={22} />
          <span>{zh ? "尚未添加 MCP 服务" : "No MCP servers configured"}</span>
        </div>
      ) : (
        <div className="mcp-manager-list">
          {servers.map((server) => (
            <div key={server.name} className={`mcp-manager-row ${server.state}`} role="status" aria-live="polite">
              <span
                className="mcp-manager-state"
                title={server.message || (server.state === "ready" ? (zh ? "测试通过" : "Connection test passed") : server.state)}
              >
                {server.state === "starting" ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
              </span>
              <div className="mcp-manager-info">
                <strong>{server.name}</strong>
                <span>{server.command} {server.args.join(" ")}</span>
                {server.state === "ready" && !server.message && (
                  <span>{zh ? "测试通过" : "Connection test passed"}</span>
                )}
                {server.message && <span className="mcp-manager-message">{server.message}</span>}
              </div>
              {server.state === "ready" && (
                <span className="mcp-manager-tools"><Wrench size={11} /> {server.toolCount || 0}</span>
              )}
              <div className="mcp-manager-actions">
                <button disabled={server.state === "starting"} onClick={() => onTest(server.name)} title={server.state === "ready" ? (zh ? "重新测试" : "Retest") : (zh ? "测试连接" : "Test connection")}>
                  {server.state === "ready" ? <RefreshCw size={13} /> : <Play size={13} />}
                </button>
                {onStop && server.state === "ready" && (
                  <button onClick={() => onStop(server.name)} title={zh ? "停止" : "Stop"}><Square size={12} /></button>
                )}
                <button disabled={server.state === "starting"} className="danger" onClick={() => onDelete(server.name)} title={zh ? "删除" : "Delete"}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
