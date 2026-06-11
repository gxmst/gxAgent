import { useEffect, useState } from 'react';
import { Download, Upload, Trash, BarChart3, Settings as SettingsIcon } from 'lucide-react';

interface ContextMenuProps {
  x: number;
  y: number;
  labels: {
    exportAll: string;
    importSessions: string;
    toolStats: string;
    settings: string;
    clearAll: string;
  };
  onClose: () => void;
  onExport: () => void;
  onImport: () => void;
  onClearAll: () => void;
  onShowStats: () => void;
  onSettings: () => void;
}

export function ContextMenu({ x, y, labels, onClose, onExport, onImport, onClearAll, onShowStats, onSettings }: ContextMenuProps) {
  useEffect(() => {
    const handleClick = () => onClose();
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [onClose]);

  return (
    <div className="context-menu" style={{ left: x, top: y }}>
      <button onClick={onExport}>
        <Download size={14} /> {labels.exportAll}
      </button>
      <button onClick={onImport}>
        <Upload size={14} /> {labels.importSessions}
      </button>
      <div className="context-menu-divider" />
      <button onClick={onShowStats}>
        <BarChart3 size={14} /> {labels.toolStats}
      </button>
      <button onClick={onSettings}>
        <SettingsIcon size={14} /> {labels.settings}
      </button>
      <div className="context-menu-divider" />
      <button onClick={onClearAll} className="danger">
        <Trash size={14} /> {labels.clearAll}
      </button>
    </div>
  );
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const closeMenu = () => setMenu(null);

  return { menu, handleContextMenu, closeMenu };
}
