import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpenFile } from "../stores/editorStore";

// ─── Mock the editorStore ─────────────────────────────────────────

const mockFiles: OpenFile[] = [
  { path: "/repo/foo.ts", content: "abc", savedContent: "abc", lang: "javascript" },
  { path: "/repo/bar.ts", content: "edited", savedContent: "original", lang: "javascript" },
];

const mockSetActive = vi.fn();
const mockCloseFile = vi.fn();

vi.mock("../stores/editorStore", () => ({
  useEditorStore: vi.fn((selector: (s: unknown) => unknown) => {
    const state = {
      getFiles: (wsId: string) => (wsId === "ws-1" ? mockFiles : []),
      getActivePath: (wsId: string) => (wsId === "ws-1" ? "/repo/foo.ts" : null),
      isDirty: (_wsId: string, path: string) => path === "/repo/bar.ts",
      setActive: mockSetActive,
      closeFile: mockCloseFile,
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

});
