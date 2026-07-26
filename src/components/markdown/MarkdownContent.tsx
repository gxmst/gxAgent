import { lazy, memo, Suspense } from "react";

export interface MarkdownContentProps {
  content: string;
  lang: string;
}

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

/**
 * Keeps the Markdown toolchain out of the initial application bundle. The
 * escaped plain-text fallback also prevents a message from disappearing while
 * the renderer chunk is fetched for the first time.
 */
export const MarkdownContent = memo(function MarkdownContent({ content, lang }: MarkdownContentProps) {
  return (
    <Suspense
      fallback={(
        <div aria-busy="true" style={{ whiteSpace: "pre-wrap" }}>
          {content}
        </div>
      )}
    >
      <MarkdownRenderer content={content} lang={lang} />
    </Suspense>
  );
});
