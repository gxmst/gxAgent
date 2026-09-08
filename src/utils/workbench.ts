import type { ChatSession, Message } from "../types";
import { comparableWorkspacePath, type SessionRuntime } from "../appDefaults";

export interface ProjectGroup {
  id: string;
  name: string;
  workDir: string;
  sessions: ChatSession[];
}

export function projectName(workDir: string): string {
  return workDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || workDir;
}

export function groupProjectSessions(sessions: ChatSession[], defaultWorkDir: string): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const workDir = session.sessionConfig.workDir ?? defaultWorkDir;
    const id = comparableWorkspacePath(workDir);
    const group = groups.get(id) || { id, name: projectName(workDir), workDir, sessions: [] };
    group.sessions.push(session);
    groups.set(id, group);
  }
  return [...groups.values()];
}

export type TaskState = "ready" | "preparing" | "running" | "stopping" | "approval" | "completed" | "error" | "stopped" | "interrupted";

export function taskState(session: ChatSession, runtime?: SessionRuntime | null, approval?: unknown, preparing = false): TaskState {
  if (runtime?.status === "stopping") return "stopping";
  if (approval) return "approval";
  if (runtime) return "running";
  if (preparing) return "preparing";
  const last = [...session.messages].reverse().find(message => message.role === "assistant");
  if (!last) return "ready";
  if (last.run?.status) return last.run.status === "running" ? "interrupted" : last.run.status;
  if (last.actions?.some(action => action.status === "error" || action.status === "blocked") || /^Error:/i.test(last.content)) return "error";
  return "completed";
}

const STATUS_LABELS: Record<TaskState, [string, string]> = {
  ready: ["待开始", "Ready"],
  preparing: ["准备中", "Preparing"],
  running: ["运行中", "Running"],
  stopping: ["正在停止", "Stopping"],
  approval: ["等待确认", "Needs approval"],
  completed: ["已完成", "Completed"],
  error: ["执行异常", "Failed"],
  stopped: ["已停止", "Stopped"],
  interrupted: ["运行中断", "Interrupted"],
};

export function taskStateLabel(state: TaskState, lang: string): string {
  return STATUS_LABELS[state][lang === "zh" ? 0 : 1];
}

export function executionMessages(messages: Message[]): Message[] {
  return messages.filter(message => message.role === "assistant" && (message.run || message.actions?.length || message.content));
}
