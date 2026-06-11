import { useEffect } from 'react';

interface CommandSuggestion {
  command: string;
  description: string;
}

const COMMANDS: CommandSuggestion[] = [
  { command: '/clear', description: '插入上下文分隔符，开始新话题' },
  { command: '/compact', description: '压缩对话历史，节省 token' },
  { command: '/export', description: '导出当前会话为 Markdown 文件' },
  { command: '/help', description: '显示所有可用命令' },
];

interface CommandSuggestionsProps {
  input: string;
  onSelect: (command: string) => void;
}

export function CommandSuggestions({ input, onSelect }: CommandSuggestionsProps) {
  if (!input.startsWith('/')) return null;

  const query = input.toLowerCase();
  const filtered = COMMANDS.filter(c => c.command.startsWith(query));

  if (filtered.length === 0) return null;

  return (
    <div className="command-suggestions">
      {filtered.map(cmd => (
        <div
          key={cmd.command}
          className="command-item"
          onClick={() => onSelect(cmd.command)}
        >
          <span className="command-name">{cmd.command}</span>
          <span className="command-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}

export function useGlobalHotkeys(onNewSession: () => void) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd + K: New session
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        onNewSession();
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onNewSession]);
}
