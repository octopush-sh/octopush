/**
 * The Command Palette "Groups" section: every rail group in the rail's order,
 * found by name, and chosen to reveal it in the rail. Missions in a group
 * carry the group in their meta line, and a group's name finds them.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { Group, Workspace } from "../lib/types";
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
import { useGroupsStore } from "../stores/groupsStore";
import { paletteGroups } from "../lib/paletteGroups";

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

const ws = (id: string, projectId: string, name: string, groupId: string | null = null): Workspace => ({
  id, projectId, name, task: "", branch: name, worktreePath: null, setupScript: "", status: "active",
  createdAt: "2026-11-10T10:00:00Z", lastActive: "2026-11-10T10:00:00Z", glyph: null, tint: null,
  linkedIssueKey: null, fromBranch: null, groupId,
});

const group = (id: string, scope: Group["scope"], name: string, projectId: string | null = null): Group => ({
  id, scope, projectId, name, tint: scope === "project" ? "verdigris" : null, sortOrder: 0, createdAt: "2026-11-10T09:00:00Z",
});

const GROUPS: Group[] = [
  group("pg-client", "project", "Client work"),
  group("mg-fixes", "workspace", "Fixes", "p-api"),
  group("mg-notes", "workspace", "Release notes", "p-web"),
  // A group of a project that is not open: not in the rail, not listed.
  group("mg-closed", "workspace", "Archive sweep", "p-closed"),
];

const projects: ProjectGroup[] = [
  {
    id: "p-web",
    name: "notebook-web",
    workspaces: [ws("w-web", "p-web", "draft-changelog", "mg-notes")],
  },
  {
    id: "p-api",
    name: "acme-api",
    groupId: "pg-client",
    workspaces: [
      ws("w-main", "p-api", "main"),
      ws("w-json", "p-api", "fix-json-parser", "mg-fixes"),
      ws("w-netty", "p-api", "fix-netty-codec", "mg-fixes"),
    ],
  },
];

async function renderPalette(onRevealGroup: ((id: string) => void) | null = vi.fn(), onClose = vi.fn()) {
  await act(async () => {
    render(
      <CommandPalette
        open
        onClose={onClose}
        onNewSession={vi.fn()}
        onToggleTokens={vi.fn()}
        projects={projects}
        runningByWs={{}}
        onSelectWorkspace={vi.fn()}
        onRevealGroup={onRevealGroup ?? undefined}
      />,
    );
  });
  return { onRevealGroup, onClose };
}

const groupNames = () =>
  screen.queryAllByTestId("palette-group").map((r) => r.querySelector("[title]")?.getAttribute("title"));
const type = async (value: string) => {
  const input = screen.getByPlaceholderText("Type a command, or search…");
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
};

describe("CommandPalette · Groups section", () => {
  beforeEach(() => {
    useRunsStore.setState({ runsByWs: {}, statusSince: {} });
    useGroupsStore.setState({ groups: GROUPS, loaded: true });
  });

  it("lists the open projects' groups in the rail's reading order", async () => {
    await renderPalette();
    expect(document.querySelector('[data-tour="palette-groups"]')).not.toBeNull();
    // The rail draws the loose notebook-web first, then the Client work
    // section holding acme-api (layoutProjects keeps the project order).
    expect(groupNames()).toEqual([
      "Mission group: Release notes",
      "Project group: Client work",
      "Mission group: Fixes",
    ]);
    expect(screen.getByTitle("acme-api · 2 missions")).toBeInTheDocument();
    expect(screen.getByTitle("1 project")).toBeInTheDocument();
  });

  it("finds a group by its name", async () => {
    await renderPalette();
    await type("Fixes");
    expect(groupNames()).toEqual(["Mission group: Fixes"]);
  });

  it("comes after Workspaces at rest, and before them once a query is typed", async () => {
    await renderPalette();
    const headings = () =>
      [...document.querySelectorAll("[cmdk-group]")]
        .filter((g) => !(g as HTMLElement).hidden)
        .map((g) => g.querySelector("[cmdk-group-heading]")?.textContent);
    expect(headings().indexOf("Workspaces")).toBeLessThan(headings().indexOf("Groups"));
    await type("Fixes");
    expect(headings().slice(0, 2)).toEqual(["Groups", "Workspaces"]);
  });

  it("reveals the chosen group in the rail and closes", async () => {
    const { onRevealGroup, onClose } = await renderPalette();
    await type("Client");
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-group"));
    });
    expect(onRevealGroup).toHaveBeenCalledWith("pg-client");
    expect(onClose).toHaveBeenCalled();
  });

  it("is not shown where nothing can reveal a group", async () => {
    await renderPalette(null);
    expect(screen.queryAllByTestId("palette-group")).toHaveLength(0);
  });

  it("shows a mission's group in its meta line, and a group's name finds its missions", async () => {
    await renderPalette();
    expect(screen.getByTitle("acme-api · Fixes · fix-json-parser")).toBeInTheDocument();
    // A loose mission keeps project · branch.
    expect(screen.getByTitle("acme-api · main")).toBeInTheDocument();
    await type("Fixes");
    const missions = screen.getAllByTestId("palette-workspace").map((r) => r.querySelector("[title]")?.getAttribute("title"));
    expect(missions.sort()).toEqual(["fix-json-parser", "fix-netty-codec"]);
  });
});

describe("paletteGroups", () => {
  it("counts members, says empty, and skips mission groups of projects that are not open", () => {
    const rows = paletteGroups(projects, [...GROUPS, group("mg-empty", "workspace", "PR reviews", "p-api")]);
    expect(rows.map((r) => r.id)).toEqual(["mg-notes", "pg-client", "mg-fixes", "mg-empty"]);
    expect(rows.find((r) => r.id === "mg-empty")?.meta).toBe("acme-api · empty");
    expect(rows.find((r) => r.id === "mg-fixes")?.keywords).toEqual(["Fixes", "acme-api"]);
  });
});
