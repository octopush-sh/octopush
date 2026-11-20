/**
 * Project groups in the workspace rail: the section signature (a hairline and
 * a caps eyebrow above projects that are not indented), where a group stands
 * (the pinned rule included), the hexagon's tint inheritance, folds, the
 * filter, the header's menu and keys, inline rename, the beacon walking up to
 * a folded group, drops at the top level, and the slim rail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { DndContextProps } from "@dnd-kit/core";
import type { Group, ProjectInfo, Workspace } from "../lib/types";

const mockIpc = vi.hoisted(() => ({
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  setGroupTint: vi.fn(),
  setGroupOrder: vi.fn(),
  deleteGroup: vi.fn(),
  setItemGroup: vi.fn(),
  setProjectOrder: vi.fn(),
  listRecentProjects: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ipc")>();
  return { ...original, ipc: { ...original.ipc, ...mockIpc } };
});
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("./Toasts", () => ({ pushToast }));
// The rail's one DndContext, with its handlers kept so a test can start and
// end a drag the way dnd-kit would (jsdom has no layout to drag across).
const dnd = vi.hoisted(() => ({ props: null as unknown }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@dnd-kit/core")>();
  const { createElement } = await import("react");
  return {
    ...original,
    DndContext: (props: DndContextProps) => {
      dnd.props = props;
      return createElement(original.DndContext, props);
    },
    // Marked, so a test can tell whether the overlay is in the tree at all.
    DragOverlay: ({ children }: { children?: React.ReactNode }) =>
      createElement("div", { "data-testid": "drag-overlay" }, children),
  };
});

import { WorkspaceRail, projectMarkColor, resolveAttentionCarriers, type ProjectGroup } from "./WorkspaceRail";
import { TINTS } from "../lib/monogram";
import { sectionDragId, sectionHeadId, TOP_LOOSE_ID } from "../lib/railGroups";
import { createProjectGroup, moveProjectToGroup } from "../lib/groupActions";
import { holdProjectLineFocus, __releaseProjectLineFocus } from "../lib/railFocus";
import { useAttentionStore, type AttentionFlag } from "../stores/attentionStore";
import { useGroupsStore, __resetGroupsStoreInFlight } from "../stores/groupsStore";
import { useProjectStore } from "../stores/projectStore";
import { GROUP_COLLAPSE_KEY, useRailGroupUi, __reloadRailGroupUi } from "../stores/railGroupUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

function ws(id: string, projectId: string, name: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    projectId,
    name,
    task: "",
    branch: name,
    worktreePath: null,
    setupScript: "",
    status: "active",
    createdAt: "2026-11-01T00:00:00Z",
    lastActive: "2026-11-01T00:00:00Z",
    glyph: null,
    tint: null,
    linkedIssueKey: null,
    fromBranch: null,
    groupId: null,
    ...over,
  };
}

function section(id: string, name: string, over: Partial<Group> = {}): Group {
  return {
    id,
    scope: "project",
    projectId: null,
    name,
    tint: null,
    sortOrder: 0,
    createdAt: "2026-11-01T00:00:00Z",
    ...over,
  };
}

function info(id: string, groupId: string | null = null, over: Partial<ProjectInfo> = {}): ProjectInfo {
  return { id, name: id, path: `/code/${id}`, jiraProjectKey: null, pinned: false, tint: null, groupId, ...over };
}

const CLIENT = section("g-client", "Client work", { tint: "verdigris", sortOrder: 0 });
const SIDE = section("g-side", "Side projects", { sortOrder: 1 });

/** dotfiles · [Client work: acme-api, acme-web] · [Side projects: notebook-cli] · scratch */
const PROJECTS: ProjectInfo[] = [
  info("dotfiles"),
  info("acme-api", CLIENT.id),
  info("acme-web", CLIENT.id, { tint: "rouge" }),
  info("notebook-cli", SIDE.id),
  info("scratch"),
];

const MISSIONS: Record<string, Workspace[]> = {
  dotfiles: [ws("w-dot", "dotfiles", "tidy-shell", { tint: "smoke" })],
  "acme-api": [ws("w-api", "acme-api", "rate-limits", { tint: "indigo" }), ws("w-api-2", "acme-api", "audit-log")],
  "acme-web": [ws("w-web", "acme-web", "checkout-copy")],
  "notebook-cli": [ws("w-cli", "notebook-cli", "export-markdown")],
  scratch: [ws("w-scratch", "scratch", "try-things")],
};

function seed(groups: Group[] = [CLIENT, SIDE], projects: ProjectInfo[] = PROJECTS) {
  useGroupsStore.setState({ groups, loaded: true });
  // The store's membership changes patch these rows; the rail is given the
  // same rows as props, as App does.
  useProjectStore.setState({ recent: projects, current: null, closed: [] });
}

interface RailOptions {
  active?: string | null;
  collapsed?: boolean;
  onReorderProjects?: (ids: string[]) => void;
  onProjectContextMenu?: (projectId: string, x: number, y: number, fromKeyboard?: boolean) => void;
}

/** The same rail, told which projects are pinned (as App tells it). */
function PinnedRail(props: RailOptions) {
  return <Rail {...props} withPinned />;
}

/** The rail over the project store's rows, so a store change re-renders it. */
function Rail({
  active = "w-dot",
  collapsed = false,
  onReorderProjects = vi.fn(),
  onProjectContextMenu,
  withPinned = false,
}: RailOptions & { withPinned?: boolean }) {
  const rows = useProjectStore((s) => s.recent);
  const projects: ProjectGroup[] = rows.map((p) => ({
    id: p.id,
    name: p.name,
    tint: p.tint ?? undefined,
    groupId: p.groupId,
    pinned: withPinned ? p.pinned : undefined,
    workspaces: MISSIONS[p.id] ?? [],
  }));
  return (
    <WorkspaceRail
      projects={projects}
      activeWorkspaceId={active}
      onSelect={vi.fn()}
      onCustomize={vi.fn()}
      isCollapsed={collapsed}
      onReorderProjects={onReorderProjects}
      onProjectContextMenu={onProjectContextMenu}
    />
  );
}

