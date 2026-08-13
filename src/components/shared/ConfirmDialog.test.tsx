// @vitest-environment jsdom
/**
 * Behavioral contract for the Radix-backed ConfirmDialog.
 *
 * These assertions cover exactly what the hand-rolled version implemented by
 * hand (focus trap, Esc, backdrop dismiss, ARIA wiring) and what Radix is now
 * responsible for. Types and a passing build cannot catch a regression here —
 * a missing Dialog.Title, for example, only surfaces at runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(cleanup);

const baseProps = {
  title: "Delete session",
  message: "This cannot be undone.",
  confirmLabel: "Delete",
  cancelLabel: "Cancel",
};

function setup(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ConfirmDialog {...baseProps} onConfirm={onConfirm} onCancel={onCancel} {...overrides} />);
  return { onConfirm, onCancel, user: userEvent.setup() };
}

describe("ConfirmDialog", () => {
  it("exposes an alertdialog with the title and message wired up for screen readers", () => {
    setup();
    const dialog = screen.getByRole("alertdialog");
    // aria-labelledby / aria-describedby must resolve to real nodes; Radix
    // generates the ids, so assert via the accessible name/description.
    expect(dialog).toHaveAccessibleName("Delete session");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
    expect(within(dialog).getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("autofocuses the confirm button so Enter confirms immediately", async () => {
    const { onConfirm } = setup();
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms and cancels through the action buttons", async () => {
    const { onConfirm, onCancel, user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    const cancel = screen.getAllByRole("button", { name: "Cancel" })
      .find((button) => button.textContent?.trim() === "Cancel");
    expect(cancel).toBeDefined();
    await user.click(cancel!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape", async () => {
    const { onCancel, onConfirm } = setup();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("traps focus inside the dialog when tabbing", async () => {
    const { user } = setup();
    const dialog = screen.getByRole("alertdialog");
    // Cycle well past the number of focusable children; focus must never
    // escape to document.body or anything outside the panel.
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("keeps the close button labelled for icon-only rendering", () => {
    setup();
    // Three buttons: close (icon-only), cancel, confirm. The close button has
    // no text, so it must carry an aria-label or it is unreachable by name.
    expect(screen.getAllByRole("button", { name: "Cancel" })
      .some((button) => button.textContent?.trim() === "")).toBe(true);
    const labelled = screen
      .getAllByRole("button")
      .every((button) => (button.textContent ?? "").trim().length > 0 || button.hasAttribute("aria-label"));
    expect(labelled).toBe(true);
  });

  it("marks the confirm action as dangerous when requested", () => {
    setup({ danger: true });
    expect(screen.getByRole("button", { name: "Delete" }).className).toContain("danger");
  });
});
