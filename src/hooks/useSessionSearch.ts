import { useMemo } from 'react';
import { ChatSession } from '../types';

export function useSessionSearch(sessions: ChatSession[], query: string): ChatSession[] {
  return useMemo(() => {
    if (!query.trim()) return sessions;

    const q = query.toLowerCase();
    return sessions.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.messages.some(m => m.content.toLowerCase().includes(q))
    );
  }, [sessions, query]);
}
