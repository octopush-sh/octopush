/**
 * Groups everywhere else, in the rail: multi-select of mission rows (⌘-click,
 * ⇧-click, Escape) and its menu (Group N missions…, Move N missions to group),
 * the keyboard's Move-to-group menu (⌘⌥G on a focused row, rail-scoped), the
 * mission row's menu keys (⇧F10 / the context-menu key) and ⌘K's reveal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within, waitFor } from "@testing-library/react";
import type { Group, Workspace } from "../lib/types";
import type { DndContextProps } from "@dnd-kit/core";

const mockIpc = vi.hoisted(() => ({
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  setGroupTint: vi.fn(),
  setGroupOrder: vi.fn(),
  deleteGroup: vi.fn(),
  setItemGroup: vi.fn(),
  setItemsGroup: vi.fn(),
  setProjectOrder: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ipc")>();
  return { ...original, ipc: { ...original.ipc, ...mockIpc } };
});
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("./Toasts", () => ({ pushToast }));
// The platform, switchable per test: ⌘ on a Mac, Ctrl elsewhere.
const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("../lib/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/platform")>();
  return { ...original, isMac: () => platform.mac };
});
// The rail's DndContext, kept so a test can end a drag as dnd-kit would.
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
  };
});

import { WorkspaceRail, isMoveToGroupChord, type ProjectGroup } from "./WorkspaceRail";
import { useGroupsStore, __resetGroupsStoreInFlight } from "../stores/groupsStore";
import { GROUP_COLLAPSE_KEY, useRailGroupUi, __reloadRailGroupUi } from "../stores/railGroupUiStore";
import { useRailSelection, selectionRange } from "../stores/railSelectionStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { revealGroup } from "../lib/groupActions";
import { __releaseProjectLineFocus } from "../lib/railFocus";

function ws(id: string, name: string, groupId: string | null = null, projectId = "p-api"): Workspace {
  return {
    id, projectId, name, task: "", branch: name, worktreePath: null, setupScript: "", status: "active",
    createdAt: "2026-11-01T00:00:00Z", lastActive: "2026-11-01T00:00:00Z", glyph: null, tint: null,
    linkedIssueKey: null, fromBranch: null, groupId,
  };
}

const FIXES: Group = {
  id: "g-fixes", scope: "workspace", projectId: "p-api", name: "Fixes", tint: "rouge", sortOrder: 0,
  createdAt: "2026-11-01T00:00:00Z",
};
const CLIENT: Group = {
  id: "pg-client", scope: "project", projectId: null, name: "Client work", tint: "verdigris", sortOrder: 0,
  createdAt: "2026-11-01T00:00:00Z",
};

/** acme-api: main · refactor-auth · [Fixes: fix-json-parser] · monthly-report · bump-framework */
const API: Workspace[] = [
  ws("w-main", "main"),
  ws("w-auth", "refactor-auth"),
  ws("w-json", "fix-json-parser", FIXES.id),
  ws("w-report", "monthly-report"),
  ws("w-bump", "bump-framework"),
];
const WEB: Workspace[] = [ws("w-web", "checkout-copy", null, "p-web")];

function seed(groups: Group[] = [FIXES, CLIENT]) {
  useGroupsStore.setState({ groups, loaded: true });
  useWorkspaceStore.setState({
    workspaces: [...API, ...WEB],
    workspacesByProjectId: { "p-api": API, "p-web": WEB },
  });
}

interface RailOptions {
  onSelect?: (id: string) => void;
  onContextMenu?: (id: string, x: number, y: number, fromKeyboard?: boolean) => void;
  collapsed?: boolean;
}

