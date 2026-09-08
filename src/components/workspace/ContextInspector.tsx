import { useState } from "react";
import { Braces, Download } from "lucide-react";
import type { ChatSession, KnowledgeHit } from "../../types";

export function EvidenceList({
  hits,
  lang,
  prefix,
}: {
  hits: KnowledgeHit[];
  lang: string;
  prefix?: string;
}) {
  return (
    <div className="evidence-list">
      {hits.map((hit) => (
        <details
          key={hit.chunkId}
          id={prefix ? `kb-${prefix}-${hit.chunkId}` : undefined}
        >
          <summary>
            <span>{hit.title}</span>
            <small>
              {hit.startChar}-{hit.endChar}
            </small>
          </summary>
          <div className="evidence-meta">
            <code>[KB:{hit.chunkId}]</code>
            <span>{hit.path}</span>
            <span>BM25 {hit.score.toPrecision(4)}</span>
          </div>
          <pre>{hit.text}</pre>
        </details>
      ))}
      {hits.length === 0 && (
        <p className="lab-muted">
          {lang === "zh" ? "未检索到相关片段" : "No matching passages"}
        </p>
      )}
    </div>
  );
}

export function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ContextInspector({
  session,
  lang,
  selectedMessageId,
}: {
  session: ChatSession;
  lang: string;
  selectedMessageId?: string;
}) {
  const zh = lang === "zh";
  const runs = session.messages.filter(
    (m) => m.contextSnapshots?.length || m.learningContext,
  );
  const [selected, setSelected] = useState(selectedMessageId || "");
  const run = runs.find((m) => m.id === selected) || runs[runs.length - 1];
  const [iteration, setIteration] = useState(-1);
  const snapshots = run?.contextSnapshots || [];
  const snapshot =
    snapshots.find((s) => s.iteration === iteration) ||
    snapshots[snapshots.length - 1];
  return (
    <div className="context-inspector lab-surface">
      <div className="lab-toolbar">
        <Braces size={16} />
        <select
          aria-label={zh ? "上下文运行记录" : "Context run"}
          value={run?.id || ""}
          onChange={(e) => {
            setSelected(e.target.value);
            setIteration(-1);
          }}
        >
          {!runs.length && (
            <option value="">
              {zh ? "暂无上下文快照" : "No context snapshots"}
            </option>
          )}
          {[...runs].reverse().map((m, i) => (
            <option key={m.id} value={m.id}>
              {zh ? "运行" : "Run"} {runs.length - i} ·{" "}
              {new Date(
                m.run?.startedAt || m.timestamp || 0,
              ).toLocaleTimeString()}
            </option>
          ))}
        </select>
        <button
          className="panel-toggle-btn"
          disabled={!run}
          title={zh ? "导出上下文" : "Export context"}
          aria-label={zh ? "导出上下文" : "Export context"}
          onClick={() =>
            downloadJson(
              { snapshots, learning: run?.learningContext },
              "gxagent-context.json",
            )
          }
        >
          <Download size={15} />
        </button>
      </div>
      {snapshot && (
        <>
          <div className="lab-toolbar">
            <select
              aria-label={zh ? "模型调用轮次" : "Model iteration"}
              value={snapshot.iteration}
              onChange={(e) => setIteration(Number(e.target.value))}
            >
              {snapshots.map((s) => (
                <option key={s.iteration} value={s.iteration}>
                  {zh ? "调用" : "Call"} {s.iteration}
                </option>
              ))}
            </select>
            <span className="lab-muted">
              {snapshot.engine === "codex-input"
                ? zh
                  ? "交给 Codex 的输入"
                  : "Input supplied to Codex"
                : zh
                  ? "原生请求上下文"
                  : "Native request context"}
            </span>
          </div>
          {snapshot.truncated && (
            <p role="status">{zh ? "快照已截断" : "Snapshot truncated"}</p>
          )}
          {snapshot.messages.map((message, i) => (
            <details key={i} className="context-entry">
              <summary>
                {String((message as { role?: string })?.role || "message")} ·{" "}
                {i + 1}
              </summary>
              <pre>{JSON.stringify(message, null, 2)}</pre>
            </details>
          ))}
          <details className="context-entry">
            <summary>
              {zh ? "工具定义" : "Tool definitions"} · {snapshot.tools.length}
            </summary>
            <pre>{JSON.stringify(snapshot.tools, null, 2)}</pre>
          </details>
        </>
      )}
      {run?.learningContext?.skills.map((skill) => (
        <details className="context-entry" key={skill.id}>
          <summary>Skill · {skill.name}</summary>
          <p className="lab-path">{skill.path}</p>
          <pre>{skill.body}</pre>
        </details>
      ))}
      {run?.learningContext?.retrieval && (
        <section className="lab-section">
          <h4>{zh ? "检索证据" : "Retrieved evidence"}</h4>
          <p>{run.learningContext.retrieval.query}</p>
          <EvidenceList hits={run.learningContext.retrieval.hits} lang={lang} />
        </section>
      )}
    </div>
  );
}
