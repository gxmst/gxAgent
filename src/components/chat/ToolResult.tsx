import type { ToolAction } from "../../types";
import { DiffView } from "../shared/DiffView";
import SyntaxHighlight from "../markdown/SyntaxHighlight";

const MAX_RENDERED_OUTPUT = 20_000;

function parseArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(argumentsJson || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
function textValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function boundedText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_RENDERED_OUTPUT) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, MAX_RENDERED_OUTPUT)}\n\n[Output truncated in the UI]`,
    truncated: true,
  };
}

function languageForPath(path: string): string {
  const extension = path.split(/[\\/.]/).pop()?.toLowerCase() || "";
  const languages: Record<string, string> = {
    c: "c",
    cpp: "cpp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "markup",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    ps1: "powershell",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    toml: "ini",
    ts: "typescript",
    tsx: "tsx",
    vue: "markup",
    xml: "markup",
    yaml: "yaml",
    yml: "yaml",
  };
  return languages[extension] || "text";
}

function OutputBlock({ output, className = "" }: { output: string; className?: string }) {
  const bounded = boundedText(output);
  return (
    <pre className={`tool-output ${className}`.trim()}>
      <code>{bounded.text}</code>
    </pre>
  );
}

function FileReadResult({ path, output }: { path: string; output: string }) {
  const bounded = boundedText(output);
  return (
    <details className="tool-result-details" open>
      <summary>{path || "file"}</summary>
      <SyntaxHighlight code={bounded.text} codeLang={languageForPath(path)} />
    </details>
  );
}

function CommandResult({ command, output }: { command: string; output: string }) {
  const sections = output.split(/\n(?=Stdout:|Stderr:)/g);
  return (
    <div className="tool-terminal-output">
      {command && <div className="tool-terminal-command"><span>PS&gt;</span> {command}</div>}
      {sections.map((section, index) => {
        const isStderr = section.startsWith("Stderr:");
        const isStdout = section.startsWith("Stdout:");
        return (
          <pre key={`${section.slice(0, 16)}-${index}`} className={`tool-output ${isStderr ? "tool-stderr" : isStdout ? "tool-stdout" : ""}`}>
            <code>{boundedText(section).text}</code>
          </pre>
        );
      })}
    </div>
  );
}

export function ToolResult({ action }: { action: ToolAction }) {
  const output = action.output || "";
  if (!output) return null;
  const args = parseArguments(action.arguments);

  if (action.name === "read_file") {
    return <FileReadResult path={textValue(args.path)} output={output} />;
  }

  if (action.name === "edit_file") {
    const oldContent = textValue(args.old_string);
    const newContent = textValue(args.new_string);
    if (oldContent || newContent) {
      return (
        <details className="tool-result-details" open>
          <summary>{textValue(args.path) || "edit"}</summary>
          <DiffView oldContent={boundedText(oldContent).text} newContent={boundedText(newContent).text} />
        </details>
      );
    }
  }

  if (action.name === "write_file") {
    const content = textValue(args.content);
    if (content) {
      return (
        <details className="tool-result-details" open>
          <summary>{textValue(args.path) || "new file"}</summary>
          <DiffView oldContent="" newContent={boundedText(content).text} />
        </details>
      );
    }
  }

  if (action.name === "execute_command") {
    return <CommandResult command={textValue(args.command)} output={output} />;
  }

  if (action.name === "grep" || action.name === "glob") {
    return (
      <details className="tool-result-details" open>
        <summary>{action.name}</summary>
        <OutputBlock output={output} />
      </details>
    );
  }

  return <OutputBlock output={output} />;
}
