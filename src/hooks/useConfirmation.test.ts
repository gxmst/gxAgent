// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useConfirmation } from "./useConfirmation";

describe("useConfirmation", () => {
  it("resolves true/false when settled", async () => {
    const { result } = renderHook(() => useConfirmation());

    let resolved: boolean | undefined;
    act(() => {
      void result.current.requestConfirmation({ title: "Confirm", message: "Proceed?", confirmLabel: "Yes", cancelLabel: "No" }).then((value) => {
        resolved = value;
      });
    });

    expect(result.current.confirmation?.title).toBe("Confirm");
    act(() => {
      result.current.settleConfirmation(true);
    });

    await Promise.resolve();
    expect(resolved).toBe(true);
    expect(result.current.confirmation).toBeNull();
  });

  it("cancels an earlier pending confirmation when a new one arrives", async () => {
    const { result } = renderHook(() => useConfirmation());
    let first: boolean | undefined;
    let second: boolean | undefined;

    act(() => {
      void result.current.requestConfirmation({ title: "First", message: "One", confirmLabel: "Yes", cancelLabel: "No" }).then((v) => { first = v; });
    });
    act(() => {
      void result.current.requestConfirmation({ title: "Second", message: "Two", confirmLabel: "Yes", cancelLabel: "No" }).then((v) => { second = v; });
    });

    await Promise.resolve();
    expect(first).toBe(false);
    expect(result.current.confirmation?.title).toBe("Second");

    act(() => {
      result.current.settleConfirmation(false);
    });
    await Promise.resolve();
    expect(second).toBe(false);
  });
});