function Rail({ onSelect = vi.fn(), onContextMenu = vi.fn(), collapsed = false }: RailOptions) {
  const api = useWorkspaceStore((s) => s.workspacesByProjectId["p-api"]) ?? [];
  const web = useWorkspaceStore((s) => s.workspacesByProjectId["p-web"]) ?? [];
  const projects: ProjectGroup[] = [
    { id: "p-api", name: "acme-api", groupId: CLIENT.id, workspaces: api },
    { id: "p-web", name: "acme-web", workspaces: web },
  ];
  return (
    <WorkspaceRail
      projects={projects}
      activeWorkspaceId="w-main"
      onSelect={onSelect}
      onCustomize={vi.fn()}
      onContextMenu={onContextMenu}
      onProjectContextMenu={vi.fn()}
      isCollapsed={collapsed}
    />
  );
}

const nameButton = (id: string) =>
  document.querySelector<HTMLElement>(`[data-rail-mission="${id}"]`) ?? (() => { throw new Error(id); })();
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-rail-ws="${id}"]`)!;
const selected = () => useRailSelection.getState().selection?.ids ?? [];

beforeEach(() => {
  platform.mac = false;
  for (const fn of Object.values(mockIpc)) fn.mockReset().mockResolvedValue(undefined);
  pushToast.mockReset();
  __resetGroupsStoreInFlight();
  __releaseProjectLineFocus();
  localStorage.removeItem(GROUP_COLLAPSE_KEY);
  localStorage.removeItem("railProjectCollapsed");
  __reloadRailGroupUi();
  useRailSelection.setState({ selection: null });
  useWorkspaceStore.setState({ launchRestoredId: null });
  seed();
});
afterEach(() => {
  useGroupsStore.setState({ groups: [], loaded: false });
  useWorkspaceStore.setState({ workspaces: [], workspacesByProjectId: {} });
});

describe("rail multi-select", () => {
  it("⌘-click toggles a row into the selection without activating it, and marks it selected", () => {
    const onSelect = vi.fn();
    render(<Rail onSelect={onSelect} />);
    // Ctrl-click off a Mac, ⌘-click on one.
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-report"), { ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    expect(selected()).toEqual(["w-auth", "w-report"]);
    expect(rowOf("w-auth")).toHaveAttribute("data-selected", "true");
    // The existing hover ground and ivory name: no new colour, never brass.
    expect(rowOf("w-auth").className).toContain("bg-octo-panel-2");
    expect(rowOf("w-auth").className).not.toMatch(/brass/);
    expect(nameButton("w-auth")).toHaveTextContent("— selected");
    // Toggling again takes it out.
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    expect(selected()).toEqual(["w-report"]);
    expect(rowOf("w-auth")).not.toHaveAttribute("data-selected");
  });

  it("⇧-click selects the run of drawn rows from the active mission, through a group's members", () => {
    render(<Rail />);
    fireEvent.click(nameButton("w-report"), { shiftKey: true });
    expect(selected()).toEqual(["w-main", "w-auth", "w-json", "w-report"]);
    // A later ⇧-click moves the run's end from the same anchor.
    fireEvent.click(nameButton("w-auth"), { shiftKey: true });
    expect(selected()).toEqual(["w-main", "w-auth"]);
  });

  it("a folded group's members are out of sight, so a ⇧-click run skips them", () => {
    useRailGroupUi.getState().setCollapsed(FIXES.id, true);
    render(<Rail />);
    fireEvent.click(nameButton("w-report"), { shiftKey: true });
    expect(selected()).toEqual(["w-main", "w-auth", "w-report"]);
  });

  it("selecting in another project starts a new selection there", () => {
    render(<Rail />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-web"), { ctrlKey: true });
    expect(useRailSelection.getState().selection).toMatchObject({ projectId: "p-web", ids: ["w-web"] });
  });

  it("a plain click still activates the mission, and lets the selection go", () => {
    const onSelect = vi.fn();
    render(<Rail onSelect={onSelect} />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-report"));
    expect(onSelect).toHaveBeenCalledWith("w-report");
    expect(selected()).toEqual([]);
  });

  it("Escape in the rail clears the selection; an Escape somewhere else that listens for it does not", () => {
    render(
      <>
        <Rail />
        <div className="cm-editor">
          <textarea aria-label="editor" />
        </div>
      </>,
    );
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText("editor"), { key: "Escape" });
    expect(selected()).toEqual(["w-auth"]);
    fireEvent.keyDown(nameButton("w-auth"), { key: "Escape" });
    expect(selected()).toEqual([]);
  });

  it("typing a filter lets the selection go (the rows it named may be out of sight)", () => {
    render(<Rail />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.change(screen.getByLabelText("Find a project, group or mission"), { target: { value: "auth" } });
    expect(selected()).toEqual([]);
  });

  it("selection does not stop the rows from dragging: a selected row still drops into a group", async () => {
    render(<Rail />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    const { onDragEnd } = dnd.props as DndContextProps;
    await act(async () => {
      onDragEnd?.({
        active: {
          id: "mission:w-auth",
          data: { current: { type: "mission", workspaceId: "w-auth", projectId: "p-api", groupId: null } },
        },
        over: { id: "group:g-fixes", data: { current: { type: "group", groupId: "g-fixes", projectId: "p-api" } } },
      } as unknown as Parameters<NonNullable<DndContextProps["onDragEnd"]>>[0]);
    });
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("workspace", "w-auth", "g-fixes");
  });

  it("right-click on a selected row opens the selection's menu; on another row the mission's own", () => {
    const onContextMenu = vi.fn();
    render(<Rail onContextMenu={onContextMenu} />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-report"), { ctrlKey: true });
    fireEvent.contextMenu(rowOf("w-report"), { clientX: 40, clientY: 60 });
    const menu = screen.getByRole("menu", { name: "Selected missions" });
    expect(within(menu).getByText("2 missions selected")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Group 2 missions/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Move 2 missions to group/ })).toBeInTheDocument();
    expect(onContextMenu).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.contextMenu(rowOf("w-bump"), { clientX: 40, clientY: 60 });
    expect(onContextMenu).toHaveBeenCalledWith("w-bump", 40, 60);
    expect(selected()).toEqual([]);
  });

  it("Group N missions… makes one group with every selected mission in ONE create_group call", async () => {
    mockIpc.createGroup.mockResolvedValue({ ...FIXES, id: "g-new", name: "New group", sortOrder: 1 });
    render(<Rail />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-report"), { ctrlKey: true });
    fireEvent.click(nameButton("w-bump"), { ctrlKey: true });
    fireEvent.contextMenu(rowOf("w-bump"), { clientX: 10, clientY: 10 });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Group 3 missions/ }));
    });
    expect(mockIpc.createGroup).toHaveBeenCalledTimes(1);
    expect(mockIpc.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace", projectId: "p-api", name: "New group", memberIds: ["w-auth", "w-report", "w-bump"] }),
    );
    expect(useRailGroupUi.getState().renamingId).toBe("g-new");
    expect(selected()).toEqual([]);
  });

  it("Move N missions to group › moves every selected mission into the chosen group", async () => {
    render(<Rail />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-report"), { ctrlKey: true });
    fireEvent.contextMenu(rowOf("w-auth"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Move 2 missions to group/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Fixes" }));
    });
    // One call for the whole selection: all of it moves, or none.
    expect(mockIpc.setItemsGroup).toHaveBeenCalledTimes(1);
    expect(mockIpc.setItemGroup).not.toHaveBeenCalled();
    const rows = useWorkspaceStore.getState().workspacesByProjectId["p-api"];
    expect(rows.filter((w) => w.groupId === FIXES.id).map((w) => w.id).sort()).toEqual(["w-auth", "w-json", "w-report"]);
  });

  it("on a Mac only ⌘-click selects: a Ctrl-click (the Mac's right-click) does not", () => {
    platform.mac = true;
    const onSelect = vi.fn();
    render(<Rail onSelect={onSelect} />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    expect(selected()).toEqual([]);
    fireEvent.click(nameButton("w-auth"), { metaKey: true });
    expect(selected()).toEqual(["w-auth"]);
    expect(onSelect).toHaveBeenCalledTimes(1); // the Ctrl-click was a plain click
  });

  it("off a Mac a ⌘ (Windows key) click is a plain click", () => {
    const onSelect = vi.fn();
    render(<Rail onSelect={onSelect} />);
    fireEvent.click(nameButton("w-auth"), { metaKey: true });
    expect(selected()).toEqual([]);
    expect(onSelect).toHaveBeenCalledWith("w-auth");
  });

  it("marks a selected row with a static sage edge; the active row keeps brass, a hovered row has none", () => {
    render(<Rail />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-main"), { ctrlKey: true });
    const edge = (id: string) => rowOf(id).querySelector<HTMLElement>("span[aria-hidden]")!;
    expect(edge("w-auth").className).toContain("bg-octo-sage");
    expect(edge("w-auth")).toHaveAttribute("data-selected-edge");
    // The active row is selected too, but its edge stays brass.
    expect(edge("w-main").className).toContain("bg-octo-brass");
    expect(edge("w-main")).not.toHaveAttribute("data-selected-edge");
    // An unselected row's edge is transparent (hover only changes its ground).
    expect(edge("w-report").className).toContain("bg-transparent");
    // The monogram says it as well as the name.
    expect(document.querySelector(`[data-rail-ws="w-auth"] button[aria-label]`)).toHaveAttribute(
      "aria-label",
      "refactor-auth — selected",
    );
  });

  it("a selected mission that leaves the rail leaves the selection, and its menu never opens by itself later", () => {
    const onContextMenu = vi.fn();
    render(<Rail onContextMenu={onContextMenu} />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-report"), { ctrlKey: true });
    // w-report is archived (or deleted, or a reload drops it).
    act(() => {
      const rows = API.filter((w) => w.id !== "w-report");
      useWorkspaceStore.setState({ workspaces: [...rows, ...WEB], workspacesByProjectId: { "p-api": rows, "p-web": WEB } });
    });
    expect(selected()).toEqual(["w-auth"]);
    // A single selected row's right-click is its own menu, not a selection menu that cannot render.
    fireEvent.contextMenu(rowOf("w-auth"), { clientX: 30, clientY: 30 });
    expect(onContextMenu).toHaveBeenCalledWith("w-auth", 30, 30);
    expect(screen.queryByRole("menu", { name: "Selected missions" })).toBeNull();
    // Selecting again does not pop a stale menu up.
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-bump"), { ctrlKey: true });
    fireEvent.click(nameButton("w-main"), { ctrlKey: true });
    expect(screen.queryByRole("menu", { name: "Selected missions" })).toBeNull();
  });

  it("an open selection menu closes when its selection falls under two rows", () => {
    render(<Rail />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-report"), { ctrlKey: true });
    fireEvent.contextMenu(rowOf("w-report"), { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu", { name: "Selected missions" })).toBeInTheDocument();
    act(() => {
      const rows = API.filter((w) => w.id !== "w-auth");
      useWorkspaceStore.setState({ workspaces: [...rows, ...WEB], workspacesByProjectId: { "p-api": rows, "p-web": WEB } });
    });
    expect(screen.queryByRole("menu", { name: "Selected missions" })).toBeNull();
    // A later selection of two shows no menu until asked for.
    fireEvent.click(nameButton("w-bump"), { ctrlKey: true });
    expect(selected()).toEqual(["w-report", "w-bump"]);
    expect(screen.queryByRole("menu", { name: "Selected missions" })).toBeNull();
  });

  it("folding a group drops its hidden members from the selection, so the count matches what is drawn", () => {
    render(<Rail />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-json"), { ctrlKey: true });
    fireEvent.click(nameButton("w-report"), { ctrlKey: true });
    act(() => useRailGroupUi.getState().setCollapsed(FIXES.id, true));
    expect(selected()).toEqual(["w-auth", "w-report"]);
    fireEvent.contextMenu(rowOf("w-report"), { clientX: 10, clientY: 10 });
    expect(screen.getByText("2 missions selected")).toBeInTheDocument();
    // Folding the project hides the rest: the selection goes.
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => {
      fireEvent.click(document.querySelector<HTMLElement>('[data-rail-project-line="p-api"]')!);
    });
    expect(selected()).toEqual([]);
  });

  it("selectionRange is inclusive in either direction, and empty for a row not drawn", () => {
    const order = ["a", "b", "c", "d"];
    expect(selectionRange(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectionRange(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(selectionRange(order, "x", "c")).toEqual(["c"]);
    expect(selectionRange(order, "a", "x")).toEqual([]);
  });
});

describe("mission row: the keyboard's way into its menu", () => {
  it("⇧F10 or the context-menu key opens the mission's menu at the row, from the keyboard", () => {
    const onContextMenu = vi.fn();
    render(<Rail onContextMenu={onContextMenu} />);
    fireEvent.keyDown(nameButton("w-auth"), { key: "F10", shiftKey: true });
    expect(onContextMenu).toHaveBeenCalledWith("w-auth", expect.any(Number), expect.any(Number), true);
    fireEvent.keyDown(nameButton("w-report"), { key: "ContextMenu" });
    expect(onContextMenu).toHaveBeenLastCalledWith("w-report", expect.any(Number), expect.any(Number), true);
    // F10 alone is not the menu key.
    onContextMenu.mockClear();
    fireEvent.keyDown(nameButton("w-report"), { key: "F10" });
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});

describe("Move to group… from the keyboard (⌘⌥G, rail-scoped)", () => {
  // Off a Mac (the default here): Ctrl+Alt+G.
  const chord = { key: "g", code: "KeyG", ctrlKey: true, altKey: true };

  const press = (over: Partial<KeyboardEvent>) =>
    isMoveToGroupChord({ key: "g", code: "KeyG", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false, ...over });

  it("off a Mac matches Ctrl+Alt+G by the physical key, never with ⇧ or the Windows key", () => {
    expect(press({ ctrlKey: true })).toBe(true);
    expect(press({ ctrlKey: true, shiftKey: true })).toBe(false);
    expect(press({ metaKey: true })).toBe(false);
    expect(press({ ctrlKey: true, altKey: false })).toBe(false);
  });

  it("on a Mac matches ⌘⌥G only: Ctrl+Option is VoiceOver's", () => {
    platform.mac = true;
    expect(press({ metaKey: true, key: "©" })).toBe(true);
    expect(press({ ctrlKey: true })).toBe(false);
    expect(press({ metaKey: true, ctrlKey: true })).toBe(false);
    expect(press({ metaKey: true, shiftKey: true })).toBe(false);
  });

  it("on a focused mission row opens the Move-to-group choices at the row, starting on its group", async () => {
    render(<Rail />);
    const button = nameButton("w-json");
    button.focus();
    fireEvent.keyDown(button, chord);
    const menu = screen.getByRole("menu", { name: "Move to group" });
    expect(within(menu).getByTitle("fix-json-parser")).toHaveTextContent("Move to group");
    const current = within(menu).getByRole("menuitemradio", { name: "Fixes" });
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(current);
    expect(within(menu).getByRole("menuitem", { name: /New group/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Remove from group/ })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Remove from group/ }));
    });
    expect(mockIpc.setItemGroup).toHaveBeenCalledWith("workspace", "w-json", null);
    // The row has the focus back.
    await waitFor(() => expect(document.activeElement).toBe(nameButton("w-json")));
  });

  it("Escape closes it and gives the row the focus back", async () => {
    render(<Rail />);
    nameButton("w-auth").focus();
    fireEvent.keyDown(nameButton("w-auth"), chord);
    expect(screen.getByRole("menu", { name: "Move to group" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Move to group" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(nameButton("w-auth")));
  });

  it("type-ahead moves to a group by its first letters", () => {
    seed([FIXES, { ...FIXES, id: "g-reviews", name: "PR reviews", sortOrder: 1 }, CLIENT]);
    render(<Rail />);
    fireEvent.keyDown(nameButton("w-auth"), chord);
    const menu = screen.getByRole("menu", { name: "Move to group" });
    fireEvent.keyDown(document.activeElement!, { key: "p" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: "PR reviews" }));
  });

  it("acts on the whole selection when the focused row is in it", async () => {
    render(<Rail />);
    fireEvent.click(nameButton("w-auth"), { ctrlKey: true });
    fireEvent.click(nameButton("w-report"), { ctrlKey: true });
    fireEvent.keyDown(nameButton("w-report"), chord);
    expect(screen.getByText("Move 2 missions to group")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Fixes" }));
    });
    expect(mockIpc.setItemsGroup).toHaveBeenCalledTimes(1);
    const [kind, ids, groupId] = mockIpc.setItemsGroup.mock.calls[0];
    expect([kind, [...ids].sort(), groupId]).toEqual(["workspace", ["w-auth", "w-report"], FIXES.id]);
    expect(selected()).toEqual([]);
  });

  it("on a focused project line opens the project-group choices", () => {
    render(<Rail />);
    const line = document.querySelector<HTMLElement>('[data-rail-project-line="p-web"]')!;
    fireEvent.keyDown(line, chord);
    const menu = screen.getByRole("menu", { name: "Move to group" });
    expect(within(menu).getByTitle("acme-web")).toHaveTextContent("Move to group");
    expect(within(menu).getByRole("menuitemradio", { name: "Client work" })).toHaveAttribute("aria-checked", "false");
    expect(within(menu).queryByRole("menuitem", { name: /Remove from group/ })).toBeNull();
  });

  it("does not fire in the rail's inputs, nor for a key pressed in an editor or a terminal", () => {
    render(
      <>
        <Rail />
        <div className="cm-editor" tabIndex={0} data-testid="editor" />
        <div className="xterm" tabIndex={0} data-testid="terminal" />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("Find a project, group or mission"), chord);
    fireEvent.keyDown(screen.getByTestId("editor"), chord);
    fireEvent.keyDown(screen.getByTestId("terminal"), chord);
    fireEvent.keyDown(window, chord);
    expect(screen.queryByRole("menu", { name: "Move to group" })).toBeNull();
  });
});

describe("⌘K: reveal a group in the rail", () => {
  it("unfolds the project group, the project and the group, then focuses the group's header", async () => {
    useRailGroupUi.getState().setCollapsed(CLIENT.id, true);
    useRailGroupUi.getState().setCollapsed(FIXES.id, true);
    localStorage.setItem("railProjectCollapsed", JSON.stringify({ "p-api": true }));
    render(<Rail />);
    act(() => revealGroup(FIXES.id));
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-rail-group-header="g-fixes"]')),
    );
    const ui = useRailGroupUi.getState();
    expect(ui.collapsed[CLIENT.id]).toBeFalsy();
    expect(ui.collapsed[FIXES.id]).toBeFalsy();
    expect(ui.revealId).toBeNull();
    expect(JSON.parse(localStorage.getItem("railProjectCollapsed")!)["p-api"]).toBe(false);
  });

  it("lets go of a filter that hides the group, and focuses a project group's eyebrow", async () => {
    render(<Rail />);
    fireEvent.change(screen.getByLabelText("Find a project, group or mission"), { target: { value: "checkout" } });
    expect(document.querySelector('[data-rail-group-header="pg-client"]')).toBeNull();
    act(() => revealGroup(CLIENT.id));
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-rail-group-header="pg-client"]')),
    );
    expect(screen.getByLabelText("Find a project, group or mission")).toHaveValue("");
  });

  it("waits while the rail is slim, and forgets a group that no longer exists", () => {
    const { rerender } = render(<Rail collapsed />);
    act(() => revealGroup(FIXES.id));
    expect(useRailGroupUi.getState().revealId).toBe(FIXES.id);
    act(() => revealGroup("g-gone"));
    rerender(<Rail />);
    expect(useRailGroupUi.getState().revealId).toBeNull();
  });
});
