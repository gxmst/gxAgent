import { useState } from "react";
import { CheckCircle2, CircleAlert, Clock3, Globe, Loader2, Terminal, Wrench } from "lucide-react";
import type { ChatSession } from "../../types";
import type { TerminalLogEntry } from "../../store/appStore";
import { executionMessages, taskStateLabel } from "../../utils/workbench";
import { ToolResult } from "../chat/ToolResult";

export function RunActivity({ lang, session, logs, selectedMessageId }: { lang: string; session: ChatSession; logs: TerminalLogEntry[]; selectedMessageId?: string }) {
  const zh = lang === "zh";
  const runs = executionMessages(session.messages);
  const [selection, setSelection] = useState(selectedMessageId || "");
  const selected = runs.find(message => message.id === selection) || runs[runs.length - 1];
  const actions = selected?.actions || [];
  const sources = selected?.searchStatus?.flatMap(status => status.sources || []) || [];
  return <div className="run-activity">
    <div className="run-selector">
      <Clock3 size={15} />
      <select aria-label={zh ? "选择运行记录" : "Select run"} value={selected?.id || ""} onChange={event => setSelection(event.target.value)}>
        {runs.length === 0 && <option value="">{zh ? "暂无运行" : "No runs"}</option>}
        {[...runs].reverse().map((message, index) => <option key={message.id} value={message.id}>{zh ? "运行" : "Run"} {runs.length - index}{message.timestamp ? ` · ${new Date(message.timestamp).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}</option>)}
      </select>
    </div>
    {selected?.run && <div className={`run-outcome state-${selected.run.status}`} role="status">{taskStateLabel(selected.run.status, lang)}{selected.run.finishedAt && <span>{((selected.run.finishedAt - selected.run.startedAt) / 1000).toFixed(1)}s</span>}</div>}
    {actions.length === 0 && <div className="workspace-empty-state"><Wrench size={26} /><span>{zh ? "暂无工具调用" : "No tool calls"}</span></div>}
    <div className="run-tool-list">
      {actions.map(action => <details key={action.id} className={`run-tool status-${action.status}`} open={action.status === "error" || action.status === "blocked" || action.status === "pending_approval" ? true : undefined}>
        <summary>
          {action.status === "executing" || action.status === "drafting" ? <Loader2 size={14} className="spin" /> : action.status === "done" ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
          <span>{action.name}</span><small>{action.status === "done" ? (zh ? "完成" : "Done") : action.status === "pending_approval" ? (zh ? "待确认" : "Approval") : action.status === "blocked" ? (zh ? "已阻止" : "Blocked") : action.status === "error" ? (zh ? "失败" : "Failed") : (zh ? "执行中" : "Running")}</small>
        </summary>
        <pre className="run-tool-arguments">{action.arguments}</pre>
        {action.output && <ToolResult action={action} />}
      </details>)}
    </div>
    {sources.length > 0 && <details className="run-log-section"><summary><Globe size={14} />{zh ? "搜索来源" : "Search sources"}</summary>{sources.filter((source, index) => sources.findIndex(other => other.link === source.link) === index).map(source => <a key={source.link} className="run-source" href={source.link} target="_blank" rel="noopener noreferrer">{source.title || source.link}</a>)}</details>}
    <details className="run-log-section"><summary><Terminal size={14} />{zh ? "会话日志" : "Session logs"}</summary><div className="console-container">{logs.slice(-100).map((log, index) => <div key={index} className={`console-line ${log.type}`}>{log.text}</div>)}</div></details>
  </div>;
}
