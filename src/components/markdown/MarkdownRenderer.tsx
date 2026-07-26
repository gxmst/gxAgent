import { lazy, Suspense } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import CodeBlock from "./CodeBlock";
import { repairMalformedGfmTables } from "./markdownPreprocess";
import type { MarkdownContentProps } from "./MarkdownContent";

const MermaidDiagram = lazy(() => import("./MermaidDiagram"));

export default function MarkdownRenderer({ content, lang }: MarkdownContentProps) {
  const renderContent = repairMalformedGfmTables(content);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        table({ children, ...props }) {
          return (
            <div className="markdown-table-scroll" tabIndex={0}>
              <table {...props}>{children}</table>
            </div>
          );
        },
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const isBlock = (className || "").includes("language-");
          const code = String(children).replace(/\n$/, "");

          if (isBlock) {
            const codeLang = match ? match[1] : "text";
            if (codeLang === "mermaid") {
              return (
                <Suspense fallback={<code className={className}>{children}</code>}>
                  <MermaidDiagram chart={code} />
                </Suspense>
              );
            }
            return <CodeBlock code={code} codeLang={codeLang} lang={lang} />;
          }

          return <code className={className} {...props}>{children}</code>;
        },
      }}
    >
      {renderContent}
    </ReactMarkdown>
  );
}
