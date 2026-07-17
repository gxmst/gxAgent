import * as Diff from "diff";

/**
 * Renders a line-by-line diff between two strings, colouring added and removed
 * lines. Purely presentational — the caller owns the before/after content.
 */
export function DiffView({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const changes = Diff.diffLines(oldContent, newContent);
  return (
    <div className="diff-view">
      {changes.map((part, i) => {
        const cls = part.added ? "diff-add" : part.removed ? "diff-remove" : "diff-unchanged";
        return (
          <pre key={i} className={`diff-line ${cls}`}>
            <span className="diff-prefix">{part.added ? "+" : part.removed ? "-" : " "}</span>
            {part.value}
          </pre>
        );
      })}
    </div>
  );
}
