import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Download,
  FilePlus2,
  FlaskConical,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type { AppConfig, RetrievalReport } from "../../types";
import { learningConfig } from "../../utils/learning";
import { downloadJson, EvidenceList } from "../workspace/ContextInspector";
import type { ConfirmationOptions } from "../shared/ConfirmDialog";

interface Document {
  id: string;
  path: string;
  title: string;
  scope: string;
  updatedAt: number;
  chunks: number;
  chunkSize: number;
  overlap: number;
}
interface EvalCase {
  id: string;
  question: string;
  expectedDocumentId: string | null;
}
interface EvalRun {
  id: string;
  createdAt: number;
  topK: number;
  mode: string;
  indexRevision: string;
  hitRate: number | null;
  mrr: number | null;
  unanswerable: number;
  noAnswerCorrect: number;
  results: { case: EvalCase; rank: number | null; report: RetrievalReport }[];
}
export function KnowledgeSettings({
  config,
  setConfig,
  lang,
  requestConfirmation,
}: {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  lang: string;
  requestConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
}) {
  const zh = lang === "zh";
  const settings = learningConfig(config);
  const [scopeMode, setScopeMode] = useState("project");
  const scope = scopeMode === "global" ? "" : config.default_work_dir;
  const [documents, setDocuments] = useState<Document[]>([]);
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<RetrievalReport | null>(null);
  const [chunkSize, setChunkSize] = useState(800);
  const [overlap, setOverlap] = useState(120);
  const [question, setQuestion] = useState("");
  const [expected, setExpected] = useState("");
  const [selectedRun, setSelectedRun] = useState("");
  const generation = useRef(0);
  const reload = async () => {
    const current = ++generation.current;
    const [docs, evaluations] = await Promise.all([
      invoke<Document[]>("list_knowledge_documents", { scope }),
      invoke<{ cases: EvalCase[]; runs: EvalRun[] }>("knowledge_evaluations", {
        scope,
      }),
    ]);
    if (generation.current !== current) return;
    setDocuments(docs);
    setCases(evaluations.cases);
    setRuns(evaluations.runs);
  };
  useEffect(() => {
    setReport(null);
    setError("");
    setBusy(true);
    void reload()
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
    return () => {
      generation.current++;
    };
  }, [scope]);
  const execute = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await operation();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const index = (path: string, targetScope = scope) =>
    invoke("index_knowledge_file", {
      path,
      scope: targetScope,
      chunkSize,
      overlap,
    });
  const run = runs.find((r) => r.id === selectedRun) || runs[0];
  const confirmRemove = (title: string) =>
    requestConfirmation({
      title: zh ? "移除索引" : "Remove index",
      message: title,
      confirmLabel: zh ? "移除" : "Remove",
      cancelLabel: zh ? "取消" : "Cancel",
    });
  return (
    <section
      className="settings-page lab-surface"
      role="tabpanel"
      id="settings-panel-knowledge"
      aria-labelledby="settings-tab-knowledge"
    >
      <div className="lab-toolbar">
        <h4>{zh ? "本地知识库" : "Local knowledge"}</h4>
        <label className="lab-check">
          <input
            type="checkbox"
            checked={settings.knowledge_enabled}
            onChange={(e) =>
              setConfig((p) => ({
                ...p,
                learning: {
                  ...learningConfig(p),
                  knowledge_enabled: e.target.checked,
                },
              }))
            }
          />
          {zh ? "回答前检索" : "Retrieve before answering"}
        </label>
      </div>
      <div className="lab-controls">
        <label className="lab-field">
          {zh ? "资料范围" : "Scope"}
          <select
            value={scopeMode}
            disabled={busy}
            onChange={(e) => setScopeMode(e.target.value)}
          >
            <option value="project">
              {zh ? "当前项目与全局" : "Current project & global"}
            </option>
            <option value="global">{zh ? "全局" : "Global"}</option>
          </select>
        </label>
        <label className="lab-field">
          {zh ? "片段字符数" : "Chunk characters"}
          <input
            type="number"
            min={200}
            max={4000}
            value={chunkSize}
            disabled={busy}
            onChange={(e) => setChunkSize(Number(e.target.value))}
          />
        </label>
        <label className="lab-field">
          {zh ? "重叠字符数" : "Overlap characters"}
          <input
            type="number"
            min={0}
            max={Math.max(0, Math.floor(chunkSize / 2) - 1)}
            value={overlap}
            disabled={busy}
            onChange={(e) => setOverlap(Number(e.target.value))}
          />
        </label>
      </div>
      {scope && <p className="lab-path">{scope}</p>}
      <div className="lab-toolbar">
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void execute(async () => {
              const paths = await invoke<string[]>("pick_knowledge_files");
              const failures: string[] = [];
              let done = 0;
              for (const path of paths) {
                setStatus(`${++done}/${paths.length} · ${path}`);
                try {
                  await index(path);
                } catch (e) {
                  failures.push(`${path}: ${e}`);
                }
              }
              await reload();
              setStatus(
                zh
                  ? `已处理 ${paths.length} 份文档`
                  : `${paths.length} documents processed`,
              );
              if (failures.length) setError(failures.join("\n"));
            })
          }
        >
          <FilePlus2 size={14} />
          {zh ? "添加文档" : "Add documents"}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => void execute(reload)}
        >
          <RefreshCw size={14} />
          {zh ? "刷新" : "Refresh"}
        </button>
      </div>
      {busy && (
        <p role="status">{status || (zh ? "处理中..." : "Working...")}</p>
      )}
      {!busy && status && <p role="status">{status}</p>}
      {error && (
        <p role="alert" className="lab-error">
          {error}
        </p>
      )}
      <div className="knowledge-documents">
        {!documents.length && !busy && (
          <p className="lab-muted">{zh ? "暂无文档" : "No documents"}</p>
        )}
        {documents.map((doc) => (
          <div className="lab-row" key={doc.id}>
            <div>
              <strong>{doc.title}</strong>
              <small>
                {doc.chunks} {zh ? "片段" : "chunks"} ·{" "}
                {doc.scope ? (zh ? "项目" : "Project") : zh ? "全局" : "Global"}{" "}
                · {new Date(doc.updatedAt).toLocaleString()}
              </small>
              <span className="lab-path">{doc.path}</span>
            </div>
            <button
              className="panel-toggle-btn"
              disabled={busy}
              title={zh ? "重新索引" : "Reindex"}
              aria-label={`${zh ? "重新索引" : "Reindex"} ${doc.title}`}
              onClick={() =>
                void execute(async () => {
                  await index(doc.path, doc.scope);
                  await reload();
                })
              }
            >
              <RefreshCw size={14} />
            </button>
            <button
              className="panel-toggle-btn"
              disabled={busy}
              title={zh ? "移除索引" : "Remove index"}
              aria-label={`${zh ? "移除索引" : "Remove index"} ${doc.title}`}
              onClick={async () => {
                if (await confirmRemove(doc.title))
                  void execute(async () => {
                    await invoke("remove_knowledge_document", { id: doc.id });
                    await reload();
                    setReport(null);
                  });
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <section className="lab-section">
        <h4>{zh ? "检索实验" : "Retrieval experiment"}</h4>
        <div className="lab-controls">
          <label className="lab-field">
            {zh ? "匹配方式" : "Match mode"}
            <select
              value={settings.match_mode}
              disabled={busy}
              onChange={(e) =>
                setConfig((p) => ({
                  ...p,
                  learning: {
                    ...learningConfig(p),
                    match_mode: e.target.value as "any" | "all",
                  },
                }))
              }
            >
              <option value="any">
                BM25 · {zh ? "任意关键词" : "Any term"}
              </option>
              <option value="all">
                BM25 · {zh ? "全部关键词" : "All terms"}
              </option>
            </select>
          </label>
          <label className="lab-field">
            Top K
            <input
              type="number"
              min={1}
              max={20}
              value={settings.top_k}
              disabled={busy}
              onChange={(e) =>
                setConfig((p) => ({
                  ...p,
                  learning: {
                    ...learningConfig(p),
                    top_k: Math.max(1, Math.min(20, Number(e.target.value))),
                  },
                }))
              }
            />
          </label>
        </div>
        <form
          className="lab-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            void execute(async () =>
              setReport(
                await invoke<RetrievalReport>("search_knowledge", {
                  query,
                  scope,
                  topK: settings.top_k,
                  mode: settings.match_mode,
                }),
              ),
            );
          }}
        >
          <input
            aria-label={zh ? "检索问题" : "Search query"}
            value={query}
            maxLength={2000}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" disabled={busy || !query.trim()}>
            <Search size={14} />
            {zh ? "检索" : "Search"}
          </button>
        </form>
        {report && (
          <>
            <p className="lab-muted">
              {report.hits.length} {zh ? "片段" : "passages"} ·{" "}
              {report.durationMs} ms
            </p>
            <EvidenceList hits={report.hits} lang={lang} />
          </>
        )}
      </section>
      <section className="lab-section">
        <h4>{zh ? "检索评测" : "Retrieval evaluation"}</h4>
        <label className="lab-field">
          {zh ? "固定问题" : "Evaluation question"}
          <input
            value={question}
            maxLength={2000}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <label className="lab-field">
          {zh ? "预期出处" : "Expected source"}
          <select
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          >
            <option value="">
              {zh ? "资料中没有答案" : "No answer in corpus"}
            </option>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
        <div className="lab-toolbar">
          <button
            className="btn"
            disabled={busy || !question.trim()}
            onClick={() =>
              void execute(async () => {
                await invoke("save_knowledge_case", {
                  scope,
                  question,
                  expectedDocumentId: expected || null,
                });
                setQuestion("");
                await reload();
              })
            }
          >
            <Plus size={14} />
            {zh ? "添加问题" : "Add question"}
          </button>
          <button
            className="btn"
            disabled={busy || !cases.length}
            onClick={() =>
              void execute(async () => {
                const result = await invoke<EvalRun>(
                  "run_knowledge_evaluation",
                  { scope, topK: settings.top_k, mode: settings.match_mode },
                );
                setSelectedRun(result.id);
                await reload();
              })
            }
          >
            <FlaskConical size={14} />
            {zh ? "运行评测" : "Evaluate"}
          </button>
        </div>
        {cases.map((item) => (
          <div className="lab-row" key={item.id}>
            <div>
              <span>{item.question}</span>
              <small>
                {item.expectedDocumentId
                  ? documents.find((d) => d.id === item.expectedDocumentId)
                      ?.title || (zh ? "出处已移除" : "Source removed")
                  : zh
                    ? "无答案"
                    : "Unanswerable"}
              </small>
            </div>
            <button
              className="panel-toggle-btn"
              title={zh ? "删除问题" : "Delete question"}
              aria-label={`${zh ? "删除问题" : "Delete question"} ${item.question}`}
              disabled={busy}
              onClick={() =>
                void execute(async () => {
                  await invoke("delete_knowledge_case", { id: item.id });
                  await reload();
                })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {run && (
          <>
            <div className="lab-toolbar">
              <select
                aria-label={zh ? "评测记录" : "Evaluation run"}
                value={run.id}
                onChange={(e) => setSelectedRun(e.target.value)}
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.createdAt).toLocaleString()} · {r.mode} · K=
                    {r.topK}
                  </option>
                ))}
              </select>
              <button
                className="panel-toggle-btn"
                title={zh ? "导出评测" : "Export evaluation"}
                aria-label={zh ? "导出评测" : "Export evaluation"}
                onClick={() => downloadJson(run, "gxagent-evaluation.json")}
              >
                <Download size={14} />
              </button>
            </div>
            <div className="lab-metrics">
              <span>
                Hit@{run.topK}{" "}
                <strong>
                  {run.hitRate === null
                    ? "N/A"
                    : `${(run.hitRate * 100).toFixed(1)}%`}
                </strong>
              </span>
              <span>
                MRR <strong>{run.mrr?.toFixed(3) ?? "N/A"}</strong>
              </span>
              <span>
                {zh ? "无答案判定" : "No-answer retrieval"}{" "}
                <strong>
                  {run.noAnswerCorrect}/{run.unanswerable}
                </strong>
              </span>
            </div>
            <p className="lab-path">Index: {run.indexRevision}</p>
            {run.results.map((result) => (
              <details className="context-entry" key={result.case.id}>
                <summary>
                  {result.case.question} ·{" "}
                  {result.rank ? `#${result.rank}` : zh ? "未命中" : "No hit"}
                </summary>
                <EvidenceList hits={result.report.hits} lang={lang} />
              </details>
            ))}
          </>
        )}
      </section>
    </section>
  );
}
