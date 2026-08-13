import { useEffect, useRef, useState } from 'react';
import { Download, Upload, Trash, BarChart3, Settings as SettingsIcon } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';

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
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocus.current?.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <DropdownMenu.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          style={{ position: "fixed", left: x, top: y, width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="context-menu"
          aria-label={labels.settings}
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current?.focus({ preventScroll: true });
          }}
        >
          <DropdownMenu.Item className="context-menu-item" onSelect={onExport}>
            <Download size={14} /> {labels.exportAll}
          </DropdownMenu.Item>
          <DropdownMenu.Item className="context-menu-item" onSelect={onImport}>
            <Upload size={14} /> {labels.importSessions}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="context-menu-divider" />
          <DropdownMenu.Item className="context-menu-item" onSelect={onShowStats}>
            <BarChart3 size={14} /> {labels.toolStats}
          </DropdownMenu.Item>
          <DropdownMenu.Item className="context-menu-item" onSelect={onSettings}>
            <SettingsIcon size={14} /> {labels.settings}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="context-menu-divider" />
          <DropdownMenu.Item className="context-menu-item context-menu-item-danger" onSelect={onClearAll}>
            <Trash size={14} /> {labels.clearAll}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
