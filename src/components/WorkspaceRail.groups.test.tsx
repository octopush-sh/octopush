/**
 * Mission groups in the workspace rail: the folder signature (always-visible
 * chevron, indented members beside a guide that ends with the group), folds
 * and their persistence, the filter, the header's menu, inline rename, the
 * beacon walking up to the fold that hides it, and the slim rail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { Group, Workspace } from "../lib/types";

const mockIpc = vi.hoisted(() => ({
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  setGroupTint: vi.fn(),
  setGroupOrder: vi.fn(),
  deleteGroup: vi.fn(),
  setItemGroup: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ipc")>();
  return { ...original, ipc: { ...original.ipc, ...mockIpc } };
});
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("./Toasts", () => ({ pushToast }));

import { WorkspaceRail, resolveAttentionCarriers, type ProjectGroup } from "./WorkspaceRail";
import { TINTS } from "../lib/monogram";
import { createMissionGroup } from "../lib/groupActions";
import { useAttentionStore, type AttentionFlag } from "../stores/attentionStore";
import { useGroupsStore, __resetGroupsStoreInFlight } from "../stores/groupsStore";
import { GROUP_COLLAPSE_KEY, useRailGroupUi, __reloadRailGroupUi } from "../stores/railGroupUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

function ws(id: string, name: string, groupId: string | null = null, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    projectId: "p1",
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
    groupId,
    ...over,
  };
}

function group(id: string, name: string, over: Partial<Group> = {}): Group {
  return {
    id,
    scope: "workspace",
    projectId: "p1",
    name,
    tint: null,
    sortOrder: 0,
    createdAt: "2026-11-01T00:00:00Z",
    ...over,
  };
}

const FIXES = group("g-fixes", "Vulnerability fixes", { tint: "rouge", sortOrder: 0 });
const REVIEWS = group("g-reviews", "PR reviews", { sortOrder: 1 });

/** main · [Vulnerability fixes: fix-parser, fix-codec] · [PR reviews: review-billing] · release-notes */
const MISSIONS: Workspace[] = [
  ws("main", "main"),
  ws("w-parser", "fix-parser", FIXES.id, { tint: "verdigris" }),
  ws("w-codec", "fix-codec", FIXES.id),
  ws("w-billing", "review-billing", REVIEWS.id),
  ws("w-notes", "release-notes"),
];

const projects = (missions: Workspace[] = MISSIONS): ProjectGroup[] => [
  { id: "p1", name: "Backend", workspaces: missions },
];

function seed(groups: Group[] = [FIXES, REVIEWS], missions: Workspace[] = MISSIONS) {
  useGroupsStore.setState({ groups, loaded: true });
  // The store's membership changes patch these rows; the rail is given the
  // same rows as props, as App does.
  useWorkspaceStore.setState({ workspaces: missions, workspacesByProjectId: { p1: missions } });
}

interface RailOptions {
  active?: string | null;
  collapsed?: boolean;
  missions?: Workspace[];
  prByWs?: Record<string, null | { number: number; title: string; url: string; isDraft: boolean; state: "open" }>;
  onNewWorkspaceInGroup?: (projectId: string, groupId: string) => void;
}

/** The rail over the workspace store's rows, so a store change re-renders it. */
function Rail({ active = "main", collapsed = false, prByWs, onNewWorkspaceInGroup }: RailOptions) {
  const rows = useWorkspaceStore((s) => s.workspacesByProjectId.p1) ?? [];
  return (
    <WorkspaceRail
      projects={projects(rows)}
      activeWorkspaceId={active}
      onSelect={vi.fn()}
      onCustomize={vi.fn()}
      isCollapsed={collapsed}
      prByWs={prByWs}
      onNewWorkspaceInGroup={onNewWorkspaceInGroup}
    />
  );
}

const header = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const groupEl = (id: string) => screen.getByTestId(`rail-group-${id}`);
/** A mission's monogram (expanded) or cell (slim rail): the one control that
 *  carries its name as `aria-label`, also while it signals attention. */
const queryGlyph = (name: string) =>
  document.querySelector<HTMLElement>(
    `button[aria-label="${name}"], button[aria-label="${name} — needs attention"]`,
  );
const glyph = (name: string) => {
  const el = queryGlyph(name);
  if (!el) throw new Error(`no mission "${name}" in the rail`);
  return el;
};
const rowOf = (name: string) => glyph(name).closest("[data-rail-row]") as HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(mockIpc)) fn.mockReset().mockResolvedValue(undefined);
  pushToast.mockReset();
  __resetGroupsStoreInFlight();
  localStorage.removeItem(GROUP_COLLAPSE_KEY);
  localStorage.removeItem("railProjectCollapsed");
  __reloadRailGroupUi();
  useAttentionStore.setState({ flagsByWs: {} });
  // The launch restore is over: every activation below is a real one unless a
  // test says otherwise.
  useWorkspaceStore.setState({ launchRestoredId: null });
  seed();
});
afterEach(() => {
  useGroupsStore.setState({ groups: [], loaded: false });
  useWorkspaceStore.setState({ workspaces: [], workspacesByProjectId: {} });
});

