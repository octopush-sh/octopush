import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ElsewhereModal } from "./ElsewhereModal";
import type { Issue } from "../lib/types";

vi.mock("../lib/ipc", () => ({
  ipc: { openFileInSystem: vi.fn() },
}));

import { ipc } from "../lib/ipc";
const openFileInSystemMock = vi.mocked(ipc.openFileInSystem);

beforeEach(() => {
  vi.clearAllMocks();
  openFileInSystemMock.mockResolvedValue(undefined);
});

const issues: Issue[] = [
  { key: "A-1", summary: "a one", statusName: "In Progress", statusCategory: "inProgress", issueType: "Story", priority: null, url: "https://x/A-1", parentKey: null },
  { key: "A-2", summary: "a two", statusName: "To Do",       statusCategory: "todo",       issueType: "Bug",   priority: null, url: "https://x/A-2", parentKey: null },
  { key: "B-1", summary: "b one", statusName: "In Progress", statusCategory: "inProgress", issueType: "Story", priority: null, url: "https://x/B-1", parentKey: null },
];

describe("ElsewhereModal", () => {
  it("groups by project prefix and excludes the active project", () => {
    render(
      <ElsewhereModal issues={issues} activeProjectKey="HERE" onClose={vi.fn()} />,
    );
    // Both A-* and B-* are 'elsewhere' (active project is HERE).
    expect(screen.getByText(/^A$/)).toBeInTheDocument();
    expect(screen.getByText(/^B$/)).toBeInTheDocument();
    expect(screen.getByText("A-1")).toBeInTheDocument();
    expect(screen.getByText("B-1")).toBeInTheDocument();
  });

  it("clicking a row opens the issue url", () => {
    render(
      <ElsewhereModal issues={issues} activeProjectKey="HERE" onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("A-1").closest("button")!);
    expect(openFileInSystemMock).toHaveBeenCalledWith("https://x/A-1");
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    render(<ElsewhereModal issues={issues} activeProjectKey="HERE" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
