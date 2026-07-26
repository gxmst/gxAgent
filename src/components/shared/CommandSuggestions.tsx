import { useEffect, useRef } from 'react';

interface CommandSuggestion {
  command: string;
  description: Record<'zh' | 'en', string>;
}

const COMMANDS: CommandSuggestion[] = [
  { command: '/clear', description: { zh: '插入上下文分隔符，开始新话题', en: 'Start a new context without deleting history' } },
  { command: '/compact', description: { zh: '压缩对话历史，节省 token', en: 'Summarize older context to save tokens' } },
  { command: '/export', description: { zh: '导出当前会话为 Markdown 文件', en: 'Export this session as Markdown' } },
  { command: '/help', description: { zh: '显示所有可用命令', en: 'Show available slash commands' } },
];

interface CommandSuggestionsProps {
  input: string;
  onSelect: (command: string) => void;
  lang?: string;
}

export function CommandSuggestions({ input, onSelect, lang = 'zh' }: CommandSuggestionsProps) {
  if (!input.startsWith('/')) return null;

  const query = input.toLowerCase();
  const filtered = COMMANDS.filter(c => c.command.startsWith(query));

  if (filtered.length === 0) return null;

  return (
    <div className="command-suggestions" role="listbox" aria-label={lang === 'zh' ? '快捷命令' : 'Slash commands'}>
      {filtered.map(cmd => (
        <button
          type="button"
          key={cmd.command}
          className="command-item"
          role="option"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(cmd.command)}
        >
          <span className="command-name">{cmd.command}</span>
          <span className="command-desc">{cmd.description[lang === 'zh' ? 'zh' : 'en']}</span>
        </button>
      ))}
    </div>
  );
}

export function useGlobalHotkeys(onNewSession: () => void) {
  const callbackRef = useRef(onNewSession);
  callbackRef.current = onNewSession;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd + K: New session
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        callbackRef.current();
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);
}
