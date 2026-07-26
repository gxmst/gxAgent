import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, Save } from "lucide-react";
import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";

const SyntaxHighlight = lazy(() => import("./SyntaxHighlight"));

interface CodeBlockProps {
  code: string;
  codeLang: string;
  lang: string;
}

function label(key: "copy" | "save", lang: string) {
  if (lang === "zh") {
    return key === "copy" ? "复制代码" : "保存为文件";
  }
  return key === "copy" ? "Copy Code" : "Save to File";
}

// Copy feedback is local so it never causes the app or message list to rerender.
const CodeBlock = memo(function CodeBlock({ code, codeLang, lang }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-lang-label" onClick={doCopy} title={label("copy", lang)}>
          {copied ? (lang === "zh" ? "已复制!" : "Copied!") : codeLang}
        </span>
        <div className="code-block-actions">
          <button className="code-action-btn" title={label("copy", lang)} onClick={doCopy}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          <button
            className="code-action-btn"
            title={label("save", lang)}
            onClick={() => { invoke("save_code_file", { content: code, language: codeLang }); }}
          >
            <Save size={12} />
          </button>
        </div>
      </div>
      <Suspense
        fallback={(
          <pre style={{ margin: 0, borderRadius: "0 0 6px 6px", fontSize: "0.78rem", padding: "10px 12px", overflowX: "auto" }}>
            <code>{code}</code>
          </pre>
        )}
      >
        <SyntaxHighlight code={code} codeLang={codeLang} />
      </Suspense>
    </div>
  );
});

export default CodeBlock;
