import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfirmationOptions } from "../components/shared/ConfirmDialog";

/**
 * Promise-based confirmation dialog state with safe overlapping-request
 * settlement and focus restoration on close.
 */
export function useConfirmation() {
  const [confirmation, setConfirmation] = useState<ConfirmationOptions | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const settleConfirmation = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    setConfirmation(null);
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    requestAnimationFrame(() => returnFocus?.focus());
  }, []);

  const requestConfirmation = useCallback((options: ConfirmationOptions) => {
    resolverRef.current?.(false);
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setConfirmation(options);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  useEffect(() => () => {
    resolverRef.current?.(false);
    resolverRef.current = null;
  }, []);

  return { confirmation, requestConfirmation, settleConfirmation };
}
