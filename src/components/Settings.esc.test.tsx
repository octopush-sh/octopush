/**
 * Escape handling for the Settings overlay. Escape must close Settings AND
 * consume the event (so a maximized macOS window doesn't exit full-screen),
 * while deferring to a ModalShell dialog stacked on top.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  ipc: {
    getSettings: vi.fn().mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} }),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    detectEditors: vi.fn().mockResolvedValue([]),
  },
}));

import { Settings } from "./Settings";
import { ModalShell } from "./ModalShell";

function pressEscape(): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(ev); });
  return ev;
}

beforeEach(() => vi.clearAllMocks());

describe("Settings — Escape", () => {
  it("closes Settings and prevents the default (no full-screen exit)", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<Settings open initialTab="general" onClose={onClose} />);
    });

    const ev = pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does not close Settings while a dialog is stacked on top", async () => {
    const onClose = vi.fn();
    const onDialogClose = vi.fn();
    await act(async () => {
      render(
        <>
          <Settings open initialTab="general" onClose={onClose} />
          <ModalShell onClose={onDialogClose} ariaLabel="Test dialog">
            <div>dialog body</div>
          </ModalShell>
        </>,
      );
    });

    // Sanity: the dialog is mounted.
    expect(screen.getByRole("dialog", { name: "Test dialog" })).toBeInTheDocument();

    pressEscape();
    // The dialog (topmost) closes; Settings underneath stays open.
    expect(onDialogClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does nothing on non-Escape keys", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<Settings open initialTab="general" onClose={onClose} />);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
