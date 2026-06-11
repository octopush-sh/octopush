import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpenFile } from "../stores/editorStore";

// ─── Mock the editorStore ─────────────────────────────────────────

const mockFiles: OpenFile[] = [
  { path: "/repo/foo.ts", content: "abc", savedContent: "abc", lang: "javascript", kind: "text", mtime: 0, size: 0, version: 0, diskStale: false },
  { path: "/repo/bar.ts", content: "edited", savedContent: "original", lang: "javascript", kind: "text", mtime: 0, size: 0, version: 0, diskStale: false },
];

const mockSetActive = vi.fn();
const mockCloseFile = vi.fn();
const mockReorderFiles = vi.fn();

vi.mock("../stores/editorStore", () => ({
  useEditorStore: vi.fn((selector: (s: unknown) => unknown) => {
    const state = {
      getFiles: (wsId: string) => (wsId === "ws-1" ? mockFiles : []),
      getActivePath: (wsId: string) => (wsId === "ws-1" ? "/repo/foo.ts" : null),
      isDirty: (_wsId: string, path: string) => path === "/repo/bar.ts",
      setActive: mockSetActive,
      closeFile: mockCloseFile,
      reorderFiles: mockReorderFiles,
    };
    return selector(state);
  }),
}));

import { EditorTabs } from "./EditorTabs";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EditorTabs", () => {
  it("renders a tab for each open file using the filename only", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    expect(screen.getByText("foo.ts")).toBeInTheDocument();
    expect(screen.getByText("bar.ts")).toBeInTheDocument();
  });

  it("shows dirty dot (●) on modified files", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    // bar.ts is dirty — should show ●
    expect(screen.getByTestId("dirty-dot-/repo/bar.ts")).toBeInTheDocument();
    // foo.ts is clean — should NOT show ●
    expect(screen.queryByTestId("dirty-dot-/repo/foo.ts")).not.toBeInTheDocument();
  });

  it("clicking a tab calls setActive with the path", async () => {
    render(<EditorTabs workspaceId="ws-1" />);
    await userEvent.click(screen.getByText("bar.ts"));
    expect(mockSetActive).toHaveBeenCalledWith("ws-1", "/repo/bar.ts");
  });

  it("clicking × calls closeFile with the path", async () => {
    render(<EditorTabs workspaceId="ws-1" />);
    // Get the close buttons by test id
    const closeBtn = screen.getByTestId("close-tab-/repo/foo.ts");
    await userEvent.click(closeBtn);
    expect(mockCloseFile).toHaveBeenCalledWith("ws-1", "/repo/foo.ts");
  });

  it("renders nothing when no files are open", () => {
    render(<EditorTabs workspaceId="ws-empty" />);
    expect(screen.queryByTestId(/^tab-/)).not.toBeInTheDocument();
  });

  it("exposes the tablist/tab roles with aria-selected on the active tab", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    const active = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(active).toBeTruthy();
    expect(active).toHaveTextContent("foo.ts");
  });

  it("shows the full path as a tooltip on each tab (truncation aid)", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    expect(screen.getByTestId("tab-/repo/foo.ts")).toHaveAttribute("title", "/repo/foo.ts");
    expect(screen.getByTestId("tab-/repo/bar.ts")).toHaveAttribute("title", "/repo/bar.ts");
  });
});

describe("EditorTabs — keyboard navigation (roving tabindex)", () => {
  it("uses roving tabindex: active tab is 0, the rest are -1", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    const [foo, bar] = screen.getAllByRole("tab");
    expect(foo).toHaveAttribute("tabindex", "0");   // active
    expect(bar).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowRight / ArrowLeft move focus between tabs without activating them", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    const [foo, bar] = screen.getAllByRole("tab");
    foo.focus();

    fireEvent.keyDown(foo, { key: "ArrowRight" });
    expect(document.activeElement).toBe(bar);
    expect(mockSetActive).not.toHaveBeenCalled();

    fireEvent.keyDown(bar, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(foo);
    expect(mockSetActive).not.toHaveBeenCalled();
  });

  it("focus stops at the edges (no wrap)", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    const [foo, bar] = screen.getAllByRole("tab");

    foo.focus();
    fireEvent.keyDown(foo, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(foo);

    bar.focus();
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(bar);
  });

  it("Home / End jump to the first / last tab", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    const [foo, bar] = screen.getAllByRole("tab");

    foo.focus();
    fireEvent.keyDown(foo, { key: "End" });
    expect(document.activeElement).toBe(bar);

    fireEvent.keyDown(bar, { key: "Home" });
    expect(document.activeElement).toBe(foo);
  });

  it("Enter and Space activate the focused tab", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    const [, bar] = screen.getAllByRole("tab");

    bar.focus();
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(mockSetActive).toHaveBeenCalledWith("ws-1", "/repo/bar.ts");

    mockSetActive.mockClear();
    fireEvent.keyDown(bar, { key: " " });
    expect(mockSetActive).toHaveBeenCalledWith("ws-1", "/repo/bar.ts");
  });
});

describe("EditorTabs — drag to reorder", () => {
  it("dropping a dragged tab onto another calls reorderFiles(from, to)", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    const [foo, bar] = screen.getAllByRole("tab");

    fireEvent.dragStart(foo);
    fireEvent.dragOver(bar);
    fireEvent.drop(bar);

    expect(mockReorderFiles).toHaveBeenCalledWith("ws-1", 0, 1);
  });

  it("marks tabs draggable and shows a quiet cue on the dragged tab", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    const [foo] = screen.getAllByRole("tab");
    expect(foo).toHaveAttribute("draggable", "true");

    fireEvent.dragStart(foo);
    expect(foo.className).toContain("opacity-60");

    fireEvent.dragEnd(foo);
    expect(foo.className).not.toContain("opacity-60");
  });

  it("dropping a tab onto itself does not reorder", () => {
    render(<EditorTabs workspaceId="ws-1" />);
    const [foo] = screen.getAllByRole("tab");

    fireEvent.dragStart(foo);
    fireEvent.dragOver(foo);
    fireEvent.drop(foo);

    expect(mockReorderFiles).not.toHaveBeenCalled();
  });
});
