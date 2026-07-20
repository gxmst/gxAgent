import { CheckCircle2, Circle, Loader2 } from "lucide-react";

export interface AgentTaskItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export function parseTaskItems(argumentsJson: string): AgentTaskItem[] {
  try {
    const parsed = JSON.parse(argumentsJson || "{}");
    if (!Array.isArray(parsed.todos)) return [];
    return parsed.todos
      .filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item: Record<string, unknown>): AgentTaskItem => ({
        content: String(item.content || "").trim(),
        status: item.status === "completed" || item.status === "in_progress"
          ? item.status
          : "pending",
      }))
      .filter((item: AgentTaskItem) => item.content.length > 0);
  } catch {
    return [];
  }
}

export function TaskProgress({
  argumentsJson,
  title,
}: {
  argumentsJson: string;
  title: string;
}) {
  const items = parseTaskItems(argumentsJson);
  if (items.length === 0) return null;

  const completed = items.filter((item) => item.status === "completed").length;
  const percent = Math.round((completed / items.length) * 100);

  return (
    <section className="task-progress" aria-label={title}>
      <header className="task-progress-header">
        <span>{title}</span>
        <span>{completed}/{items.length}</span>
      </header>
      <div className="task-progress-meter" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <ol className="task-progress-list">
        {items.map((item, index) => (
          <li key={`${index}-${item.content}`} className={`task-progress-item ${item.status}`}>
            {item.status === "completed" ? (
              <CheckCircle2 size={14} />
            ) : item.status === "in_progress" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Circle size={14} />
            )}
            <span>{item.content}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
