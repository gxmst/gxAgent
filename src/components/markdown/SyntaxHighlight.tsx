import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

export default function SyntaxHighlight({ code, codeLang }: { code: string; codeLang: string }) {
  return (
    <SyntaxHighlighter
      language={codeLang}
      style={oneDark}
      customStyle={{ margin: 0, borderRadius: "0 0 6px 6px", fontSize: "0.78rem", padding: "10px 12px" }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
