import { useEffect, useRef } from 'react';
import { Message } from '../../types';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: Message[];
  onRegenerate?: () => void;
}

export function MessageList({ messages, onRegenerate }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="message-list-empty">
        <div className="empty-state">
          <div className="empty-icon">💬</div>
          <h3>开始对话</h3>
          <p>发送消息来开始与 AI 助手对话</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list">
      {messages.map((msg, idx) => (
        <MessageItem key={idx} message={msg} onRegenerate={onRegenerate} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
