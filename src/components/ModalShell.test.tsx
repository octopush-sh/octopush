import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { ModalShell } from "./ModalShell";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open it
      </button>
      {open && (
        <ModalShell onClose={() => setOpen(false)} ariaLabel="Test dialog">
          <div>
            <button type="button">first inside</button>
            <button type="button">last inside</button>
          </div>
        </ModalShell>
      )}
    </>
  );
}

describe("ModalShell focus management", () => {
  it("focuses the dialog on mount and restores the opener on unmount", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "open it" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Test dialog" });
    expect(document.activeElement).toBe(dialog);

    // Escape closes (existing behavior) and focus returns to the trigger.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not steal focus from an autoFocus child, and still restores the opener", () => {
    function AutoFocusHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open it
          </button>
          {open && (
            <ModalShell onClose={() => setOpen(false)} ariaLabel="AF dialog">
              <input autoFocus data-testid="af" />
            </ModalShell>
          )}
        </>
      );
    }
    render(<AutoFocusHarness />);
    const trigger = screen.getByRole("button", { name: "open it" });
    trigger.focus();
    fireEvent.click(trigger);

    // The child's autoFocus wins — the shell must not yank focus to itself.
    expect(document.activeElement).toBe(screen.getByTestId("af"));

    // And the recorded opener is the trigger (not the dialog's own input):
    // closing hands focus back to it.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("traps Tab within the dialog", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    const dialog = screen.getByRole("dialog", { name: "Test dialog" });
    const first = screen.getByRole("button", { name: "first inside" });
    const last = screen.getByRole("button", { name: "last inside" });

    // Tab from the last focusable cycles to the first.
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // Shift+Tab from the first cycles back to the last.
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("Tab from the dialog container itself lands on the first focusable", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    const dialog = screen.getByRole("dialog", { name: "Test dialog" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "first inside" }),
    );
  });

  it("Escape closes only the topmost of stacked modals", () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    function StackedHarness() {
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <ModalShell onClose={outerClose} ariaLabel="Outer dialog">
          <div>
            <button type="button" onClick={() => setInnerOpen(true)}>
              open inner
            </button>
            {innerOpen && (
              <ModalShell
                onClose={() => {
                  innerClose();
                  setInnerOpen(false);
                }}
                ariaLabel="Inner dialog"
              >
                <div>inner content</div>
              </ModalShell>
            )}
          </div>
        </ModalShell>
      );
    }
    render(<StackedHarness />);
    fireEvent.click(screen.getByRole("button", { name: "open inner" }));
    expect(screen.getByRole("dialog", { name: "Inner dialog" })).toBeInTheDocument();

    // First Escape: only the inner (topmost) modal closes.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Inner dialog" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Outer dialog" })).toBeInTheDocument();

    // Second Escape: now the outer modal is topmost and closes.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(outerClose).toHaveBeenCalledTimes(1);
    expect(innerClose).toHaveBeenCalledTimes(1);
  });

  it("does not break backdrop click-to-close", () => {
    const onClose = vi.fn();
    render(
      <ModalShell onClose={onClose} ariaLabel="Backdrop test">
        <div>content</div>
      </ModalShell>,
    );
    fireEvent.click(screen.getByRole("dialog", { name: "Backdrop test" }));
    expect(onClose).toHaveBeenCalled();
  });
});
