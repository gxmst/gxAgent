import { useCallback, useEffect, useState } from "react";
import { comparableWorkspacePath } from "../../appDefaults";
import { invoke } from "@tauri-apps/api/core";
import {
  Brain,
  Check,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";

interface GitWorktreeInfo {
  path: string;
  head: string;
  branch?: string | null;
  isMain: boolean;
  bare: boolean;
}

interface BackgroundProcessInfo {
  id: string;
  label: string;
  command: string;
  workDir: string;
  pid?: number | null;
  running: boolean;
  exitCode?: number | null;
  startedAt: number;
  outputBytes: number;
}

interface BackgroundProcessOutput {
  id: string;
  running: boolean;
  exitCode?: number | null;
  output: string;
}

interface MemoryEntry {
  id: string;
  category: string;
  key: string;
  content: string;
  updatedAt: number;
}

export function WorkspaceRuntimePanel({
  lang,
  workDir,
  disabled,
  onSelectWorkDir,
  repositoryRoot,
}: {
  lang: string;
  workDir: string;
  repositoryRoot?: string;
  disabled: boolean;
  onSelectWorkDir?: (workDir: string) => void;
}) {
  const zh = lang === "zh";
  const [loading, setLoading] = useState(false);

  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [wtError, setWtError] = useState("");
  const [branchInput, setBranchInput] = useState("");
  const [wtBusy, setWtBusy] = useState(false);

  const [processes, setProcesses] = useState<BackgroundProcessInfo[]>([]);
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [processOutput, setProcessOutput] = useState<BackgroundProcessOutput | null>(null);

  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memCategory, setMemCategory] = useState("project");
  const [memKey, setMemKey] = useState("");
  const [memContent, setMemContent] = useState("");
  const [memError, setMemError] = useState("");

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [wtRes, bgRes, memRes] = await Promise.allSettled([
        workDir
          ? invoke<GitWorktreeInfo[]>("list_git_worktrees", {
              workDir,
              defaultWorkDir: workDir,
            })
          : Promise.resolve([]),
        workDir ? invoke<BackgroundProcessInfo[]>("list_background_processes", { workDir }) : Promise.resolve([]),
        workDir
          ? invoke<MemoryEntry[]>("list_project_memories", { workDir })
          : Promise.resolve([]),
      ]);
      if (wtRes.status === "fulfilled") {
        setWorktrees(Array.isArray(wtRes.value) ? wtRes.value : []);
        setWtError("");
      } else {
        setWorktrees([]);
        setWtError(String(wtRes.reason));
      }
      if (bgRes.status === "fulfilled") {
        setProcesses(Array.isArray(bgRes.value) ? bgRes.value : []);
      }
      if (memRes.status === "fulfilled") {
        setMemories(Array.isArray(memRes.value) ? memRes.value : []);
      }
    } finally {
      setLoading(false);
    }
  }, [workDir]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const inspectProcess = async (id: string) => {
    setSelectedProcessId(id);
    try {
      const res = await invoke<BackgroundProcessOutput>("read_background_output_cmd", {
        workDir,
        processId: id,
        tailLines: 120,
      });
      setProcessOutput(res);
    } catch {
      setProcessOutput(null);
    }
  };

  const stopProcess = async (id: string) => {
    try {
      await invoke("stop_background_process_cmd", { workDir, processId: id });
      if (selectedProcessId === id) {
        setSelectedProcessId(null);
        setProcessOutput(null);
      }
      await refreshAll();
    } catch {
      await refreshAll();
    }
  };

  const createWorktree = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!workDir || !branchInput.trim() || wtBusy) return;
    setWtBusy(true);
    setWtError("");
    try {
      const created = await invoke<GitWorktreeInfo>("create_git_worktree", {
        workDir,
        defaultWorkDir: workDir,
        branchName: branchInput.trim(),
      });
      setBranchInput("");
      await refreshAll();
      if (created?.path && onSelectWorkDir) {
        onSelectWorkDir(created.path);
      }
    } catch (error) {
      setWtError(String(error));
    } finally {
      setWtBusy(false);
    }
  };

  const removeWorktree = async (path: string) => {
    if (!workDir || wtBusy) return;
    setWtBusy(true);
    setWtError("");
    try {
      await invoke("remove_git_worktree", {
        workDir,
        defaultWorkDir: workDir,
        worktreePath: path,
        force: false,
      });
      await refreshAll();
    } catch (error) {
      setWtError(String(error));
    } finally {
      setWtBusy(false);
    }
  };

  const saveMemory = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!workDir || !memKey.trim() || !memContent.trim()) return;
    setMemError("");
    try {
      await invoke("save_project_memory", {
        workDir,
        category: memCategory,
        key: memKey.trim(),
        content: memContent.trim(),
      });
      setMemKey("");
      setMemContent("");
      await refreshAll();
    } catch (error) {
      setMemError(String(error));
    }
  };

  const deleteMemory = async (idOrKey: string) => {
    if (!workDir) return;
    try {
      await invoke("delete_project_memory", { workDir, idOrKey });
      await refreshAll();
    } catch (error) {
      setMemError(String(error));
    }
  };

  return (
    <div className="runtime-panel">
      <div className="runtime-toolbar">
        <span>{zh ? "隔离工作区、后台进程与长期记忆" : "Worktrees, Background Processes & Memory"}</span>
        <button
          className="panel-toggle-btn"
          type="button"
          disabled={loading}
          onClick={() => void refreshAll()}
          title={zh ? "刷新环境状态" : "Refresh environment"}
          aria-label={zh ? "刷新环境状态" : "Refresh environment"}
        >
          <RefreshCw size={13} className={loading ? "spin" : ""} />
        </button>
      </div>

      {/* Git Worktrees */}
      <section className="runtime-card" aria-label={zh ? "Git Worktree 隔离" : "Git Worktrees"}>
        <header className="runtime-card-header">
          <GitBranch size={14} />
          <strong>{zh ? "Git Worktree 分支隔离" : "Git Worktrees"}</strong>
          <span>{worktrees.length}</span>
        </header>
        {worktrees.length > 0 && (
          <div className="runtime-list">
            {worktrees.map((wt) => {
              const active = comparableWorkspacePath(wt.path) === comparableWorkspacePath(repositoryRoot || workDir);
              return (
                <div key={wt.path} className={`runtime-row ${active ? "active" : ""}`}>
                  <div className="runtime-row-info">
                    <span className="runtime-row-title">
                      {wt.branch || (wt.bare ? "(bare)" : wt.head.slice(0, 7))}
                      {wt.isMain && <small className="runtime-badge">{zh ? "主仓库" : "main"}</small>}
                      {active && <small className="runtime-badge active"><Check size={10} /> {zh ? "当前" : "active"}</small>}
                    </span>
                    <span className="runtime-row-sub" title={wt.path}>{wt.path}</span>
                  </div>
                  <div className="runtime-row-actions">
                    {!active && onSelectWorkDir && (
                      <button
                        type="button"
                        className="btn"
                        disabled={disabled || wtBusy}
                        onClick={() => onSelectWorkDir(wt.path)}
                      >
                        {zh ? "切换" : "Use"}
                      </button>
                    )}
                    {!wt.isMain && !active && (
                      <button
                        type="button"
                        className="panel-toggle-btn"
                        disabled={disabled || wtBusy}
                        onClick={() => void removeWorktree(wt.path)}
                        title={zh ? "移除 worktree" : "Remove worktree"}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {wtError && <div className="workspace-inline-state error">{wtError}</div>}
        {workDir && !wtError && (
          <form className="runtime-inline-form" onSubmit={(e) => void createWorktree(e)}>
            <input
              className="input-text"
              type="text"
              placeholder={zh ? "新分支名（如 feat/isolation）" : "New branch (e.g. feat/task)"}
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
              disabled={disabled || wtBusy}
            />
            <button
              className="btn"
              type="submit"
              disabled={disabled || wtBusy || !branchInput.trim()}
            >
              {wtBusy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
              {zh ? "创建并切换" : "Create"}
            </button>
          </form>
        )}
      </section>

      {/* Background Processes */}
      <section className="runtime-card" aria-label={zh ? "后台进程" : "Background Processes"}>
        <header className="runtime-card-header">
          <Terminal size={14} />
          <strong>{zh ? "后台进程" : "Background Processes"}</strong>
          <span>{processes.filter((p) => p.running).length}</span>
        </header>
        {processes.length === 0 ? (
          <p className="runtime-empty">{zh ? "暂无由 Agent 启动的后台进程" : "No managed background processes running."}</p>
        ) : (
          <div className="runtime-list">
            {processes.map((proc) => (
              <div key={proc.id} className="runtime-row">
                <div className="runtime-row-info">
                  <span className="runtime-row-title">
                    {proc.label}
                    <small className={`runtime-badge ${proc.running ? "active" : ""}`}>
                      {proc.running ? (zh ? "运行中" : "running") : (zh ? `已退出 (${proc.exitCode ?? "?"})` : `exit ${proc.exitCode ?? "?"}`)}
                    </small>
                  </span>
                  <span className="runtime-row-sub" title={proc.command}>{proc.id} · {proc.command}</span>
                </div>
                <div className="runtime-row-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void inspectProcess(proc.id)}
                  >
                    {zh ? "日志" : "Logs"}
                  </button>
                  {proc.running && (
                    <button
                      type="button"
                      className="panel-toggle-btn"
                      onClick={() => void stopProcess(proc.id)}
                      title={zh ? "停止进程" : "Stop process"}
                    >
                      <Square size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {processOutput && selectedProcessId && (
          <pre className="runtime-log-tail">
            <code>{processOutput.output || (zh ? "（暂无输出）" : "(no output yet)")}</code>
          </pre>
        )}
      </section>

      {/* Persistent Project Memory */}
      <section className="runtime-card" aria-label={zh ? "跨会话项目记忆" : "Project Memory"}>
        <header className="runtime-card-header">
          <Brain size={14} />
          <strong>{zh ? "跨会话长期记忆" : "Persistent Memory"}</strong>
          <span>{memories.length}</span>
        </header>
        {memories.length === 0 ? (
          <p className="runtime-empty">{zh ? "尚无项目记忆；Agent 或你可随时保存关键约定。" : "No saved memories for this workspace yet."}</p>
        ) : (
          <div className="runtime-list">
            {memories.map((mem) => (
              <div key={mem.id} className="runtime-row">
                <div className="runtime-row-info">
                  <span className="runtime-row-title">
                    {mem.key}
                    <small className="runtime-badge">{mem.category}</small>
                  </span>
                  <span className="runtime-row-sub">{mem.content}</span>
                </div>
                <button
                  type="button"
                  className="panel-toggle-btn"
                  disabled={disabled}
                  onClick={() => void deleteMemory(mem.id)}
                  title={zh ? "删除记忆" : "Delete memory"}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {memError && <div className="workspace-inline-state error">{memError}</div>}
        {workDir && (
          <form className="runtime-memory-form" onSubmit={(e) => void saveMemory(e)}>
            <div className="runtime-inline-form">
              <select
                className="input-text"
                value={memCategory}
                onChange={(e) => setMemCategory(e.target.value)}
              >
                <option value="project">project</option>
                <option value="user">user</option>
                <option value="feedback">feedback</option>
                <option value="reference">reference</option>
              </select>
              <input
                className="input-text"
                type="text"
                placeholder={zh ? "记忆键（如 test-cmd）" : "Key (e.g. test-cmd)"}
                value={memKey}
                onChange={(e) => setMemKey(e.target.value)}
              />
            </div>
            <div className="runtime-inline-form">
              <input
                className="input-text"
                type="text"
                placeholder={zh ? "要记住的约定或偏好..." : "Concise note to remember..."}
                value={memContent}
                onChange={(e) => setMemContent(e.target.value)}
              />
              <button
                className="btn"
                type="submit"
                disabled={!memKey.trim() || !memContent.trim()}
              >
                <Plus size={13} />
                {zh ? "保存" : "Save"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
