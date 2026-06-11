import { Download, Copy } from 'lucide-react';
import { sessionToMarkdown } from '../../utils/helpers';

interface SessionActionsProps {
  sessionTitle: string;
  messages: any[];
  onShowToast?: (message: string) => void;
}

export function SessionActions({ sessionTitle, messages, onShowToast }: SessionActionsProps) {
  const handleCopySession = () => {
    const md = sessionToMarkdown(sessionTitle, messages);
    navigator.clipboard.writeText(md);
    onShowToast?.('已复制到剪贴板');
  };

  const handleExportSession = () => {
    const md = sessionToMarkdown(sessionTitle, messages);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sessionTitle}.md`;
    a.click();
    URL.revokeObjectURL(url);
    onShowToast?.('已导出');
  };

  return (
    <div className="session-actions">
      <button onClick={handleCopySession} title="复制对话">
        <Copy size={16} />
      </button>
      <button onClick={handleExportSession} title="导出为 Markdown">
        <Download size={16} />
      </button>
    </div>
  );
}
