import { Fragment, useMemo, useState } from "react";
import { parsePatch } from "diff";
import { Copy, MessageSquarePlus, Trash2, WrapText } from "lucide-react";
import { notify } from "../../services/agentEvents";

export interface DiffReviewComment {
  id: string;
  path: string;
  lineNumber: number;
  side: "old" | "new";
  lineText: string;
  text: string;
}

export function UnifiedDiff({
  diff,
  lang,
  label,
  filePath,
  comments,
  onAddComment,
  onDeleteComment,
}: {
  diff: string;
  lang: string;
  label?: string;
  filePath?: string;
  comments?: DiffReviewComment[];
  onAddComment?: (comment: Omit<DiffReviewComment, "id">) => void;
  onDeleteComment?: (id: string) => void;
}) {
  const [wrap, setWrap] = useState(true);
  const [draftTarget, setDraftTarget] = useState<{
    key: string;
    lineNumber: number;
    side: "old" | "new";
    lineText: string;
  } | null>(null);
  const [draftText, setDraftText] = useState("");
  const patches = useMemo(() => { try { return parsePatch(diff); } catch { return []; } }, [diff]);
  const hasHunks = patches.some(patch => patch.hunks.length > 0);
  const zh = lang === "zh";
  return <div className={`review-diff ${wrap ? "wrap" : "nowrap"}`}>
    <div className="review-diff-toolbar">
      <span title={label}>{label || (zh ? "差异" : "Diff")}</span>
      <button className="panel-toggle-btn" aria-pressed={wrap} aria-label={zh ? "自动换行" : "Wrap lines"} title={zh ? "自动换行" : "Wrap lines"} onClick={() => setWrap(!wrap)}><WrapText size={14} /></button>
      <button className="panel-toggle-btn" aria-label={zh ? "复制差异" : "Copy diff"} title={zh ? "复制差异" : "Copy diff"} onClick={async () => {
        try { await navigator.clipboard.writeText(diff); notify(zh ? "差异已复制" : "Diff copied", "success"); }
        catch (error) { notify(String(error), "error"); }
      }}><Copy size={13} /></button>
    </div>
    <div className="review-diff-body">
      {hasHunks ? patches.map((patch, patchIndex) => <div key={patchIndex}>
        {patches.length > 1 && <div className="review-hunk-header">{patch.newFileName || patch.oldFileName}</div>}
        {patch.hunks.map((hunk, hunkIndex) => {
          let oldLine = hunk.oldStart;
          let newLine = hunk.newStart;
          return <div key={hunkIndex}>
            <div className="review-hunk-header">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
            {hunk.lines.map((line, index) => {
              const kind = line[0] === "+" ? "add" : line[0] === "-" ? "remove" : "context";
              const annotation = line.startsWith("\\");
              const before = annotation || kind === "add" ? "" : oldLine++;
              const after = annotation || kind === "remove" ? "" : newLine++;
              const side: "old" | "new" = kind === "remove" ? "old" : "new";
              const lineNumber = typeof after === "number" ? after : typeof before === "number" ? before : 0;
              const lineKey = `${patchIndex}:${hunkIndex}:${index}`;
              const targetPath = filePath || label || "file";
              const lineComments = (comments || []).filter(
                (c) => c.lineNumber === lineNumber && c.side === side && lineNumber > 0
              );
              return <Fragment key={lineKey}>
                <div className={`review-diff-line ${kind}`}>
                  <span className="diff-line-number" aria-hidden="true">{before}</span>
                  <span className="diff-line-number" aria-hidden="true">{after}</span>
                  <code>{line || " "}</code>
                  {onAddComment && !annotation && lineNumber > 0 && (
                    <button
                      type="button"
                      className="diff-line-add-comment"
                      aria-label={zh ? `批注${side === "old" ? "旧" : "新"}第 ${lineNumber} 行` : `Comment on ${side} line ${lineNumber}`}
                      title={zh ? "添加行内批注" : "Add inline comment"}
                      onClick={() => {
                        setDraftTarget({ key: lineKey, lineNumber, side, lineText: line });
                        setDraftText("");
                      }}
                    >
                      <MessageSquarePlus size={12} />
                    </button>
                  )}
                </div>
                {lineComments.map((comment) => (
                  <div key={comment.id} className="diff-comment-item">
                    <span>{comment.text}</span>
                    {onDeleteComment && (
                      <button
                        type="button"
                        className="panel-toggle-btn"
                        aria-label={zh ? "删除批注" : "Delete comment"}
                        onClick={() => onDeleteComment(comment.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}
                {draftTarget?.key === lineKey && onAddComment && (
                  <form
                    className="diff-comment-draft"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const clean = draftText.trim();
                      if (!clean) return;
                      onAddComment({
                        path: targetPath,
                        lineNumber: draftTarget.lineNumber,
                        side: draftTarget.side,
                        lineText: draftTarget.lineText,
                        text: clean,
                      });
                      setDraftTarget(null);
                      setDraftText("");
                    }}
                  >
                    <input
                      className="input-text"
                      type="text"
                      autoFocus
                      placeholder={zh ? `批注第 ${lineNumber} 行...` : `Comment on line ${lineNumber}...`}
                      value={draftText}
                      onChange={(event) => setDraftText(event.target.value)}
                    />
                    <button className="btn" type="submit" disabled={!draftText.trim()}>
                      {zh ? "添加" : "Add"}
                    </button>
                    <button className="btn" type="button" onClick={() => setDraftTarget(null)}>
                      {zh ? "取消" : "Cancel"}
                    </button>
                  </form>
                )}
              </Fragment>;
            })}
          </div>;
        })}
      </div>) : <pre className="review-raw-diff">{diff || (zh ? "没有文本差异" : "No textual differences")}</pre>}
    </div>
  </div>;
}
