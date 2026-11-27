/**
 * The Command Palette "Talk" group (#1153): New conversation, Switch
 * conversation… and Copy conversation as Markdown, each run after the
 * palette closes.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ipc: {
    listModels: vi.fn().mockResolvedValue([]),
    listTemplates: vi.fn().mockResolvedValue([]),
  },
}));

import { CommandPalette } from "./CommandPalette";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { writable: true, configurable: true, value: ResizeObserverMock });
const originalScrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = vi.fn();
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

function open(talk?: { onNew: () => void; onSwitch: () => void; onCopy?: () => void; onFocusApproval?: () => void }) {
  const onClose = vi.fn();
  const view = render(
    <CommandPalette open onClose={onClose} onNewSession={vi.fn()} onToggleTokens={vi.fn()} talk={talk} />,
  );
  return { ...view, onClose };
}

describe("CommandPalette Talk group", () => {
  it("lists the three Talk commands with their shortcuts", () => {
    open({ onNew: vi.fn(), onSwitch: vi.fn(), onCopy: vi.fn() });
    // The palette is portalled to the body.
    const group = document.querySelector('[data-tour="palette-talk"]');
    expect(group).not.toBeNull();
    expect(group).toHaveTextContent("New conversation");
    expect(group).toHaveTextContent("⌘⌥N");
    expect(group).toHaveTextContent("Switch conversation…");
    expect(group).toHaveTextContent("⌘⌥K");
    expect(group).toHaveTextContent("Copy conversation as Markdown");
  });

  it("runs each command after closing", () => {
    const talk = { onNew: vi.fn(), onSwitch: vi.fn(), onCopy: vi.fn() };
    const { onClose } = open(talk);
    fireEvent.click(screen.getByText("New conversation"));
    expect(onClose).toHaveBeenCalled();
    expect(talk.onNew).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Switch conversation…"));
    expect(talk.onSwitch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Copy conversation as Markdown"));
    expect(talk.onCopy).toHaveBeenCalledTimes(1);
  });

  it("offers to focus the waiting approval card only while one waits", () => {
    const onFocusApproval = vi.fn();
    const { onClose, unmount } = open({ onNew: vi.fn(), onSwitch: vi.fn(), onFocusApproval });
    const group = document.querySelector('[data-tour="palette-talk"]');
    expect(group).toHaveTextContent("Focus the waiting approval card");
    expect(group).toHaveTextContent("⌘⌥A");
    fireEvent.click(screen.getByText("Focus the waiting approval card"));
    expect(onClose).toHaveBeenCalled();
    expect(onFocusApproval).toHaveBeenCalledTimes(1);
    unmount();
    open({ onNew: vi.fn(), onSwitch: vi.fn() });
    expect(screen.queryByText("Focus the waiting approval card")).toBeNull();
  });

  it("drops Copy with no conversation, and the group with no workspace", () => {
    const { unmount } = open({ onNew: vi.fn(), onSwitch: vi.fn() });
    expect(document.querySelector('[data-tour="palette-talk"]')).not.toBeNull();
    expect(screen.queryByText("Copy conversation as Markdown")).toBeNull();
    unmount();
    open();
    expect(document.querySelector('[data-tour="palette-talk"]')).toBeNull();
  });
});
