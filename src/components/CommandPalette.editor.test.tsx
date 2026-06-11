/**
 * Behavioral tests for the Command Palette "Editor" group:
 * the five entries render with the current pref state in their labels
 * and dispatch editorPrefsStore actions on select (closing the palette).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useEditorPrefs } from "../stores/editorPrefsStore";
import { useBlameStore } from "../stores/blameStore";

vi.mock("../lib/ipc", () => ({
  ipc: {
    listModels: vi.fn().mockResolvedValue([]),
    listTemplates: vi.fn().mockResolvedValue([]),
  },
}));

import { CommandPalette } from "./CommandPalette";

// cmdk observes item sizes; JSDOM has no ResizeObserver.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", {
  writable: true,
  configurable: true,
  value: ResizeObserverMock,
});

// cmdk scrolls the selected item into view; JSDOM has no scrollIntoView.
const originalScrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = vi.fn();
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

function resetPrefs() {
  useEditorPrefs.setState({ wrap: false, fontSize: 13, tabWidth: 2, lineNumbers: true });
  useBlameStore.setState({ enabled: false, linesByPath: {}, errorByPath: {} });
}

async function renderPalette(onClose = vi.fn()) {
  await act(async () => {
    render(
      <CommandPalette
        open
        onClose={onClose}
        onNewSession={vi.fn()}
        onToggleTokens={vi.fn()}
      />,
    );
  });
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPrefs();
});

describe("CommandPalette · Editor group", () => {
  it("renders the group with all five entries showing current state", async () => {
    await renderPalette();
    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.getByText("Toggle word wrap — off")).toBeInTheDocument();
    expect(screen.getByText("Increase font size")).toBeInTheDocument();
    expect(screen.getByText("Decrease font size")).toBeInTheDocument();
    expect(screen.getByText("Cycle tab width — 2 spaces")).toBeInTheDocument();
    expect(screen.getByText("Toggle line numbers — on")).toBeInTheDocument();
    expect(screen.getByText("Toggle blame — off")).toBeInTheDocument();
  });

  it("toggle blame flips the blame store and closes the palette", async () => {
    const onClose = await renderPalette();
    fireEvent.click(screen.getByText("Toggle blame — off"));
    expect(useBlameStore.getState().enabled).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it("labels react to the store", async () => {
    await renderPalette();
    act(() => useEditorPrefs.setState({ wrap: true, lineNumbers: false, tabWidth: 8 }));
    expect(screen.getByText("Toggle word wrap — on")).toBeInTheDocument();
    expect(screen.getByText("Toggle line numbers — off")).toBeInTheDocument();
    expect(screen.getByText("Cycle tab width — 8 spaces")).toBeInTheDocument();
  });

  it("toggle word wrap dispatches and closes the palette", async () => {
    const onClose = await renderPalette();
    fireEvent.click(screen.getByText("Toggle word wrap — off"));
    expect(useEditorPrefs.getState().wrap).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("increase / decrease font size bump the store", async () => {
    await renderPalette();
    fireEvent.click(screen.getByText("Increase font size"));
    expect(useEditorPrefs.getState().fontSize).toBe(14);
  });

  it("decrease font size bumps the store down", async () => {
    await renderPalette();
    fireEvent.click(screen.getByText("Decrease font size"));
    expect(useEditorPrefs.getState().fontSize).toBe(12);
  });

  it("cycle tab width advances 2 → 4", async () => {
    await renderPalette();
    fireEvent.click(screen.getByText("Cycle tab width — 2 spaces"));
    expect(useEditorPrefs.getState().tabWidth).toBe(4);
  });

  it("toggle line numbers dispatches", async () => {
    await renderPalette();
    fireEvent.click(screen.getByText("Toggle line numbers — on"));
    expect(useEditorPrefs.getState().lineNumbers).toBe(false);
  });
});
