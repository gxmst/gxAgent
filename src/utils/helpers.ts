// Simple token counter (approximation: ~4 chars per token)
export function countTokens(text: string): number {
  if (!text) return 0;
  // Simple approximation: 1 token ≈ 4 characters
  return Math.ceil(text.length / 4);
}

// Format session to Markdown
export function sessionToMarkdown(title: string, messages: any[]): string {
  let md = `# ${title}\n\n`;

  messages.forEach((msg) => {
    const role = msg.role === 'user' ? '👤 用户' : '🤖 助手';
    md += `## ${role}\n\n${msg.content}\n\n`;

    if (msg.actions && msg.actions.length > 0) {
      md += `### 工具调用\n\n`;
      msg.actions.forEach((action: any) => {
        md += `- **${action.name}** (${action.status})\n`;
        if (action.output) {
          md += `\`\`\`\n${action.output}\n\`\`\`\n\n`;
        }
      });
    }

    md += '---\n\n';
  });

  return md;
}

// Check if string is valid JSON
export function isValidJSON(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

// Format JSON with syntax highlighting
export function formatJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

// Generate title from first message
export function generateTitle(firstMessage: string): string {
  const cleaned = firstMessage.trim().replace(/\n/g, ' ');
  if (cleaned.length <= 30) return cleaned;
  return cleaned.substring(0, 27) + '...';
}

// Parse slash commands
export function parseCommand(input: string): { isCommand: boolean; command?: string; args?: string } {
  if (!input.startsWith('/')) return { isCommand: false };

  const parts = input.substring(1).split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  return { isCommand: true, command, args };
}
