import type { ChatSession } from '../types';

// 会话导入导出工具函数
export function exportAllSessions(sessions: ChatSession[]): void {
  const data = JSON.stringify(sessions, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gxAgent-sessions-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importSessions(file: File): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const sessions = JSON.parse(e.target?.result as string);
        if (!Array.isArray(sessions)) {
          reject(new Error('Session export must be an array'));
          return;
        }
        resolve(sessions);
      } catch (err) {
        reject(new Error('Invalid JSON file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// 工具调用统计
export function getToolStats(sessions: any[]): Record<string, number> {
  const stats: Record<string, number> = {};

  sessions.forEach(session => {
    session.messages?.forEach((msg: any) => {
      msg.actions?.forEach((action: any) => {
        const name = action.name || 'unknown';
        stats[name] = (stats[name] || 0) + 1;
      });
    });
  });

  return stats;
}
