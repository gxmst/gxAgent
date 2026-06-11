import { useState } from 'react';
import { Pencil, Save, Send, X } from 'lucide-react';

interface EditableMessageProps {
  content: string;
  onSave: (newContent: string) => void;
  onSaveAndResend: (newContent: string) => void;
  onCancel: () => void;
}

export function EditableMessage({ content, onSave, onSaveAndResend, onCancel }: EditableMessageProps) {
  const [text, setText] = useState(content);

  return (
    <div className="editable-message">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="edit-textarea"
        autoFocus
      />
      <div className="edit-actions">
        <button onClick={onCancel} className="btn-secondary">
          <X size={16} /> 取消
        </button>
        <button onClick={() => onSave(text)} className="btn-secondary">
          <Save size={16} /> 保存
        </button>
        <button onClick={() => onSaveAndResend(text)} className="btn-primary">
          <Send size={16} /> 保存并发送
        </button>
      </div>
    </div>
  );
}

interface MessageActionsProps {
  onEdit: () => void;
  onCopy: () => void;
}

export function MessageActions({ onEdit, onCopy }: MessageActionsProps) {
  return (
    <div className="message-actions">
      <button onClick={onEdit} title="编辑">
        <Pencil size={14} />
      </button>
      <button onClick={onCopy} title="复制">
        <Pencil size={14} />
      </button>
    </div>
  );
}
