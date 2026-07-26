import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Positions a context menu near (x, y) but flips/clamps so it never gets
 * clipped by the viewport edges. Measures its own rendered size first.
 */
export function PositionedContextMenu({
  x,
  y,
  className,
  children,
}: {
  x: number;
  y: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>({
    left: x,
    top: y,
    visible: false,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // offsetWidth/Height ignore CSS transforms, so the entry animation's
    // scale() doesn't skew the measurement.
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x;
    let top = y;

    // Horizontal: flip to the left of the cursor if it would overflow right.
    if (left + w + margin > vw) {
      left = Math.max(margin, x - w);
    }
    left = Math.min(left, vw - w - margin);
    left = Math.max(margin, left);

    // Vertical: flip above the cursor if it would overflow the bottom.
    if (top + h + margin > vh) {
      top = Math.max(margin, y - h);
    }
    // If still taller than viewport, pin to top and let it scroll.
    top = Math.min(top, vh - h - margin);
    top = Math.max(margin, top);

    setPos({ left, top, visible: true });
  }, [x, y, children]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        left: pos.left,
        top: pos.top,
        visibility: pos.visible ? "visible" : "hidden",
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
