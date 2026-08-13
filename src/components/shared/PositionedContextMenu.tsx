import { type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";

/**
 * Positions a context menu near (x, y) but flips/clamps so it never gets
 * clipped by the viewport edges. Measures its own rendered size first.
 */
export function PositionedContextMenu({
  x,
  y,
  className,
  children,
  onClose,
}: {
  x: number;
  y: number;
  className?: string;
  children: ReactNode;
  onClose?: () => void;
}) {
  return (
    <DropdownMenu.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
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
          className={className}
          sideOffset={4}
          collisionPadding={8}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