const header = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const sectionEl = (id: string) => screen.getByTestId(`rail-section-${id}`);
const projectEl = (id: string) => document.querySelector<HTMLElement>(`[data-rail-project="${id}"]`)!;
const projectLine = (id: string) => document.querySelector<HTMLElement>(`[data-rail-project-line="${id}"]`)!;
/** The colour of a project's hexagon in the expanded rail. */
const hexagon = (id: string) => projectLine(id).querySelector("polygon")!.getAttribute("stroke");
/** The top level as the rail draws it: `a [g: b c] d`. */
const railOrder = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-rail-section], [data-rail-project]"))
    .filter((el) => el.dataset.railSection || !el.closest("[data-rail-section]"))
    .map((el) =>
      el.dataset.railSection
        ? `[${el.dataset.railSection}: ${Array.from(el.querySelectorAll<HTMLElement>("[data-rail-project]"))
            .map((p) => p.dataset.railProject)
            .join(" ")}]`
        : el.dataset.railProject,
    )
    .join(" ");
const glyph = (name: string) => document.querySelector<HTMLElement>(`button[aria-label="${name}"]`)!;

/** End a drag as dnd-kit would: `active` dropped on `over`. */
async function drop(active: { id: string; data: unknown }, over: { id: string; data: unknown } | null) {
  const { onDragEnd } = dnd.props as DndContextProps;
  // Async: a drop that moves a project settles its membership a tick later.
  await act(async () => {
    onDragEnd?.({
      active: { id: active.id, data: { current: active.data } },
      over: over ? { id: over.id, data: { current: over.data } } : null,
    } as unknown as Parameters<NonNullable<DndContextProps["onDragEnd"]>>[0]);
  });
}
const asProject = (id: string, sectionId: string | null) => ({ id, data: { type: "project", sectionId } });

beforeEach(() => {
  for (const fn of Object.values(mockIpc)) fn.mockReset().mockResolvedValue(undefined);
  pushToast.mockReset();
  __resetGroupsStoreInFlight();
  localStorage.removeItem(GROUP_COLLAPSE_KEY);
  localStorage.removeItem("railProjectCollapsed");
  __reloadRailGroupUi();
  useAttentionStore.setState({ flagsByWs: {} });
  useWorkspaceStore.setState({ launchRestoredId: null });
  __releaseProjectLineFocus();
  seed();
  // A reload after a persisted order answers with the rows as they stand.
  mockIpc.listRecentProjects.mockImplementation(async () => useProjectStore.getState().recent);
});
afterEach(() => {
  useGroupsStore.setState({ groups: [], loaded: false });
  useProjectStore.setState({ recent: [], current: null, closed: [] });
});

describe("project group: the section signature", () => {
  it("draws a caps eyebrow as the one fold control, under a hairline", () => {
    render(<Rail />);
    const head = header("Client work");
    expect(head).toHaveAttribute("aria-expanded", "true");
    const name = within(head).getByTestId("rail-section-name");
    expect(name).toHaveTextContent("Client work");
    expect(name.className).toMatch(/font-mono/);
    expect(name.className).toMatch(/uppercase/);
    expect(name.className).toMatch(/tracking-\[0\.25em\]/);
    expect(name.className).toMatch(/text-octo-mute/);
    // The hairline above it: a section that does not open the rail has one.
    expect(sectionEl(CLIENT.id).className).toMatch(/border-t border-octo-hairline/);
  });

  it("never looks like a mission group: no indent, no guide, no always-visible chevron", () => {
    render(<Rail />);
    const client = sectionEl(CLIENT.id);
    expect(within(client).queryByTestId("rail-group-guide")).toBeNull();
    // Its projects stand at the outer alignment, like a loose project's line.
    const inside = projectLine("acme-api").parentElement!;
    const outside = projectLine("dotfiles").parentElement!;
    expect(inside.className).toContain("pl-3.5");
    expect(inside.className).toBe(outside.className);
    // The chevron is on the right and shows on hover, on focus and while folded.
    const chevron = within(client).getByTestId("rail-section-chevron");
    expect(chevron.className).toMatch(/opacity-0/);
    expect(chevron.className).toMatch(/group-hover\/shead:opacity-100/);
    expect(chevron.className).toMatch(/group-focus-within\/shead:opacity-100/);
    expect(chevron).toHaveStyle({ color: TINTS.verdigris.accent });
  });

  it("a group that opens the rail needs no hairline; a loose project right after a group closes it with one", () => {
    seed([CLIENT], [info("acme-api", CLIENT.id), info("scratch"), info("dotfiles")]);
    render(<Rail active={null} />);
    expect(sectionEl(CLIENT.id).className).not.toMatch(/border-t/);
    // `scratch` follows the group: its hairline is where the group ends.
    expect(projectEl("scratch").className).toMatch(/border-t border-octo-hairline/);
    // `dotfiles` follows a loose project: plain air, as before groups.
    expect(projectEl("dotfiles").className).not.toMatch(/border-t/);
    expect(projectEl("dotfiles").className).toContain("mt-3");
  });

  it("a rail with no project group is drawn exactly as before", () => {
    seed([], [info("dotfiles"), info("scratch")]);
    render(<Rail />);
    expect(document.querySelector("[data-rail-section]")).toBeNull();
    expect(projectEl("dotfiles").className).toContain("mt-1");
    expect(projectEl("scratch").className).toContain("mt-3");
    expect(document.querySelector("[data-rail-project].border-t")).toBeNull();
  });
});