describe("mission group: the folder signature", () => {
  it("draws a header with a chevron in the group's tint and the name, as one fold control", () => {
    render(<Rail />);
    const h = header("Vulnerability fixes");
    expect(h).toHaveAttribute("aria-expanded", "true");
    expect(within(h).getByTestId("rail-group-name")).toHaveTextContent("Vulnerability fixes");
    expect(within(h).getByTestId("rail-group-name").className).toMatch(/font-mono/);
    // The chevron is always there, in the monogram column, in the tint.
    const chevron = h.querySelector("svg")!.parentElement!;
    expect(chevron).toHaveStyle({ color: TINTS.rouge.accent });
    expect(chevron.className).toMatch(/\bw-5\b/);
    // An untinted group's chevron is mute.
    expect(header("PR reviews").querySelector("svg")!.parentElement!.style.color).toBe("var(--color-octo-mute)");
  });

  it("inks a pale tint's chevron and guide through the theme's solved mark ink", () => {
    seed([{ ...FIXES, tint: "bone" }, { ...REVIEWS, tint: "smoke" }]);
    render(<Rail />);
    const ink = (name: string) => `var(--tint-mark-${name}, ${TINTS[name as "bone" | "smoke"].accent})`;
    expect(header("Vulnerability fixes").querySelector("svg")!.parentElement!.style.color).toBe(ink("bone"));
    expect(within(groupEl(FIXES.id)).getByTestId("rail-group-guide").style.backgroundColor).toBe(ink("bone"));
    expect(header("PR reviews").querySelector("svg")!.parentElement!.style.color).toBe(ink("smoke"));
    // A mission's monogram keeps its own tint.
    expect(glyph("fix-parser")).toHaveStyle({ color: TINTS.verdigris.accent });
  });

  it("indents the members beside a guide, and returns the next loose mission to the outer level", () => {
    render(<Rail />);
    const fixes = groupEl(FIXES.id);
    // Members sit inside the group, indented.
    for (const name of ["fix-parser", "fix-codec"]) {
      const row = rowOf(name);
      expect(fixes).toContainElement(row);
      expect(row).toHaveAttribute("data-rail-row", "member");
      expect(row.className).toMatch(/\bpl-7\b/);
    }
    // The guide belongs to the group and carries its tint; untinted, the strong border.
    const guide = within(fixes).getByTestId("rail-group-guide");
    expect(guide).toHaveStyle({ backgroundColor: TINTS.rouge.accent });
    expect(guide.className).toMatch(/\bw-px\b/);
    expect(guide.className).toMatch(/opacity-50/);
    expect(within(groupEl(REVIEWS.id)).getByTestId("rail-group-guide").style.backgroundColor).toBe(
      "var(--color-octo-border-strong)",
    );
    // The loose mission that follows is outside every group, at the outer indent.
    const loose = rowOf("release-notes");
    expect(fixes).not.toContainElement(loose);
    expect(groupEl(REVIEWS.id)).not.toContainElement(loose);
    expect(loose).toHaveAttribute("data-rail-row", "loose");
    expect(loose.className).toMatch(/\bpl-3\.5\b/);
    expect(loose.className).not.toMatch(/\bpl-7\b/);
  });

  it("places groups between the loose missions without reordering them", () => {
    render(<Rail />);
    const order = Array.from(
      document.querySelectorAll<HTMLElement>("[data-rail-group-header], [data-rail-row] button[aria-label]"),
    ).map((el) => el.getAttribute("data-rail-group-header") ?? el.getAttribute("aria-label"));
    expect(order).toEqual(["main", FIXES.id, "fix-parser", "fix-codec", REVIEWS.id, "review-billing", "release-notes"]);
  });

  it("never recolours a member's monogram", () => {
    render(<Rail />);
    // Its own tint, not the group's rouge; the default brass when it has none.
    expect(glyph("fix-parser")).toHaveStyle({ color: TINTS.verdigris.accent });
    expect(glyph("fix-codec")).toHaveStyle({ color: TINTS.brass.accent });
  });

  it("a mission whose group is unknown is a plain loose row", () => {
    seed([FIXES], MISSIONS);
    render(<Rail />);
    expect(rowOf("review-billing")).toHaveAttribute("data-rail-row", "loose");
  });

  it("an empty group reads `empty`, folded or not, and has no guide", () => {
    seed([FIXES, group("g-empty", "Flaky tests", { sortOrder: 2 })]);
    render(<Rail />);
    const empty = groupEl("g-empty");
    const aggregates = within(empty).getByTestId("rail-group-aggregates");
    expect(aggregates).toHaveTextContent("empty");
    expect(aggregates).not.toHaveAttribute("aria-hidden", "true");
    expect(within(empty).queryByTestId("rail-group-guide")).toBeNull();
    fireEvent.click(header("Flaky tests"));
    expect(within(groupEl("g-empty")).getByTestId("rail-group-aggregates")).toHaveTextContent("empty");
  });
});

