import { Server } from "lucide-react";
import { TOOL_NAMES, toolIcon } from "../../appDefaults";
import type { AppConfig } from "../../types";
import type { McpStatus } from "../../store/appStore";
import { t } from "../../i18n";
import { McpServerManager } from "../mcp/McpServerManager";
import { McpAddForm } from "../mcp/McpAddForm";
import { McpInspector } from "../mcp/McpInspector";
import type { ConfirmationOptions } from "../shared/ConfirmDialog";

export function ToolsSettings({ lang, config, setConfig, toggleTool, statuses, onTest, onDelete, addLog, requestConfirmation }: {
  requestConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  toggleTool: (tool: string) => void;
  statuses: Record<string, McpStatus>;
  onTest: (name: string) => void;
  onDelete: (name: string) => void;
  addLog: (text: string, type?: "info" | "success" | "error" | "cmd", showToast?: boolean) => void;
}) {
  return <section id="settings-panel-tools" className="settings-page" role="tabpanel" aria-labelledby="settings-tab-tools">
    <fieldset className="settings-tool-list"><legend>gxAgent {t("settings.tools", lang)}</legend>
      {TOOL_NAMES.map(tool => <label key={tool.key} className="settings-tool-row">
        <input type="checkbox" checked={config.tools_enabled.includes(tool.key)} onChange={() => toggleTool(tool.key)} />
        {toolIcon(tool.key, 14)}<span>{tool.label}</span><small className={`tool-risk ${tool.risk}`}>{tool.risk}</small>
      </label>)}
    </fieldset>
    <div className="settings-panel settings-wide"><div className="settings-panel-header"><span><Server size={14} /> MCP</span><span>{Object.keys(config.mcp_servers).length}</span></div>
      <McpServerManager lang={lang} servers={Object.entries(config.mcp_servers).map(([name, server]) => ({ name, command: server.command, args: server.args || [], state: statuses[name]?.state || "stopped", toolCount: statuses[name]?.toolCount, message: statuses[name]?.message }))} onTest={onTest} onDelete={onDelete} />
      <McpAddForm setConfig={setConfig} addLog={addLog} lang={lang} t={t} config={config} />
    </div>
    <McpInspector config={config} lang={lang} requestConfirmation={requestConfirmation} />
  </section>;
}