describe("project group: where it stands", () => {
  it("stands where its first project stands, with loose projects around it", () => {
    render(<Rail />);
    expect(railOrder()).toBe("dotfiles [g-client: acme-api acme-web] [g-side: notebook-cli] scratch");
  });

  it("gathers a project that sits further down the order", () => {
    seed([CLIENT], [info("acme-api", CLIENT.id), info("dotfiles"), info("acme-web", CLIENT.id)]);
    render(<Rail active={null} />);
    expect(railOrder()).toBe("[g-client: acme-api acme-web] dotfiles");
  });

  it("the pinned rule: a pinned project stays in its group, leads it and brings it up", () => {
    // The backend lists pinned projects first: acme-web is pinned.
    seed(
      [CLIENT, SIDE],
      [
        info("acme-web", CLIENT.id, { pinned: true }),
        info("dotfiles"),
        info("notebook-cli", SIDE.id),
        info("acme-api", CLIENT.id),
        info("scratch"),
      ],
    );
    render(<Rail active={null} />);
    // Only the pinned project's own group moved: Side projects stays put.
    expect(railOrder()).toBe("[g-client: acme-web acme-api] dotfiles [g-side: notebook-cli] scratch");
  });

  it("an empty group stays, last, and reads `empty`", () => {
    seed([CLIENT, SIDE, section("g-later", "Later", { sortOrder: 2 })]);
    render(<Rail />);
    expect(railOrder()).toBe("dotfiles [g-client: acme-api acme-web] [g-side: notebook-cli] scratch [g-later: ]");
    const later = sectionEl("g-later");
    expect(within(later).getByTestId("rail-section-aggregates")).toHaveTextContent("empty");
    expect(within(later).getByTestId("rail-section-aggregates")).not.toHaveAttribute("inert");
  });

  it("a project whose group is unknown is a plain loose project", () => {
    seed([CLIENT], [info("acme-api", CLIENT.id), info("lost", "g-gone")]);
    render(<Rail active={null} />);
    expect(railOrder()).toBe("[g-client: acme-api] lost");
  });
});

describe("project group: the tint", () => {
  it("a project's hexagon takes its group's tint only when it has none of its own", () => {
    render(<Rail />);
    expect(hexagon("acme-api")).toBe(TINTS.verdigris.accent);
    expect(hexagon("acme-web")).toBe(TINTS.rouge.accent);
    // An untinted group gives nothing; a loose project is as it was.
    expect(hexagon("notebook-cli")).toBe("var(--color-octo-mute)");
    expect(hexagon("dotfiles")).toBe("var(--color-octo-mute)");
  });

  it("never recolours a mission's monogram", () => {
    render(<Rail />);
    expect(glyph("rate-limits")).toHaveStyle({ color: TINTS.indigo.accent });
    // An untinted mission keeps the monogram its name gives it, not the group's tint.
    expect(glyph("checkout-copy").style.color).not.toBe("");
    for (const name of ["audit-log", "checkout-copy"]) {
      const loose = render(
        <WorkspaceRail
          projects={[{ id: "solo", name: "solo", workspaces: [ws(`solo-${name}`, "solo", name)] }]}
          activeWorkspaceId={null}
          onSelect={vi.fn()}
          onCustomize={vi.fn()}
          isCollapsed={false}
        />,
      );
      const [grouped, alone] = Array.from(document.querySelectorAll<HTMLElement>(`button[aria-label="${name}"]`));
      expect(grouped.style.color).toBe(alone.style.color);
      loose.unmount();
    }
  });

  it("projectMarkColor: own tint, else the group's, else mute", () => {
    expect(projectMarkColor("rouge", "verdigris")).toBe(TINTS.rouge.accent);
    expect(projectMarkColor(null, "verdigris")).toBe(TINTS.verdigris.accent);
    expect(projectMarkColor(undefined, null)).toBe("var(--color-octo-mute)");
    expect(projectMarkColor("not-a-tint", null)).toBe("var(--color-octo-mute)");
  });
});

