import { ChatSession } from '../../types';
import { Plus, MessageSquare, Pin, Trash2 } from 'lucide-react';

interface SidebarProps {
  sessions: ChatSession[];
  currentSessionId: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onPinSession?: (id: string) => void;
}

export function Sidebar({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession
}: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="new-chat-btn" onClick={onNewSession}>
          <Plus size={18} />
          <span>新对话</span>
        </button>
      </div>

      <div className="session-list">
        {sessions.map(session => (
          <div
            key={session.id}
            className={`session-item ${session.id === currentSessionId ? 'active' : ''}`}
            onClick={() => onSelectSession(session.id)}
          >
            <MessageSquare size={16} />
            <span className="session-title">{session.title || '新对话'}</span>
            <div className="session-actions">
              {session.pinned && <Pin size={14} />}
              <button
                className="delete-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSession(session.id);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
