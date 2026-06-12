import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>({
    left: x,
    top: y,
    visible: false,
  });

  useEffect(() => {
    const handleClick = () => onClose();
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [onClose]);

  // Measure the rendered menu and flip/clamp it so it never gets clipped.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x;
    let top = y;

    if (left + w + margin > vw) left = Math.max(margin, x - w);
    left = Math.max(margin, Math.min(left, vw - w - margin));

    if (top + h + margin > vh) top = Math.max(margin, y - h);
    top = Math.max(margin, Math.min(top, vh - h - margin));

    setPos({ left, top, visible: true });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        left: pos.left,
        top: pos.top,
        visibility: pos.visible ? 'visible' : 'hidden',
        maxHeight: 'calc(100vh - 16px)',
        overflowY: 'auto',
      }}
    >
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