describe("project group: folding", () => {
  it("shows no count while open, and `N projects` once folded", () => {
    render(<Rail />);
    const aggregates = within(sectionEl(CLIENT.id)).getByTestId("rail-section-aggregates");
    expect(aggregates).toHaveAttribute("inert");
    fireEvent.click(header("Client work"));
    expect(header("Client work")).toHaveAttribute("aria-expanded", "false");
    expect(aggregates).not.toHaveAttribute("inert");
    expect(aggregates).toHaveTextContent("2 projects");
    // Its projects are folded away, and the chevron stays in sight.
    expect(projectEl("acme-api").closest("[inert]")).not.toBeNull();
    expect(within(sectionEl(CLIENT.id)).getByTestId("rail-section-chevron").className).toMatch(/opacity-100/);
  });

  it("counts one project in the singular", () => {
    useRailGroupUi.getState().setCollapsed(SIDE.id, true);
    render(<Rail />);
    expect(within(sectionEl(SIDE.id)).getByTestId("rail-section-aggregates")).toHaveTextContent("1 project");
    expect(within(sectionEl(SIDE.id)).getByTestId("rail-section-aggregates")).not.toHaveTextContent("projects");
  });

  it("persists the fold beside the mission groups' (railGroupCollapsed) and restores it", () => {
    const { unmount } = render(<Rail />);
    fireEvent.click(header("Client work"));
    expect(JSON.parse(localStorage.getItem(GROUP_COLLAPSE_KEY) ?? "{}")).toEqual({ [CLIENT.id]: true });
    unmount();
    __reloadRailGroupUi();
    render(<Rail />);
    expect(header("Client work")).toHaveAttribute("aria-expanded", "false");
  });

  it("folds with ← and unfolds with → when the header has the focus", () => {
    render(<Rail />);
    const head = header("Client work");
    fireEvent.keyDown(head, { key: "ArrowLeft" });
    expect(head).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(head, { key: "ArrowLeft" });
    expect(head).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(head, { key: "ArrowRight" });
    expect(head).toHaveAttribute("aria-expanded", "true");
  });

  it("is one tab stop: the header button, with the chevron a pointer's decoration", () => {
    render(<Rail />);
    const head = sectionEl(CLIENT.id).querySelector('[data-tour="rail-section-header"]')!;
    expect(head.querySelectorAll("button")).toHaveLength(1);
    expect(within(sectionEl(CLIENT.id)).getByTestId("rail-section-chevron")).toHaveAttribute("aria-hidden", "true");
  });

  it("the chevron is a titled icon that folds and unfolds, like a project's", () => {
    render(<Rail />);
    const chevron = within(sectionEl(CLIENT.id)).getByTestId("rail-section-chevron");
    expect(chevron).toHaveAttribute("title", "Collapse Client work");
    fireEvent.click(chevron);
    expect(header("Client work")).toHaveAttribute("aria-expanded", "false");
    expect(chevron).toHaveAttribute("title", "Expand Client work");
    fireEvent.click(chevron);
    expect(header("Client work")).toHaveAttribute("aria-expanded", "true");
  });

  it("folded over the active mission, the name reads in ivory; open, it stays mute", () => {
    render(<Rail active="w-api" />);
    const name = within(header("Client work")).getByTestId("rail-section-name");
    expect(name.className).toMatch(/text-octo-mute/);
    fireEvent.click(header("Client work"));
    expect(name.className).toMatch(/text-octo-ivory/);
    expect(name.className).not.toMatch(/text-octo-mute/);
  });

  it("activating a mission in a folded group unfolds it", () => {
    useRailGroupUi.getState().setCollapsed(CLIENT.id, true);
    const { rerender } = render(<Rail active="w-dot" />);
    expect(header("Client work")).toHaveAttribute("aria-expanded", "false");
    rerender(<Rail active="w-web" />);
    expect(header("Client work")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("project group: the rail filter", () => {
  const type = (q: string) =>
    fireEvent.change(screen.getByLabelText("Find a project, group or mission"), { target: { value: q } });

  it("a group-name hit keeps all its projects and their missions, and washes the hit", () => {
    render(<Rail />);
    type("client");
    expect(railOrder()).toBe("[g-client: acme-api acme-web]");
    expect(glyph("rate-limits")).toBeTruthy();
    expect(glyph("checkout-copy")).toBeTruthy();
    expect(within(header("Client work")).getByTestId("rail-hit")).toHaveTextContent("Client");
  });

  it("a project or mission hit keeps its group with only what matches", () => {
    render(<Rail />);
    type("acme-web");
    expect(railOrder()).toBe("[g-client: acme-web]");
    type("export");
    expect(railOrder()).toBe("[g-side: notebook-cli]");
    type("tidy");
    expect(railOrder()).toBe("dotfiles");
  });

  it("unfolds everything while typed and leaves the stored fold alone", () => {
    useRailGroupUi.getState().setCollapsed(CLIENT.id, true);
    render(<Rail />);
    type("acme");
    expect(header("Client work")).toHaveAttribute("aria-expanded", "true");
    expect(projectEl("acme-api").closest("[inert]")).toBeNull();
    // The header stops toggling meanwhile.
    fireEvent.click(header("Client work"));
    expect(useRailGroupUi.getState().collapsed[CLIENT.id]).toBe(true);
    type("");
    expect(header("Client work")).toHaveAttribute("aria-expanded", "false");
  });

  it("an empty group leaves under a filter and nothing matching reads so", () => {
    seed([CLIENT, section("g-later", "Later", { sortOrder: 2 })]);
    render(<Rail />);
    type("zzz");
    expect(document.querySelector("[data-rail-section]")).toBeNull();
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
  });
});

describe("project group: rename in place", () => {
  it("double-click puts the name in an input, selected; Enter commits", () => {
    render(<Rail />);
    fireEvent.doubleClick(header("Client work"));
    const input = screen.getByLabelText("Group name") as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionEnd).toBe("Client work".length);
    // It is edited in the eyebrow's own type.
    expect(input.className).toMatch(/uppercase/);
    fireEvent.change(input, { target: { value: "Agency" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockIpc.renameGroup).toHaveBeenCalledWith(CLIENT.id, "Agency");
    expect(header("Agency")).toHaveFocus();
  });

  it("F2 renames; Escape keeps the name", () => {
    render(<Rail />);
    fireEvent.keyDown(header("Side projects"), { key: "F2" });
    const input = screen.getByLabelText("Group name");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mockIpc.renameGroup).not.toHaveBeenCalled();
    expect(mockIpc.deleteGroup).not.toHaveBeenCalled();
    expect(header("Side projects")).toBeInTheDocument();
  });

  it("Escape on a group just made from a project cancels it: the project is back where it was", async () => {
    render(<Rail />);
    const NEW = section("g-new", "New group", { sortOrder: 1 });
    mockIpc.createGroup.mockResolvedValue(NEW);
    await act(async () => {
      await createProjectGroup("acme-web");
    });
    expect(railOrder()).toBe("dotfiles [g-client: acme-api] [g-new: acme-web] [g-side: notebook-cli] scratch");
    const input = screen.getByLabelText("Group name");
    expect(input).toHaveFocus();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("g-new");
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "acme-web", CLIENT.id);
    expect(railOrder()).toBe("dotfiles [g-client: acme-api acme-web] [g-side: notebook-cli] scratch");
    expect(screen.queryByLabelText("Group name")).toBeNull();
    expect(mockIpc.renameGroup).not.toHaveBeenCalled();
  });
});

describe("project group: the header menu", () => {
  const menu = () => screen.getByRole("menu", { name: "Group actions" });

  it("opens on right-click, on ⇧F10 and on the context-menu key", () => {
    render(<Rail />);
    fireEvent.contextMenu(header("Client work"), { clientX: 30, clientY: 40 });
    expect(menu()).toHaveTextContent("Client work");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(header("Client work"), { key: "F10", shiftKey: true });
    expect(menu()).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(header("Client work"), { key: "ContextMenu" });
    expect(menu()).toBeInTheDocument();
  });

  it("a menu opened from the keyboard gives the focus back to its header", () => {
    render(<Rail />);
    header("Client work").focus();
    fireEvent.keyDown(header("Client work"), { key: "F10", shiftKey: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(header("Client work")).toHaveFocus();
  });

  it("speaks of projects, and has no mission-group rows", () => {
    render(<Rail />);
    fireEvent.contextMenu(header("Client work"));
    expect(within(menu()).getByRole("menuitem", { name: /Ungroup/ })).toHaveTextContent("Keeps the projects");
    expect(within(menu()).queryByRole("menuitem", { name: /New mission/ })).toBeNull();
  });

  it("Rename puts the header's name in edit", () => {
    render(<Rail />);
    fireEvent.contextMenu(header("Client work"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: /Rename/ }));
    expect(screen.getByLabelText("Group name")).toHaveFocus();
  });

  it("Tint recolours the chevron and the untinted hexagons, and keeps the menu open", () => {
    render(<Rail />);
    fireEvent.contextMenu(header("Client work"));
    fireEvent.click(within(menu()).getByRole("menuitemradio", { name: "Indigo" }));
    expect(mockIpc.setGroupTint).toHaveBeenCalledWith(CLIENT.id, "indigo");
    expect(within(sectionEl(CLIENT.id)).getByTestId("rail-section-chevron")).toHaveStyle({
      color: TINTS.indigo.accent,
    });
    expect(hexagon("acme-api")).toBe(TINTS.indigo.accent);
    expect(hexagon("acme-web")).toBe(TINTS.rouge.accent);
    expect(menu()).toBeInTheDocument();
    fireEvent.click(within(menu()).getByRole("menuitemradio", { name: "No tint" }));
    expect(hexagon("acme-api")).toBe("var(--color-octo-mute)");
  });

  it("Ungroup keeps the projects in place and offers Undo", async () => {
    render(<Rail />);
    fireEvent.contextMenu(header("Client work"));
    await act(async () => {
      fireEvent.click(within(menu()).getByRole("menuitem", { name: /Ungroup/ }));
    });
    expect(mockIpc.deleteGroup).toHaveBeenCalledWith(CLIENT.id);
    expect(railOrder()).toBe("dotfiles acme-api acme-web [g-side: notebook-cli] scratch");
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Ungrouped "Client work"', action: expect.objectContaining({ label: "Undo" }) }),
    );
  });

  it("an empty group offers Remove group, with no Undo toast", async () => {
    seed([CLIENT, section("g-later", "Later", { sortOrder: 2 })]);
    render(<Rail />);
    fireEvent.contextMenu(header("Later"));
    expect(within(menu()).queryByRole("menuitem", { name: /Ungroup/ })).toBeNull();
    await act(async () => {
      fireEvent.click(within(menu()).getByRole("menuitem", { name: "Remove group" }));
    });
    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("g-later");
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("Move up and Move down step the group as one unit, only where there is somewhere to go", () => {
    const onReorderProjects = vi.fn();
    render(<Rail onReorderProjects={onReorderProjects} />);
    fireEvent.contextMenu(header("Client work"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "Move up" }));
    expect(onReorderProjects).toHaveBeenCalledWith(["acme-api", "acme-web", "dotfiles", "notebook-cli", "scratch"]);
    fireEvent.contextMenu(header("Client work"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "Move down" }));
    expect(onReorderProjects).toHaveBeenLastCalledWith(["dotfiles", "notebook-cli", "acme-api", "acme-web", "scratch"]);
  });

  it("offers no step the pinned-first order would undo, and never reports an empty order", () => {
    // acme-api is pinned: its group stands first because of it, above dotfiles.
    seed(
      [CLIENT],
      [info("acme-api", CLIENT.id, { pinned: true }), info("dotfiles"), info("acme-web", CLIENT.id), info("scratch")],
    );
    const onReorderProjects = vi.fn();
    render(<PinnedRail onReorderProjects={onReorderProjects} />);
    expect(railOrder()).toBe("[g-client: acme-api acme-web] dotfiles scratch");
    fireEvent.contextMenu(header("Client work"));
    // Down past dotfiles would be stored and then listed exactly as it is now.
    expect(within(menu()).queryByRole("menuitem", { name: "Move down" })).toBeNull();
    expect(within(menu()).queryByRole("menuitem", { name: "Move up" })).toBeNull();
    expect(onReorderProjects).not.toHaveBeenCalled();
  });

  it("an empty group steps among the empty groups at the foot, never above a group with projects", async () => {
    const LATER = section("g-later", "Later", { sortOrder: 2 });
    const SOMEDAY = section("g-someday", "Someday", { sortOrder: 3 });
    seed([CLIENT, SIDE, LATER, SOMEDAY]);
    const onReorderProjects = vi.fn();
    render(<Rail onReorderProjects={onReorderProjects} />);
    expect(railOrder()).toBe(
      "dotfiles [g-client: acme-api acme-web] [g-side: notebook-cli] scratch [g-later: ] [g-someday: ]",
    );
    // The first empty group: down only.
    fireEvent.contextMenu(header("Later"));
    expect(within(menu()).queryByRole("menuitem", { name: "Move up" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(menu()).getByRole("menuitem", { name: "Move down" }));
    });
    expect(mockIpc.setGroupOrder).toHaveBeenCalledWith([CLIENT.id, SIDE.id, SOMEDAY.id, LATER.id]);
    expect(railOrder()).toBe(
      "dotfiles [g-client: acme-api acme-web] [g-side: notebook-cli] scratch [g-someday: ] [g-later: ]",
    );
    // Now the last: up only, and the project order is never touched.
    fireEvent.contextMenu(header("Later"));
    expect(within(menu()).queryByRole("menuitem", { name: "Move down" })).toBeNull();
    expect(within(menu()).getByRole("menuitem", { name: "Move up" })).toBeInTheDocument();
    expect(onReorderProjects).not.toHaveBeenCalled();
    expect(mockIpc.setProjectOrder).not.toHaveBeenCalled();
  });

  it("a lone empty group has nowhere to step", () => {
    seed([CLIENT, section("g-later", "Later", { sortOrder: 2 })]);
    render(<Rail />);
    fireEvent.contextMenu(header("Later"));
    expect(within(menu()).queryByRole("menuitem", { name: "Move up" })).toBeNull();
    expect(within(menu()).queryByRole("menuitem", { name: "Move down" })).toBeNull();
  });

  it("a group at the top of the rail has no Move up", () => {
    seed([CLIENT], [info("acme-api", CLIENT.id), info("scratch")]);
    render(<Rail active={null} />);
    fireEvent.contextMenu(header("Client work"));
    expect(within(menu()).queryByRole("menuitem", { name: "Move up" })).toBeNull();
    expect(within(menu()).getByRole("menuitem", { name: "Move down" })).toBeInTheDocument();
  });
});

describe("project line: the menu from the keyboard", () => {
  it("⇧F10 and the context-menu key ask for the project's menu at the line", () => {
    const onProjectContextMenu = vi.fn();
    render(<Rail onProjectContextMenu={onProjectContextMenu} />);
    fireEvent.keyDown(projectLine("acme-api"), { key: "F10", shiftKey: true });
    expect(onProjectContextMenu).toHaveBeenCalledWith("acme-api", expect.any(Number), expect.any(Number), true);
    fireEvent.keyDown(projectLine("dotfiles"), { key: "ContextMenu" });
    expect(onProjectContextMenu).toHaveBeenLastCalledWith("dotfiles", expect.any(Number), expect.any(Number), true);
    // A plain F10 is not the menu key.
    fireEvent.keyDown(projectLine("dotfiles"), { key: "F10" });
    expect(onProjectContextMenu).toHaveBeenCalledTimes(2);
  });

  it("a line the keyboard holds keeps the focus when Move to group renders it under another parent", async () => {
    render(<Rail />);
    // What App does when a keyboard-opened project menu closes.
    holdProjectLineFocus("dotfiles");
    const before = projectLine("dotfiles");
    expect(before).toHaveFocus();
    await act(async () => {
      await moveProjectToGroup("dotfiles", CLIENT.id);
    });
    // The project is in the group now: a new element, and it has the focus.
    const after = projectLine("dotfiles");
    expect(sectionEl(CLIENT.id)).toContainElement(after);
    expect(after).not.toBe(before);
    expect(after).toHaveFocus();
    // Out of the group again: still on the line.
    await act(async () => {
      await moveProjectToGroup("dotfiles", null);
    });
    expect(projectLine("dotfiles")).toHaveFocus();
  });

  it("the hold ends with the user's next key or press, and never takes a focus that went somewhere real", async () => {
    render(<Rail />);
    holdProjectLineFocus("dotfiles");
    // The focus went to a real control (a dialog, a rename input): left alone.
    header("Side projects").focus();
    await act(async () => {
      await moveProjectToGroup("dotfiles", CLIENT.id);
    });
    expect(header("Side projects")).toHaveFocus();
    // A key press ends the hold: a later move does not bring the focus back.
    holdProjectLineFocus("scratch");
    fireEvent.keyDown(window, { key: "Tab" });
    await act(async () => {
      await moveProjectToGroup("scratch", CLIENT.id);
    });
    expect(projectLine("scratch")).not.toHaveFocus();
  });

  it("right-click reports a pointer", () => {
    const onProjectContextMenu = vi.fn();
    render(<Rail onProjectContextMenu={onProjectContextMenu} />);
    fireEvent.contextMenu(projectLine("acme-api"), { clientX: 12, clientY: 34 });
    expect(onProjectContextMenu).toHaveBeenCalledWith("acme-api", 12, 34);
  });
});

describe("drops at the top level", () => {
  it("a plain project reorder still reports the new order, and moves nothing", async () => {
    const onReorderProjects = vi.fn();
    render(<Rail onReorderProjects={onReorderProjects} />);
    await drop(asProject("scratch", null), asProject("dotfiles", null));
    expect(onReorderProjects).toHaveBeenCalledWith(["scratch", "dotfiles", "acme-api", "acme-web", "notebook-cli"]);
    expect(mockIpc.setItemGroup).not.toHaveBeenCalled();
  });

  it("with no groups it is the reorder the rail always did", async () => {
    seed([], [info("a"), info("b"), info("c")]);
    const onReorderProjects = vi.fn();
    render(<Rail active={null} onReorderProjects={onReorderProjects} />);
    await drop({ id: "c", data: { sortable: { index: 2 } } }, { id: "a", data: { sortable: { index: 0 } } });
    expect(onReorderProjects).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  it("a loose project dropped on any project of a group joins the group as its last project", async () => {
    const onReorderProjects = vi.fn();
    render(<Rail onReorderProjects={onReorderProjects} />);
    // On the group's FIRST project: still last.
    await drop(asProject("scratch", null), asProject("acme-api", CLIENT.id));
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "scratch", CLIENT.id);
    // The order travels with the move, not through the owner's reorder.
    expect(mockIpc.setProjectOrder).toHaveBeenCalledWith(["dotfiles", "acme-api", "acme-web", "scratch", "notebook-cli"]);
    expect(onReorderProjects).not.toHaveBeenCalled();
    // The membership is applied at once.
    expect(sectionEl(CLIENT.id).querySelector('[data-rail-project="scratch"]')).not.toBeNull();
  });

  it("a drop that joins a group draws the project in its new place at once, with no step between", async () => {
    let answer!: () => void;
    mockIpc.setItemGroup.mockReturnValue(new Promise<void>((r) => (answer = r)));
    render(<Rail />);
    const seen: string[] = [];
    const stop = useProjectStore.subscribe(() => seen.push(railOrder()));
    await drop(asProject("scratch", null), asProject("acme-api", CLIENT.id));
    // Still waiting on the backend, and already where it lands.
    expect(railOrder()).toBe("dotfiles [g-client: acme-api acme-web scratch] [g-side: notebook-cli]");
    expect(seen).toHaveLength(1);
    await act(async () => answer());
    stop();
  });

  it("a refused drop puts the project and the order back, with one toast", async () => {
    mockIpc.setProjectOrder.mockRejectedValue(new Error("other: locked"));
    render(<Rail />);
    await drop(asProject("scratch", null), asProject("acme-api", CLIENT.id));
    expect(railOrder()).toBe("dotfiles [g-client: acme-api acme-web] [g-side: notebook-cli] scratch");
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith({
      level: "error",
      title: "Couldn't move scratch",
      body: "Your rail is back as it was.",
    });
  });

  it("a project dropped on a group's header joins it as its last project, unfolding it", async () => {
    useRailGroupUi.getState().setCollapsed(CLIENT.id, true);
    const onReorderProjects = vi.fn();
    render(<Rail onReorderProjects={onReorderProjects} />);
    await drop(asProject("dotfiles", null), {
      id: sectionHeadId(CLIENT.id),
      data: { type: "section-head", groupId: CLIENT.id },
    });
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "dotfiles", CLIENT.id);
    expect(mockIpc.setProjectOrder).toHaveBeenCalledWith(["acme-api", "acme-web", "dotfiles", "notebook-cli", "scratch"]);
    expect(onReorderProjects).not.toHaveBeenCalled();
    expect(header("Client work")).toHaveAttribute("aria-expanded", "true");
  });

  it("a group's project dropped on a loose project leaves its group", async () => {
    const onReorderProjects = vi.fn();
    render(<Rail onReorderProjects={onReorderProjects} />);
    await drop(asProject("acme-web", CLIENT.id), asProject("scratch", null));
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "acme-web", null);
    expect(mockIpc.setProjectOrder).toHaveBeenCalledWith(["dotfiles", "acme-api", "notebook-cli", "scratch", "acme-web"]);
    expect(onReorderProjects).not.toHaveBeenCalled();
    expect(sectionEl(CLIENT.id).querySelector('[data-rail-project="acme-web"]')).toBeNull();
  });

  it("a project dragged out to the ungrouped area under the rail leaves its group", async () => {
    // Every project is in a group: there is no loose project to drop on.
    seed([CLIENT], [info("acme-api", CLIENT.id), info("acme-web", CLIENT.id)]);
    const onReorderProjects = vi.fn();
    render(<Rail active={null} onReorderProjects={onReorderProjects} />);
    expect(screen.getByTestId("rail-top-loose")).toBeInTheDocument();
    await drop(asProject("acme-api", CLIENT.id), { id: TOP_LOOSE_ID, data: { type: "top-loose" } });
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("project", "acme-api", null);
    expect(mockIpc.setProjectOrder).toHaveBeenCalledWith(["acme-web", "acme-api"]);
    expect(onReorderProjects).not.toHaveBeenCalled();
    // It goes last, under the group it left.
    expect(railOrder()).toBe("[g-client: acme-web] acme-api");
  });

  it("draws the ungrouped area only while there is a group to leave", () => {
    seed([], [info("dotfiles"), info("scratch")]);
    render(<Rail />);
    expect(screen.queryByTestId("rail-top-loose")).toBeNull();
  });

  it("a group dragged by its header moves as one unit with its projects", async () => {
    const onReorderProjects = vi.fn();
    render(<Rail onReorderProjects={onReorderProjects} />);
    await drop(
      { id: sectionDragId(SIDE.id), data: { type: "section", groupId: SIDE.id } },
      asProject("dotfiles", null),
    );
    expect(onReorderProjects).toHaveBeenCalledWith(["notebook-cli", "dotfiles", "acme-api", "acme-web", "scratch"]);
    expect(mockIpc.setItemGroup).not.toHaveBeenCalled();
    expect(mockIpc.setGroupOrder).not.toHaveBeenCalled();
  });

  it("a drop on nothing, or on itself, changes nothing", async () => {
    const onReorderProjects = vi.fn();
    render(<Rail onReorderProjects={onReorderProjects} />);
    await drop(asProject("scratch", null), null);
    await drop(asProject("scratch", null), asProject("scratch", null));
    expect(onReorderProjects).not.toHaveBeenCalled();
    expect(mockIpc.setItemGroup).not.toHaveBeenCalled();
  });

  it("holds the list to its own scroll room while a project or a group is dragged", () => {
    // A block dragged by a transform past the list's foot lengthens what the
    // list can scroll; auto-scroll would follow it down without end.
    render(<Rail />);
    const list = screen.getByTestId("rail-list");
    const size = (scrollHeight: number, clientHeight: number) => {
      Object.defineProperty(list, "scrollHeight", { configurable: true, value: scrollHeight });
      Object.defineProperty(list, "clientHeight", { configurable: true, value: clientHeight });
    };
    const scrollTo = (top: number) => {
      list.scrollTop = top;
      fireEvent.scroll(list);
      return list.scrollTop;
    };
    const { onDragStart, onDragCancel } = dnd.props as DndContextProps;
    const start = (data: unknown) =>
      act(() =>
        onDragStart?.({ active: { id: "x", data: { current: data } } } as unknown as Parameters<
          NonNullable<DndContextProps["onDragStart"]>
        >[0]),
      );
    // At rest the list scrolls as far as it likes.
    size(1000, 600);
    expect(scrollTo(900)).toBe(900);
    // A project drag starts: 400px of room, and no more however long the list grows.
    start({ type: "project", sectionId: null, sortable: { index: 0 } });
    size(2400, 600);
    expect(scrollTo(380)).toBe(380);
    expect(scrollTo(1500)).toBe(400);
    // Dropped or cancelled: free again.
    act(() => onDragCancel?.({} as Parameters<NonNullable<DndContextProps["onDragCancel"]>>[0]));
    expect(scrollTo(1500)).toBe(1500);
    // A mission rides in the overlay and lengthens nothing: it is not held.
    start({ type: "mission", workspaceId: "w-api", projectId: "acme-api", groupId: null });
    expect(scrollTo(1700)).toBe(1700);
  });

  it("mounts the drag overlay only for a mission or a mission-group header, never for a project or a group", () => {
    // A mounted <DragOverlay> wraps any active drag, and the sortable list
    // then stops moving the dragged project with the pointer: the overlay
    // must not be in the tree while a project or a project group is dragged.
    render(<Rail />);
    const start = (data: unknown) => {
      const { onDragStart } = dnd.props as DndContextProps;
      act(() =>
        onDragStart?.({ active: { id: "x", data: { current: data } } } as unknown as Parameters<
          NonNullable<DndContextProps["onDragStart"]>
        >[0]),
      );
    };
    expect(screen.queryByTestId("drag-overlay")).toBeNull();
    start({ type: "project", sectionId: null, sortable: { index: 0 } });
    expect(screen.queryByTestId("drag-overlay")).toBeNull();
    start({ type: "section", groupId: CLIENT.id, sortable: { index: 1 } });
    expect(screen.queryByTestId("drag-overlay")).toBeNull();
    start({ type: "mission", workspaceId: "w-api", projectId: "acme-api", groupId: null });
    expect(screen.getByTestId("drag-overlay")).toBeInTheDocument();
  });
});

describe("the beacon walks up to a folded project group", () => {
  const flag = (since: number): AttentionFlag => ({ kind: "terminal", at: since, since });

  it("the group's chevron carries the pulse, and neither its project nor its row", () => {
    useAttentionStore.setState({ flagsByWs: { "w-api": flag(1), "w-cli": flag(2) } });
    useRailGroupUi.getState().setCollapsed(CLIENT.id, true);
    render(<Rail />);
    const client = sectionEl(CLIENT.id);
    expect(within(client).getByTestId("rail-section-chevron").className).toMatch(/animate-attention-pulse/);
    expect(header("Client work")).toHaveTextContent("needs attention");
    // One pulse in sight: the row that owns it is folded away with its project.
    const inSight = Array.from(document.querySelectorAll(".animate-attention-pulse")).filter(
      (el) => !el.closest("[inert]"),
    );
    expect(inSight).toHaveLength(1);
    expect(projectLine("acme-api").querySelector(".animate-attention-pulse")).toBeNull();
    // The other waiting mission keeps its own static dot, on its row.
    expect(within(sectionEl(SIDE.id)).getByRole("img", { name: "Needs your attention" })).toBeInTheDocument();
  });

  it("a folded group hiding only a later wait shows a static dot beside its count", () => {
    useAttentionStore.setState({ flagsByWs: { "w-scratch": flag(1), "w-web": flag(2) } });
    useRailGroupUi.getState().setCollapsed(CLIENT.id, true);
    render(<Rail />);
    const aggregates = within(sectionEl(CLIENT.id)).getByTestId("rail-section-aggregates");
    expect(within(aggregates).getByRole("img", { name: "Needs your attention" })).toBeInTheDocument();
    expect(within(sectionEl(CLIENT.id)).getByTestId("rail-section-chevron").className).not.toMatch(
      /animate-attention-pulse/,
    );
  });

  it("resolveAttentionCarriers: the project group is the outermost fold", () => {
    const projects: ProjectGroup[] = [{ id: "acme-api", name: "acme-api", workspaces: MISSIONS["acme-api"] }];
    const carry = (sectionFolded: boolean, projectFolded: boolean) =>
      resolveAttentionCarriers(
        projects,
        { "w-api": "beacon" },
        new Map(),
        () => projectFolded,
        () => false,
        () => CLIENT.id,
        () => sectionFolded,
      );
    expect(carry(true, true)).toEqual({ byProject: {}, byGroup: {}, bySection: { [CLIENT.id]: "beacon" } });
    expect(carry(false, true)).toEqual({ byProject: { "acme-api": "beacon" }, byGroup: {}, bySection: {} });
    expect(carry(false, false)).toEqual({ byProject: {}, byGroup: {}, bySection: {} });
  });
});

describe("project group: the slim rail (44px)", () => {
  it("draws each group as a sub-cluster between hairlines that span the rail", () => {
    render(<Rail collapsed />);
    const client = sectionEl(CLIENT.id);
    expect(within(client).getByRole("img", { name: "Client work · acme-api" })).toBeInTheDocument();
    expect(within(client).getByRole("img", { name: "Client work · acme-web" })).toBeInTheDocument();
    expect(within(sectionEl(SIDE.id)).getByRole("img", { name: "Side projects · notebook-cli" })).toBeInTheDocument();
    // dotfiles | Client work | Side projects | scratch: three edges.
    const edges = screen.getAllByTestId("rail-section-edge");
    expect(edges).toHaveLength(3);
    for (const edge of edges) expect(edge.className).toMatch(/w-full/);
    // Inside a group, the short hairline still parts one project from the next.
    expect(client.querySelectorAll(".w-5.bg-octo-hairline")).toHaveLength(1);
    // A loose project keeps its plain name.
    expect(screen.getByRole("img", { name: "dotfiles" })).toBeInTheDocument();
  });

  it("the hexagons take the group's tint as in the expanded rail", () => {
    render(<Rail collapsed />);
    const stroke = (label: string) =>
      screen.getByRole("img", { name: label }).querySelector("polygon")!.getAttribute("stroke");
    expect(stroke("Client work · acme-api")).toBe(TINTS.verdigris.accent);
    expect(stroke("Client work · acme-web")).toBe(TINTS.rouge.accent);
    expect(stroke("dotfiles")).toBe("var(--color-octo-mute)");
  });

  it("starts the flyout's eyebrow with the group: group · project", () => {
    render(<Rail collapsed />);
    fireEvent.mouseEnter(glyph("rate-limits").parentElement!);
    expect(screen.getByTestId("rail-flyout-w-api")).toHaveTextContent("Client work · acme-api");
    fireEvent.mouseEnter(glyph("try-things").parentElement!);
    const loose = screen.getByTestId("rail-flyout-w-scratch");
    expect(loose).toHaveTextContent("scratch");
    expect(loose).not.toHaveTextContent("·");
  });

  it("names all three levels for a mission in a mission group", () => {
    const folder: Group = {
      id: "g-fixes",
      scope: "workspace",
      projectId: "acme-api",
      name: "Fixes",
      tint: null,
      sortOrder: 0,
      createdAt: "2026-11-01T00:00:00Z",
    };
    seed([CLIENT, SIDE, folder]);
    const original = MISSIONS["acme-api"];
    MISSIONS["acme-api"] = [{ ...original[0], groupId: folder.id }, original[1]];
    try {
      render(<Rail collapsed />);
      fireEvent.mouseEnter(glyph("rate-limits").parentElement!);
      expect(screen.getByTestId("rail-flyout-w-api")).toHaveTextContent("Client work · acme-api · Fixes");
    } finally {
      MISSIONS["acme-api"] = original;
    }
  });

  it("does not fold at this width, and an empty group draws nothing", () => {
    seed([CLIENT, SIDE, section("g-later", "Later", { sortOrder: 2 })]);
    useRailGroupUi.getState().setCollapsed(CLIENT.id, true);
    render(<Rail collapsed />);
    expect(glyph("rate-limits").closest("[inert]")).toBeNull();
    expect(screen.queryByTestId("rail-section-g-later")).toBeNull();
    expect(screen.getAllByTestId("rail-section-edge")).toHaveLength(3);
  });

  it("a rail with no project group keeps its short hairlines only", () => {
    seed([], [info("dotfiles"), info("scratch")]);
    render(<Rail collapsed />);
    expect(screen.queryByTestId("rail-section-edge")).toBeNull();
    expect(document.querySelectorAll(".w-5.bg-octo-hairline")).toHaveLength(1);
  });
});
