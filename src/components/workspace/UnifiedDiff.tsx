import { useMemo, useState } from "react";
import { parsePatch } from "diff";
import { Copy, WrapText } from "lucide-react";
import { notify } from "../../services/agentEvents";

export function UnifiedDiff({ diff, lang, label }: { diff: string; lang: string; label?: string }) {
  const [wrap, setWrap] = useState(true);
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
              return <div className={`review-diff-line ${kind}`} key={index}>
                <span className="diff-line-number" aria-hidden="true">{before}</span><span className="diff-line-number" aria-hidden="true">{after}</span>
                <code>{line || " "}</code>
              </div>;
            })}
          </div>;
        })}
      </div>) : <pre className="review-raw-diff">{diff || (zh ? "没有文本差异" : "No textual differences")}</pre>}
    </div>
  </div>;
}
