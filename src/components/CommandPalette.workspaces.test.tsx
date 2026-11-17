/**
 * The Command Palette "Workspaces" group: one row per workspace across every
 * open project, needs-you first, found by name, branch or project, and
 * selected like a rail click.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { Workspace } from "../lib/types";
import type { ProjectGroup } from "./WorkspaceRail";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ipc: {
    listModels: vi.fn().mockResolvedValue([]),
    listTemplates: vi.fn().mockResolvedValue([]),
  },
}));

import { CommandPalette } from "./CommandPalette";
import { useRunsStore } from "../stores/runsStore";

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

const ws = (id: string, projectId: string, name: string, branch: string, lastActive: string): Workspace => ({
  id, projectId, name, task: "", branch, worktreePath: null, setupScript: "", status: "active",
  createdAt: lastActive, lastActive, glyph: null, tint: null, linkedIssueKey: null, fromBranch: null,
});

const projects: ProjectGroup[] = [
  { id: "p1", name: "octopush", workspaces: [ws("w1", "p1", "Palette jump", "pm/issue-770-palette-workspaces", "2026-11-16T10:00:00Z")] },
  { id: "p2", name: "octopush-api", workspaces: [ws("w2", "p2", "Sync since", "pm/issue-772", "2026-11-01T10:00:00Z")] },
];

async function renderPalette(onSelectWorkspace = vi.fn(), onClose = vi.fn(), groups: ProjectGroup[] = projects) {
  await act(async () => {
    render(
      <CommandPalette
        open
        onClose={onClose}
        onNewSession={vi.fn()}
        onToggleTokens={vi.fn()}
        projects={groups}
        runningByWs={{}}
        onSelectWorkspace={onSelectWorkspace}
      />,
    );
  });
  return { onSelectWorkspace, onClose };
}

const rowNames = () =>
  screen.queryAllByTestId("palette-workspace").map((r) => r.querySelector("[title]")?.getAttribute("title"));

describe("CommandPalette · Workspaces group", () => {
  beforeEach(() => {
    useRunsStore.setState({ runsByWs: {}, statusSince: {} });
  });

  it("lists every project's workspaces with a project · branch meta line in a title", async () => {
    await renderPalette();
    expect(document.querySelector('[data-tour="palette-workspaces"]')).not.toBeNull();
    expect(rowNames()).toEqual(["Palette jump", "Sync since"]);
    expect(screen.getByTitle("octopush-api · pm/issue-772")).toBeInTheDocument();
  });

  it("puts a workspace whose crew needs you first, with a titled dot", async () => {
    useRunsStore.setState({
      runsByWs: { w2: [{ id: "r1", status: "paused" }] } as never,
      statusSince: { r1: 1 },
    });
    await renderPalette();
    expect(rowNames()).toEqual(["Sync since", "Palette jump"]);
    expect(screen.getByTestId("palette-workspace-state")).toHaveAttribute("title", "Needs you");
  });

  it("finds a workspace by part of its branch", async () => {
    await renderPalette();
    const input = screen.getByPlaceholderText("Type a command, or search…");
    await act(async () => {
      fireEvent.change(input, { target: { value: "issue-772" } });
    });
    expect(rowNames()).toEqual(["Sync since"]);
  });

  it("switches like a rail click and closes", async () => {
    const { onSelectWorkspace, onClose } = await renderPalette();
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("palette-workspace")[1]);
    });
    expect(onSelectWorkspace).toHaveBeenCalledWith("w2");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps two same-named `main` workspaces in same-named projects apart for the keyboard", async () => {
    // Two checkouts of one repo: both projects are "octopush", both have a
    // `main` workspace on branch `main`. cmdk selects by `value`, so the rows
    // must not share one.
    const twins: ProjectGroup[] = [
      { id: "p1", name: "octopush", workspaces: [ws("m1", "p1", "main", "main", "2026-11-16T10:00:00Z")] },
      { id: "p2", name: "octopush", workspaces: [ws("m2", "p2", "main", "main", "2026-11-15T10:00:00Z")] },
    ];
    const { onSelectWorkspace } = await renderPalette(vi.fn(), vi.fn(), twins);
    const input = screen.getByPlaceholderText("Type a command, or search…");
    const rows = () => screen.getAllByTestId("palette-workspace");
    const selected = () => rows().map((r) => r.getAttribute("aria-selected") === "true");
    expect(rows()).toHaveLength(2);
    // Walk down to the first workspace row, then one more.
    for (let i = 0; i < 100 && !selected()[0]; i++) {
      await act(async () => {
        fireEvent.keyDown(input, { key: "ArrowDown" });
      });
    }
    expect(selected()).toEqual([true, false]);
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    expect(selected()).toEqual([false, true]);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onSelectWorkspace).toHaveBeenCalledWith("m2");
  });

  it("shows no group without a workspace switcher", async () => {
    await act(async () => {
      render(<CommandPalette open onClose={vi.fn()} onNewSession={vi.fn()} onToggleTokens={vi.fn()} projects={projects} />);
    });
    expect(document.querySelector('[data-tour="palette-workspaces"]')).toBeNull();
  });
});
