import { Message } from '../../types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

interface MessageItemProps {
  message: Message;
  onRegenerate?: () => void;
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`message-item ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-avatar">
        {isUser ? '👤' : '🤖'}
      </div>
      <div className="message-content">
        <div className="message-text">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ inline, className, children, ...props }: any) {
                const match = /language-(\w+)/.exec(className || '');
                const code = String(children).replace(/\n$/, '');

                return !inline && match ? (
                  <CodeBlock language={match[1]} code={code} />
                ) : (
                  <code className="inline-code" {...props}>
                    {children}
                  </code>
                );
              },
              pre({ children }: any) {
                return <>{children}</>;
              }
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>

        {message.actions && message.actions.length > 0 && (
          <div className="message-tools">
            {message.actions.map(action => (
              <ToolCard key={action.id} action={action} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block">
      <div className="code-header">
        <span className="code-language">{language}</span>
        <button className="copy-button" onClick={handleCopy}>
          {copied ? '✓ 已复制' : <><Copy size={14} /> 复制</>}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: '0 0 var(--radius-md) var(--radius-md)',
          fontSize: '13px'
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function ToolCard({ action }: { action: any }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="tool-card">
      <div className="tool-header" onClick={() => setExpanded(!expanded)}>
        <div className="tool-info">
          <span className="tool-name">{action.name}</span>
          <span className={`tool-status status-${action.status}`}>
            {action.status}
          </span>
        </div>
        {action.output && (
          expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />
        )}
      </div>
      {expanded && action.output && (
        <div className="tool-output">
          <pre>{action.output}</pre>
        </div>
      )}
    </div>
  );
}