describe("mission group: folding", () => {
  it("shows no count while open, and count · PR · dot once folded", () => {
    useAttentionStore.setState({
      flagsByWs: {
        "w-notes": { kind: "terminal", at: 1, since: 1 },
        "w-codec": { kind: "terminal", at: 5, since: 5 },
      },
    });
    const pr = { number: 7, title: "t", url: "u", isDraft: false, state: "open" as const };
    render(<Rail prByWs={{ "w-parser": pr }} />);
    const aggregates = () => within(groupEl(FIXES.id)).getByTestId("rail-group-aggregates");
    // Open: the rows are the count (rail rule: never repeat it in the header).
    expect(aggregates()).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(header("Vulnerability fixes"));
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "false");
    expect(aggregates()).toHaveAttribute("aria-hidden", "false");
    expect(aggregates()).toHaveTextContent("2");
    expect(within(aggregates()).getByRole("img", { name: "Open pull request in this group" })).toBeInTheDocument();
    // The beacon is on the loose row that waited longest; the group gets a dot.
    expect(within(aggregates()).getByRole("img", { name: "Needs your attention" })).toBeInTheDocument();
    // The run is out of reach while folded.
    expect(rowOf("fix-parser").closest("[inert]")).not.toBeNull();
  });

  it("persists the fold in localStorage (railGroupCollapsed) and restores it", () => {
    const { unmount } = render(<Rail />);
    fireEvent.click(header("PR reviews"));
    expect(JSON.parse(localStorage.getItem(GROUP_COLLAPSE_KEY) ?? "{}")).toEqual({ [REVIEWS.id]: true });
    unmount();

    __reloadRailGroupUi(); // a new session reads the stored folds
    render(<Rail />);
    expect(header("PR reviews")).toHaveAttribute("aria-expanded", "false");
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "true");
    // Unfolding removes the entry: open is the default.
    fireEvent.click(header("PR reviews"));
    expect(JSON.parse(localStorage.getItem(GROUP_COLLAPSE_KEY) ?? "{}")).toEqual({});
  });

  it("folds with ← and unfolds with → when the header has the focus", () => {
    render(<Rail />);
    const h = header("Vulnerability fixes");
    fireEvent.keyDown(h, { key: "ArrowRight" }); // already open: nothing
    expect(h).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(h, { key: "ArrowLeft" });
    expect(h).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(h, { key: "ArrowLeft" }); // already folded: nothing
    expect(h).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(h).toHaveAttribute("aria-expanded", "true");
  });

  it("is one tab stop: the header button, with the + out of the tab order", () => {
    render(<Rail onNewWorkspaceInGroup={vi.fn()} />);
    const fixes = groupEl(FIXES.id);
    const headerLine = header("Vulnerability fixes").parentElement!;
    const stops = Array.from(headerLine.querySelectorAll<HTMLElement>("button")).filter((b) => b.tabIndex >= 0);
    expect(stops).toEqual([header("Vulnerability fixes")]);
    expect(within(fixes).getByRole("button", { name: "New mission in Vulnerability fixes" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });
});

describe("mission group: the rail filter", () => {
  const type = (q: string) =>
    fireEvent.change(screen.getByRole("textbox", { name: "Find a project, group or mission" }), {
      target: { value: q },
    });

  it("keeps a placeholder that fits and names groups in its title", () => {
    render(<Rail />);
    const input = screen.getByRole("textbox", { name: "Find a project, group or mission" });
    expect(input).toHaveAttribute("placeholder", "Find a project or mission");
    expect(input).toHaveClass("text-ellipsis");
    expect(input.closest("label")).toHaveAttribute("title", "Find a project, group or mission");
  });

  it("a group-name hit keeps all its members and washes the hit", () => {
    render(<Rail />);
    type("vulner");
    expect(glyph("fix-parser")).toBeInTheDocument();
    expect(glyph("fix-codec")).toBeInTheDocument();
    expect(queryGlyph("release-notes")).toBeNull();
    expect(screen.queryByTestId(`rail-group-${REVIEWS.id}`)).toBeNull();
    expect(within(groupEl(FIXES.id)).getByTestId("rail-hit")).toHaveTextContent("Vulner");
  });

  it("a member hit keeps its group with only the hit", () => {
    render(<Rail />);
    type("codec");
    expect(glyph("fix-codec")).toBeInTheDocument();
    expect(queryGlyph("fix-parser")).toBeNull();
    expect(header("Vulnerability fixes")).toBeInTheDocument();
  });

  it("unfolds everything while typed and leaves the stored fold alone", () => {
    render(<Rail />);
    fireEvent.click(header("Vulnerability fixes"));
    const stored = localStorage.getItem(GROUP_COLLAPSE_KEY);
    type("fix");
    const h = header("Vulnerability fixes");
    expect(h).toHaveAttribute("aria-expanded", "true");
    expect(rowOf("fix-parser").closest("[inert]")).toBeNull();
    // The header stops toggling while a filter holds the group open.
    fireEvent.click(h);
    expect(h).toHaveAttribute("aria-expanded", "true");
    expect(localStorage.getItem(GROUP_COLLAPSE_KEY)).toBe(stored);
    type("");
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("mission group: rename in place", () => {
  it("double-click puts the name in an input, selected; Enter commits", () => {
    render(<Rail />);
    fireEvent.doubleClick(header("PR reviews"));
    const input = screen.getByRole("textbox", { name: "Group name" }) as HTMLInputElement;
    expect(input).toHaveValue("PR reviews");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "PR reviews".length]);
    fireEvent.change(input, { target: { value: "  Reviews  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockIpc.renameGroup).toHaveBeenCalledWith(REVIEWS.id, "Reviews");
    expect(screen.queryByRole("textbox", { name: "Group name" })).toBeNull();
    expect(header("Reviews")).toHaveFocus();
  });

  it("F2 renames; Escape keeps the name; blur commits", () => {
    render(<Rail />);
    fireEvent.keyDown(header("PR reviews"), { key: "F2" });
    let input = screen.getByRole("textbox", { name: "Group name" });
    fireEvent.change(input, { target: { value: "Dropped" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mockIpc.renameGroup).not.toHaveBeenCalled();
    expect(header("PR reviews")).toBeInTheDocument();

    fireEvent.keyDown(header("PR reviews"), { key: "F2" });
    input = screen.getByRole("textbox", { name: "Group name" });
    fireEvent.change(input, { target: { value: "Kept" } });
    fireEvent.blur(input);
    expect(mockIpc.renameGroup).toHaveBeenCalledTimes(1);
    expect(mockIpc.renameGroup).toHaveBeenCalledWith(REVIEWS.id, "Kept");
  });

  it("a blank name changes nothing", () => {
    render(<Rail />);
    fireEvent.keyDown(header("PR reviews"), { key: "F2" });
    const input = screen.getByRole("textbox", { name: "Group name" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockIpc.renameGroup).not.toHaveBeenCalled();
    expect(header("PR reviews")).toBeInTheDocument();
  });

  it("New group… creates the group around the mission and opens its name in edit, selected", async () => {
    const made = group("g-new", "New group", { sortOrder: 2 });
    mockIpc.createGroup.mockResolvedValue(made);
    render(<Rail />);
    await act(async () => {
      await createMissionGroup("p1", "w-notes");
    });
    expect(mockIpc.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace", projectId: "p1", name: "New group", memberIds: ["w-notes"] }),
    );
    const input = screen.getByRole("textbox", { name: "Group name" }) as HTMLInputElement;
    expect(groupEl("g-new")).toContainElement(input);
    expect(input).toHaveValue("New group");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "New group".length]);
    // The mission moved in.
    expect(groupEl("g-new")).toContainElement(rowOf("release-notes"));
    // Enter keeps it, named "New group".
    fireEvent.keyDown(input, { key: "Enter" });
    expect(header("New group")).toBeInTheDocument();
    expect(mockIpc.renameGroup).not.toHaveBeenCalled();
  });

  it("Escape on the new group's name cancels it: the group goes and the mission is back where it was", async () => {
    mockIpc.createGroup.mockResolvedValue(group("g-new", "New group", { sortOrder: 2 }));
    render(<Rail />);
    await act(async () => {
      await createMissionGroup("p1", "w-notes");
    });
    expect(groupEl("g-new")).toContainElement(rowOf("release-notes"));

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Group name" }), { key: "Escape" });
    });

    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("g-new");
    expect(screen.queryByTestId("rail-group-g-new")).toBeNull();
    expect(rowOf("release-notes")).toBeInTheDocument();
    expect(mockIpc.renameGroup).not.toHaveBeenCalled();
  });

  it("New mission group from a project's menu makes an empty mission group, unfolding a folded project", async () => {
    localStorage.setItem("railProjectCollapsed", JSON.stringify({ p1: true }));
    mockIpc.createGroup.mockResolvedValue(group("g-new", "New group", { sortOrder: 2 }));
    render(<Rail />);
    expect(screen.getByRole("button", { name: /Backend/ })).toHaveAttribute("aria-expanded", "false");
    await act(async () => {
      await createMissionGroup("p1");
    });
    expect(mockIpc.createGroup).toHaveBeenCalledWith(expect.objectContaining({ memberIds: [] }));
    expect(screen.getByRole("button", { name: /Backend/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Group name" })).toHaveValue("New group");
    expect(within(groupEl("g-new")).getByTestId("rail-group-aggregates")).toHaveTextContent("empty");
  });
});

describe("mission group: the header menu", () => {
  const openMenu = (name: string) => {
    fireEvent.contextMenu(header(name), { clientX: 40, clientY: 90 });
    return screen.getByRole("menu", { name: "Group actions" });
  };

  it("opens on right-click, on ⇧F10 and on the context-menu key", () => {
    render(<Rail />);
    expect(within(openMenu("Vulnerability fixes")).getByRole("menuitem", { name: /Rename/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.keyDown(header("Vulnerability fixes"), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "Group actions" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(header("Vulnerability fixes"), { key: "ContextMenu" });
    expect(screen.getByRole("menu", { name: "Group actions" })).toBeInTheDocument();
  });

  it("a menu opened from the keyboard gives the focus back to its header; a pointer-opened one moves none", () => {
    render(<Rail />);
    const h = header("Vulnerability fixes");
    h.focus();
    fireEvent.keyDown(h, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: /Rename/ })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(h).toHaveFocus();

    // Opened with the pointer, closing leaves the focus where the menu left it.
    h.blur();
    openMenu("PR reviews");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(header("PR reviews")).not.toHaveFocus();
    expect(h).not.toHaveFocus();
  });

  it("Rename from a keyboard-opened menu ends with the focus in the input", () => {
    render(<Rail />);
    const h = header("PR reviews");
    h.focus();
    fireEvent.keyDown(h, { key: "ContextMenu" });
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    expect(screen.getByRole("textbox", { name: "Group name" })).toHaveFocus();
  });

  it("Rename puts the header's name in edit", () => {
    render(<Rail />);
    fireEvent.click(within(openMenu("PR reviews")).getByRole("menuitem", { name: /Rename/ }));
    expect(screen.getByRole("textbox", { name: "Group name" })).toHaveValue("PR reviews");
  });

  it("Tint recolours the chevron and the guide, and keeps the menu open", () => {
    render(<Rail />);
    const menu = openMenu("PR reviews");
    expect(within(menu).getByRole("menuitemradio", { name: "No tint" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Indigo" }));
    expect(mockIpc.setGroupTint).toHaveBeenCalledWith(REVIEWS.id, "indigo");
    expect(screen.getByRole("menu", { name: "Group actions" })).toBeInTheDocument();
    expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Indigo" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(header("PR reviews").querySelector("svg")!.parentElement!).toHaveStyle({ color: TINTS.indigo.accent });
    expect(within(groupEl(REVIEWS.id)).getByTestId("rail-group-guide")).toHaveStyle({
      backgroundColor: TINTS.indigo.accent,
    });
    // The member's monogram is untouched.
    expect(glyph("review-billing")).toHaveStyle({ color: TINTS.brass.accent });

    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "No tint" }));
    expect(mockIpc.setGroupTint).toHaveBeenLastCalledWith(REVIEWS.id, null);
  });

  it("Ungroup keeps the missions and offers Undo", async () => {
    render(<Rail />);
    const menu = openMenu("Vulnerability fixes");
    expect(within(menu).queryByRole("menuitem", { name: /Remove group/ })).toBeNull();
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Ungroup/ }));
    });
    expect(mockIpc.deleteGroup).toHaveBeenCalledWith(FIXES.id);
    expect(screen.queryByTestId(`rail-group-${FIXES.id}`)).toBeNull();
    // Its missions are loose rows now.
    expect(rowOf("fix-parser")).toHaveAttribute("data-rail-row", "loose");
    expect(rowOf("fix-codec")).toHaveAttribute("data-rail-row", "loose");

    const toast = pushToast.mock.calls.at(-1)![0];
    expect(toast).toMatchObject({ title: 'Ungrouped "Vulnerability fixes"', action: { label: "Undo" } });
    mockIpc.createGroup.mockResolvedValue({ ...FIXES, id: "g-again" });
    await act(async () => {
      toast.action.onClick();
    });
    expect(mockIpc.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Vulnerability fixes", tint: "rouge", memberIds: ["w-parser", "w-codec"] }),
    );
    expect(groupEl("g-again")).toContainElement(rowOf("fix-parser"));
  });

  it("an empty group offers Remove group, with no Undo toast", async () => {
    seed([FIXES, group("g-empty", "Flaky tests", { sortOrder: 2 })]);
    render(<Rail />);
    const menu = openMenu("Flaky tests");
    expect(within(menu).queryByRole("menuitem", { name: /Ungroup/ })).toBeNull();
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove group" }));
    });
    expect(mockIpc.deleteGroup).toHaveBeenCalledWith("g-empty");
    expect(screen.queryByTestId("rail-group-g-empty")).toBeNull();
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("the + and the menu start a new mission in the group", () => {
    const onNew = vi.fn();
    render(<Rail onNewWorkspaceInGroup={onNew} />);
    fireEvent.click(screen.getByRole("button", { name: "New mission in Vulnerability fixes" }));
    expect(onNew).toHaveBeenLastCalledWith("p1", FIXES.id);
    fireEvent.click(within(openMenu("PR reviews")).getByRole("menuitem", { name: "New mission in this group" }));
    expect(onNew).toHaveBeenLastCalledWith("p1", REVIEWS.id);
  });

  it("draws no + when the new-mission flow is not wired", () => {
    render(<Rail />);
    expect(screen.queryByRole("button", { name: /New mission in Vulnerability fixes/ })).toBeNull();
    expect(within(openMenu("PR reviews")).queryByRole("menuitem", { name: /New mission/ })).toBeNull();
  });
});

describe("the beacon walks up to the fold that hides it", () => {
  const pulsing = () => Array.from(document.querySelectorAll(".animate-attention-pulse"));
  const flags: Record<string, AttentionFlag> = {
    "w-codec": { kind: "terminal", at: 1, since: 1 }, // waited longest: the beacon
    "w-billing": { kind: "terminal", at: 2, since: 2 },
  };

  it("on its own row while nothing is folded", () => {
    useAttentionStore.setState({ flagsByWs: flags });
    render(<Rail />);
    expect(pulsing()).toEqual([glyph("fix-codec")]);
  });

  it("on the group header when its group is folded, and only there", () => {
    useAttentionStore.setState({ flagsByWs: flags });
    render(<Rail />);
    fireEvent.click(header("Vulnerability fixes"));
    const visible = pulsing().filter((el) => !el.closest("[inert]"));
    expect(visible).toHaveLength(1);
    expect(header("Vulnerability fixes")).toContainElement(visible[0] as HTMLElement);
    expect(header("Vulnerability fixes")).toHaveAccessibleName(/needs attention/);
    // Unfolded again, the row has it back.
    fireEvent.click(header("Vulnerability fixes"));
    expect(pulsing()).toEqual([glyph("fix-codec")]);
  });

  it("on the project line when the project is folded, whatever the group's fold", () => {
    useAttentionStore.setState({ flagsByWs: flags });
    render(<Rail />);
    fireEvent.click(header("Vulnerability fixes"));
    const project = screen.getByRole("button", { name: /Backend/ });
    fireEvent.click(project);
    const visible = pulsing().filter((el) => !el.closest("[inert]"));
    expect(visible).toHaveLength(1);
    expect(project).toContainElement(visible[0] as HTMLElement);
    expect(project).toHaveAccessibleName(/needs attention/);
  });

  it("a mission pointing at another project's group is loose: that group's header carries nothing for it", () => {
    // `g-theirs` belongs to p2; a stale row of p1 still names it.
    const theirs = group("g-theirs", "Their group", { projectId: "p2" });
    const missions = [ws("main", "main"), ws("w-stray", "stray", theirs.id)];
    seed([theirs], missions);
    useRailGroupUi.getState().setCollapsed(theirs.id, true);
    useAttentionStore.setState({ flagsByWs: { "w-stray": { kind: "terminal", at: 1, since: 1 } } });
    render(
      <WorkspaceRail
        projects={[
          { id: "p1", name: "Backend", workspaces: missions },
          { id: "p2", name: "Frontend", workspaces: [ws("f-main", "main", null, { projectId: "p2" })] },
        ]}
        activeWorkspaceId="main"
        onSelect={vi.fn()}
        onCustomize={vi.fn()}
        isCollapsed={false}
      />,
    );
    // Drawn loose in its own project, and pulsing on its own row.
    expect(rowOf("stray")).toHaveAttribute("data-rail-row", "loose");
    expect(pulsing()).toEqual([glyph("stray")]);
    expect(header("Their group").querySelector(".animate-attention-pulse")).toBeNull();
    expect(header("Their group")).not.toHaveAccessibleName(/needs attention/);
  });

  it("a folded group holding only other waiting missions shows a static dot", () => {
    useAttentionStore.setState({ flagsByWs: flags });
    render(<Rail />);
    fireEvent.click(header("PR reviews"));
    const aggregates = within(groupEl(REVIEWS.id)).getByTestId("rail-group-aggregates");
    expect(within(aggregates).getByRole("img", { name: "Needs your attention" })).toBeInTheDocument();
    expect(header("PR reviews").querySelector(".animate-attention-pulse")).toBeNull();
  });

  it("resolveAttentionCarriers: outermost fold wins, beacon beats dot, open folds carry nothing", () => {
    const p = projects();
    const attention = { "w-codec": "beacon", "w-parser": "dot", "w-billing": "dot", "w-notes": "dot" } as const;
    const known = new Map([
      [FIXES.id, "p1"],
      [REVIEWS.id, "p1"],
    ]);
    const carriers = (foldedProjects: string[], foldedGroups: string[]) =>
      resolveAttentionCarriers(
        p,
        attention,
        known,
        (id) => foldedProjects.includes(id),
        (id) => foldedGroups.includes(id),
      );
    expect(carriers([], [])).toEqual({ byProject: {}, byGroup: {}, bySection: {} });
    expect(carriers([], [FIXES.id, REVIEWS.id])).toEqual({
      byProject: {},
      byGroup: { [FIXES.id]: "beacon", [REVIEWS.id]: "dot" },
      bySection: {},
    });
    expect(carriers(["p1"], [FIXES.id])).toEqual({ byProject: { p1: "beacon" }, byGroup: {}, bySection: {} });
    // A group the store does not know cannot carry anything, and neither can
    // another project's group: the layout draws those missions loose.
    expect(resolveAttentionCarriers(p, attention, new Map(), () => false, () => true)).toEqual({
      byProject: {},
      byGroup: {},
      bySection: {},
    });
    const foreign = new Map([
      [FIXES.id, "p2"],
      [REVIEWS.id, "p1"],
    ]);
    expect(resolveAttentionCarriers(p, attention, foreign, () => false, () => true)).toEqual({
      byProject: {},
      byGroup: { [REVIEWS.id]: "dot" },
      bySection: {},
    });
  });
});

describe("mission group: the slim rail (44px)", () => {
  it("keeps the guide beside the monograms and turns the header into a tinted chevron that folds", () => {
    render(<Rail collapsed />);
    const fixes = groupEl(FIXES.id);
    expect(fixes.className).toMatch(/\bmy-1\.5\b/); // 6px of air above and below
    const chevron = within(fixes).getByRole("button", { name: "Vulnerability fixes" });
    expect(chevron).toHaveAttribute("title", "Vulnerability fixes");
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(chevron.querySelector("svg")!.parentElement!).toHaveStyle({ color: TINTS.rouge.accent });
    expect(chevron.querySelector("svg")).toHaveAttribute("width", "12");
    expect(within(fixes).getByTestId("rail-group-guide")).toHaveStyle({ backgroundColor: TINTS.rouge.accent });
    expect(fixes).toContainElement(glyph("fix-parser"));
    expect(fixes).not.toContainElement(glyph("release-notes"));

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem(GROUP_COLLAPSE_KEY) ?? "{}")).toEqual({ [FIXES.id]: true });
    expect(glyph("fix-parser").closest("[inert]")).not.toBeNull();
  });

  it("names the group in the flyout's eyebrow: project · group", () => {
    render(<Rail collapsed />);
    fireEvent.mouseEnter(glyph("fix-parser").parentElement!);
    expect(screen.getByTestId("rail-flyout-w-parser")).toHaveTextContent("Backend · Vulnerability fixes");
    fireEvent.mouseEnter(glyph("release-notes").parentElement!);
    const loose = screen.getByTestId("rail-flyout-w-notes");
    expect(loose).toHaveTextContent("Backend");
    expect(loose).not.toHaveTextContent("·");
  });

  it("a folded group's chevron carries the beacon", () => {
    useAttentionStore.setState({ flagsByWs: { "w-codec": { kind: "terminal", at: 1, since: 1 } } });
    useRailGroupUi.getState().setCollapsed(FIXES.id, true);
    render(<Rail collapsed />);
    const chevron = screen.getByRole("button", { name: "Vulnerability fixes — needs attention" });
    expect(chevron.querySelector(".animate-attention-pulse")).not.toBeNull();
  });

  it("opens the group menu from the chevron", () => {
    render(<Rail collapsed />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "PR reviews" }), { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu", { name: "Group actions" })).toBeInTheDocument();
  });

  it("opens the group menu beside the chevron on ⇧F10 and the context-menu key, and gives the focus back", () => {
    render(<Rail collapsed />);
    const chevron = screen.getByRole("button", { name: "PR reviews" });
    vi.spyOn(chevron, "getBoundingClientRect").mockReturnValue(
      { left: 0, right: 44, top: 120, bottom: 136, width: 44, height: 16, x: 0, y: 120, toJSON: () => ({}) } as DOMRect,
    );
    chevron.focus();
    fireEvent.keyDown(chevron, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "Group actions" });
    expect(menu).toHaveStyle({ left: "52px", top: "120px" });
    expect(within(menu).getByRole("menuitem", { name: /Ungroup/ })).toBeInTheDocument();
    expect(chevron).toHaveAttribute("aria-expanded", "true"); // the key did not fold it
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chevron).toHaveFocus();

    fireEvent.keyDown(chevron, { key: "ContextMenu" });
    expect(screen.getByRole("menu", { name: "Group actions" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(chevron).toHaveFocus();
  });
});

describe("activating a mission in a folded group", () => {
  const scroll = vi.fn();
  const original = Element.prototype.scrollIntoView;
  beforeEach(() => {
    scroll.mockClear();
    Element.prototype.scrollIntoView = function (this: Element) {
      scroll(this);
    };
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("unfolds the group, then scrolls the row into view", () => {
    useRailGroupUi.getState().setCollapsed(FIXES.id, true);
    const { rerender } = render(<Rail active="main" />);
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "false");
    scroll.mockClear();

    rerender(<Rail active="w-codec" />);
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "true");
    expect(JSON.parse(localStorage.getItem(GROUP_COLLAPSE_KEY) ?? "{}")).toEqual({});
    // Scrolled after the unfold, to the now-reachable row.
    const row = glyph("fix-codec");
    expect(row).toHaveAttribute("aria-current", "location");
    expect(scroll.mock.calls.at(-1)![0]).toBe(row);
    expect(row.closest("[inert]")).toBeNull();
  });

  it("the rail mounted with nothing active: the first activation unfolds the group", () => {
    useRailGroupUi.getState().setCollapsed(FIXES.id, true);
    const { rerender } = render(<Rail active={null} />);
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "false");
    rerender(<Rail active="w-codec" />);
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "true");
    expect(scroll.mock.calls.at(-1)![0]).toBe(glyph("fix-codec"));
  });

  it("only the workspace restored at launch keeps its group folded, and only that once", () => {
    useRailGroupUi.getState().setCollapsed(FIXES.id, true);
    useWorkspaceStore.setState({ launchRestoredId: "w-codec" });
    // The restore arrives after the rail mounted, as it does at launch.
    const { rerender } = render(<Rail active={null} />);
    rerender(<Rail active="w-codec" />);
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "false");
    rerender(<Rail active="w-codec" />);
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "false");
    // Leaving and coming back is an activation.
    rerender(<Rail active="main" />);
    rerender(<Rail active="w-codec" />);
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "true");
  });

  it("a restored workspace already active at mount keeps its group folded too", () => {
    useRailGroupUi.getState().setCollapsed(FIXES.id, true);
    useWorkspaceStore.setState({ launchRestoredId: "w-codec" });
    render(<Rail active="w-codec" />);
    expect(header("Vulnerability fixes")).toHaveAttribute("aria-expanded", "false");
  });

  it("an activation that is not the launch restore unfolds even as the rail's first", () => {
    useRailGroupUi.getState().setCollapsed(REVIEWS.id, true);
    useWorkspaceStore.setState({ launchRestoredId: "main" });
    render(<Rail active="w-billing" />);
    expect(header("PR reviews")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("a folded group that holds the active mission", () => {
  const name = (group: string) => within(header(group)).getByTestId("rail-group-name");

  it("reads in ivory, as a project's line does for the project that holds it", () => {
    useWorkspaceStore.setState({ launchRestoredId: "w-codec" }); // stays folded
    useRailGroupUi.getState().setCollapsed(FIXES.id, true);
    useRailGroupUi.getState().setCollapsed(REVIEWS.id, true);
    render(<Rail active="w-codec" />);
    expect(name("Vulnerability fixes").className).toMatch(/\btext-octo-ivory\b/);
    expect(name("Vulnerability fixes").className).not.toMatch(/\btext-octo-sage\b/);
    // A folded group without it stays sage.
    expect(name("PR reviews").className).toMatch(/\btext-octo-sage\b/);
  });

  it("stays sage while open: the active row itself is the cue", () => {
    useWorkspaceStore.setState({ launchRestoredId: "w-codec" });
    render(<Rail active="w-codec" />);
    expect(name("Vulnerability fixes").className).toMatch(/\btext-octo-sage\b/);
    fireEvent.click(header("Vulnerability fixes"));
    expect(name("Vulnerability fixes").className).toMatch(/\btext-octo-ivory\b/);
  });
});
