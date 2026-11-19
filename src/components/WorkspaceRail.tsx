import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitCommitHorizontal,
  GitPullRequest,
  GripVertical,
  Plus,
  Search,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { resolveMonogram, TINTS } from "../lib/monogram";
import { ACTIVE_ROW_SELECTOR, useScrollActiveIntoView } from "../hooks/useScrollActiveIntoView";
import { detectIssueKeyForProject } from "../lib/detectIssueKey";
import { MENU_CHROME } from "../lib/menuStyles";
import type { Group, TintName, Workspace, ProjectInfo, WorkspaceGitSummary, Pr } from "../lib/types";
import { nearestVisibleAncestor } from "../lib/beacon";
import { moveMissionToGroup, moveProjectToGroup, ungroupMissions, ungroupProjects } from "../lib/groupActions";
import { prefersReducedMotion } from "../lib/motion";
import { restoreProjectLineFocus } from "../lib/railFocus";
import {
  projectKeyboardCoordinates,
  railCollisions,
  railSubjectOf,
  railTargetOf,
  useFollowPointer,
  type RailTopData,
} from "../lib/railDnd";
import {
  filterRailItems,
  layoutMissions,
  layoutProjects,
  missionGroupOwners,
  missionGroupsOf,
  ownGroupId,
  projectGroupsOf,
  resolveRailDrop,
  resolveTopDrop,
  sectionByProject,
  sectionDragId,
  stepInRail,
  TOP_LOOSE_ID,
  type RailDragSubject,
  type RailDropTarget,
  type RailItem,
  type RailTopItem,
} from "../lib/railGroups";
import { useAttentionStore, type AttentionFlag } from "../stores/attentionStore";
import { useGroupsStore } from "../stores/groupsStore";
import { useMissionsStore } from "../stores/missionsStore";
import { useRailGroupUi } from "../stores/railGroupUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { GroupContextMenu } from "./GroupContextMenu";
import { RailMissionGroup, groupMarkColor } from "./RailMissionGroup";
import { RailProjectSection } from "./RailProjectSection";
import { ProjectMark } from "./icons/ProjectMark";
import { HighlightedLabel, matchRange } from "./primitives/HighlightedLabel";
import { MidTruncate } from "./primitives/MidTruncate";
import { RecentlyClosedDrawer } from "./RecentlyClosedDrawer";
import { CollisionMark, useWorkspaceCollisions } from "./CollisionMark";
import { collisionSegment, worstSeverity } from "../lib/collisions";

/**
 * The workspace rail — "the index".
 *
 * Projects and their missions read as a typeset index, not a file explorer:
 * one surface (no cards, no bordered monograms, no chips), hierarchy carried
 * by type and space. The rules, from the 2026-09-20 rail redesign spec:
 *
 *  - The 2px identity edge speaks of STATE only — brass on the active row,
 *    marching segments while the workspace works, transparent otherwise. The
 *    workspace tint lives in the monogram glyph and nowhere else.
 *  - Git/PR/ticket meta is unboxed mono in mute; PR in verdigris. Header
 *    aggregates appear only while a project is folded (a count visible in
 *    the list is never repeated in its header).
 *  - Exactly one brass pulse per rail (the workspace waiting longest); every
 *    other workspace that needs you carries a static brass dot.
 *  - Collapsed, the rail is the slim-rail geometry of Review's collapsed
 *    navigator (44px, 32px cells, reserved edge) with a hover flyout for
 *    project · name · status.
 *  - A mission group is a folder inside a project (`RailMissionGroup`): an
 *    always-visible chevron and a 1px guide beside its indented members. Its
 *    tint colours those two marks only; monograms are never recoloured. When
 *    the beacon's workspace is folded away, the fold that hides it carries
 *    the pulse (`resolveAttentionCarriers`).
 *  - A project group is a section of the top level (`RailProjectSection`): a
 *    hairline and a caps eyebrow above its projects, which are not indented.
 *    A project's hexagon takes the section's tint only when it has none of
 *    its own (`projectMarkColor`). A section stands where its first project
 *    stands (`layoutProjects`), so a pinned project brings its section up
 *    with it.
 */

/** Hierarchical project/workspace structure for the rail. */
export interface ProjectGroup {
  id: string;
  name: string;
  tint?: string;
  jiraProjectKey?: string | null;
  /** The project group (a section of the rail) this project sits in. Null,
   *  absent or an id that names no loaded group: a loose project. */
  groupId?: string | null;
  /** Pinned projects are listed first; the rail needs it to know which
   *  reorders the list would undo (`stepInRail`). */
  pinned?: boolean;
  workspaces: Workspace[];
}

/**
 * The colour of a project's hexagon: its own tint when the user chose one,
 * else its section's tint, else mute (so N projects never mean N brass
 * hexagons). This is the one place a group's tint reaches a member's mark;
 * a mission's monogram is never recoloured.
 */
export function projectMarkColor(projectTint: string | null | undefined, sectionTint: TintName | null): string {
  const own = projectTint ? TINTS[projectTint as keyof typeof TINTS] : undefined;
  return own?.accent ?? (sectionTint ? TINTS[sectionTint].accent : "var(--color-octo-mute)");
}

interface Props {
  projects: ProjectGroup[];
  activeWorkspaceId: string | null;
  onSelect: (id: string) => void;
  onCustomize: (id: string) => void;
  /** Called when the user right-clicks a workspace row / cell. */
  onContextMenu?: (workspaceId: string, x: number, y: number) => void;
  /** Called when user clicks to create a workspace for a specific project. */
  onNewWorkspaceForProject?: (projectId: string) => void;
  /** Called from a mission group's "+": start a new mission that joins the
   *  group. The "+" is not drawn when this is left out. */
  onNewWorkspaceInGroup?: (projectId: string, groupId: string) => void;
  /** Called when user clicks to add a new project. */
  onAddProject?: () => void;
  /** Called when the user right-clicks a project header, or asks for its
   *  menu from the keyboard (⇧F10 or the context-menu key on the project
   *  line; `fromKeyboard`, so the owner can give the line the focus back). */
  onProjectContextMenu?: (projectId: string, x: number, y: number, fromKeyboard?: boolean) => void;
  /** Soft-closed projects, for the Recently-closed drawer (§4.4). */
  closedProjects?: ProjectInfo[];
  /** Called when the user restores a closed project. */
  onReopenProject?: (projectId: string) => void;
  /** Per-workspace git signal, keyed by workspace id (§4.2/§4.3). */
  gitSummaryByWs?: Record<string, WorkspaceGitSummary>;
  /** Open PR per workspace id (null = none), for the PR indicator (§4.3). */
  prByWs?: Record<string, Pr | null>;
  /** Per-workspace "actively processing" signal (TALK streaming / RUN executing
   *  / DIRECT run). When true the row's identity edge marches; mutually
   *  exclusive with the attention signal. */
  runningByWs?: Record<string, boolean>;
  /** Collapsed state is owned by the parent — the toggle lives in the footer. */
  isCollapsed: boolean;
  /** Persist a new project order (ids top→bottom). */
  onReorderProjects?: (ids: string[]) => void;
  /** Keyboard jump per workspace id (`⌘1`…`⌘9`), for tooltips and the
   *  collapsed flyout. Computed by the owner from the same list the shortcut
   *  handler indexes, so the hint can never lie. */
  shortcutByWs?: Record<string, string>;
}

const COLLAPSE_KEY = "railProjectCollapsed";

const RAIL_WIDTH_EXPANDED = "w-[280px]";
const RAIL_WIDTH_COLLAPSED = "w-[44px]";

const EASE = "ease-[cubic-bezier(0.2,0.8,0.3,1)]";

/** The canonical quiet icon button (design-system §9), sized per use. */
const ICON_BTN =
  "flex shrink-0 items-center justify-center rounded text-octo-mute transition-[color,background-color,opacity] duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

/** The found-match wash (design-system §4) on the filter hit inside a name. */
const HIT_WASH =
  "rounded-[2px] bg-[var(--octo-match)] text-[var(--octo-match-ink)] shadow-[inset_0_0_0_1px_var(--octo-match-ring)]";

type Attention = "beacon" | "dot";

/** Per-project collapsed map from localStorage. Absent id ⇒ expanded (§4.6). */
function loadCollapsedFromStorage(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

/**
 * The single beacon, applied to the rail (design-system §6, Law 2): among the
 * workspaces that can signal attention right now, exactly one pulses — the one
 * that has been waiting longest — and the rest carry a static brass dot.
 *
 * A workspace cannot signal while it is the active one (you are already
 * there) or while it is working: the marching edge owns that row, and the
 * flag takes over the moment the run pauses or finishes. Pure and exported so
 * the rule is testable on its own.
 */
export function resolveAttention(
  projects: ProjectGroup[] | undefined,
  flagsByWs: Record<string, AttentionFlag> | undefined,
  activeWorkspaceId: string | null,
  runningByWs: Record<string, boolean> | undefined,
): Record<string, Attention> {
  const candidates: { id: string; at: number }[] = [];
  for (const project of projects || []) {
    for (const ws of project?.workspaces || []) {
      const id = ws?.id;
      if (!id) continue;
      const flag = flagsByWs?.[id];
      if (!flag) continue;
      if (id === activeWorkspaceId) continue;
      if (runningByWs?.[id]) continue;
      // `since` is the first ping of the current wait; `at` moves with every
      // ping and would let a chatty terminal steal the beacon.
      candidates.push({ id, at: flag.since ?? flag.at ?? 0 });
    }
  }
  if (candidates.length === 0) return {};
  const beacon = candidates.reduce((oldest, c) => (c.at < oldest.at ? c : oldest));
  const out: Record<string, Attention> = {};
  for (const c of candidates) out[c.id] = c.id === beacon.id ? "beacon" : "dot";
  return out;
}

/** The beacon or dot each FOLDED container carries for the workspaces it
 *  hides, by project id, by mission-group id and by project-group id. */
export interface AttentionCarriers {
  byProject: Record<string, Attention>;
  byGroup: Record<string, Attention>;
  bySection: Record<string, Attention>;
}

/**
 * The nearest-visible-ancestor step of the single beacon. A workspace's
 * signal (`attentionByWs`, from `resolveAttention`) is drawn on its own row,
 * unless a fold hides that row: then the outermost folded container around it
 * (its project group's header, else its project line, else its mission
 * group's header) carries it. One container hiding
 * several signals shows the strongest, so the pulse still lands on exactly one
 * visible element. `groupOwners` maps each mission group to its project
 * (`missionGroupOwners`): a workspace is in a group only when the group is
 * its own project's, the test the layout applies, so a header never carries a
 * signal for a row that is drawn loose. `sectionOf` gives the project group a
 * project is laid out in (`sectionByProject`), under the same rule. Pure and
 * exported, like `resolveAttention`.
 */
export function resolveAttentionCarriers(
  projects: ProjectGroup[] | undefined,
  attentionByWs: Record<string, Attention>,
  groupOwners: ReadonlyMap<string, string>,
  isProjectFolded: (projectId: string) => boolean,
  isGroupFolded: (groupId: string) => boolean,
  sectionOf: (projectId: string) => string | null = () => null,
  isSectionFolded: (groupId: string) => boolean = () => false,
): AttentionCarriers {
  const out: AttentionCarriers = { byProject: {}, byGroup: {}, bySection: {} };
  for (const project of projects || []) {
    const sectionId = sectionOf(project.id);
    for (const ws of project?.workspaces || []) {
      const signal = ws?.id ? attentionByWs[ws.id] : undefined;
      if (!signal) continue;
      const groupId = ownGroupId(ws, project.id, groupOwners);
      const carrier = nearestVisibleAncestor([
        ...(sectionId ? [{ map: out.bySection, id: sectionId, folded: isSectionFolded(sectionId) }] : []),
        { map: out.byProject, id: project.id, folded: isProjectFolded(project.id) },
        ...(groupId ? [{ map: out.byGroup, id: groupId, folded: isGroupFolded(groupId) }] : []),
      ]);
      if (!carrier) continue;
      if (signal === "beacon" || !carrier.map[carrier.id]) carrier.map[carrier.id] = signal;
    }
  }
  return out;
}

/** The linked ticket, or one detected from the branch under the project's key. */
function ticketKeyFor(ws: Workspace, project: ProjectGroup): string | null {
  return ws?.linkedIssueKey ?? detectIssueKeyForProject(ws?.branch ?? "", project?.jiraProjectKey ?? null);
}

/** A project and what it shows: every item at rest or on a project-name hit,
 *  only the hits otherwise (a group-name hit keeps the whole group); a project
 *  with nothing to show leaves the rail. */
interface VisibleProject {
  project: ProjectGroup;
  /** Loose missions and mission groups, interleaved in rail order. */
  items: RailItem[];
}

/** One block of the rail's top level and what it shows: a loose project, or a
 *  project group with the projects a filter leaves it (all of them at rest
 *  and on a group-name hit). */
type VisibleTop =
  | { kind: "project"; entry: VisibleProject }
  | {
      kind: "section";
      group: Group;
      /** Every project of the group, for its aggregates. */
      members: ProjectGroup[];
      entries: VisibleProject[];
    };

export function WorkspaceRail({
  projects,
  activeWorkspaceId,
  onSelect,
  onCustomize,
  onContextMenu,
  onNewWorkspaceForProject,
  onNewWorkspaceInGroup,
  onAddProject,
  onProjectContextMenu,
  closedProjects,
  onReopenProject,
  gitSummaryByWs,
  prByWs,
  runningByWs,
  isCollapsed,
  onReorderProjects,
  shortcutByWs,
}: Props) {
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(
    loadCollapsedFromStorage,
  );
  const [filter, setFilter] = useState("");
  const q = isCollapsed ? "" : filter.trim();
  const flagsByWs = useAttentionStore((s) => s.flagsByWs);
  // Memoised: an attention ping or a git refresh replaces one map, and the
  // rail must not recompute every project's shape for it.
  const attentionByWs = useMemo(
    () => resolveAttention(projects, flagsByWs, activeWorkspaceId, runningByWs),
    [projects, flagsByWs, activeWorkspaceId, runningByWs],
  );
  // Mission groups: each project's groups interleaved with its loose missions.
  const groups = useGroupsStore((s) => s.groups);
  const collapsedGroups = useRailGroupUi((s) => s.collapsed);
  const renamingGroupId = useRailGroupUi((s) => s.renamingId);
  const groupOwners = useMemo(() => missionGroupOwners(groups), [groups]);
  const itemsByProject = useMemo(() => {
    const out: Record<string, RailItem[]> = {};
    for (const project of projects || []) {
      if (!project?.id) continue;
      out[project.id] = layoutMissions(
        (project.workspaces || []).filter((w) => !!w),
        missionGroupsOf(groups, project.id),
      );
    }
    return out;
  }, [projects, groups]);
  // Project groups: the top level is loose projects and sections of projects.
  const topItems = useMemo<RailTopItem<ProjectGroup>[]>(
    () =>
      layoutProjects(
        (projects || []).filter((p) => !!p?.id),
        projectGroupsOf(groups),
      ),
    [projects, groups],
  );
  const sectionOfProject = useMemo(() => sectionByProject(topItems), [topItems]);
  // A project line the keyboard holds keeps the focus when a move re-renders
  // it under another parent (see `lib/railFocus.ts`).
  useLayoutEffect(() => {
    restoreProjectLineFocus();
  }, [topItems]);
  const visibleTop = useMemo<VisibleTop[]>(() => {
    const whole = (project: ProjectGroup): VisibleProject => ({
      project,
      items: itemsByProject[project.id] ?? [],
    });
    // A project: every item at rest or on its own name's hit, else its hits.
    const visible = (project: ProjectGroup): VisibleProject | null => {
      if (q === "" || matchRange(project.name ?? "", q)) return whole(project);
      const hits = filterRailItems(itemsByProject[project.id] ?? [], (name) => matchRange(name, q) !== null);
      return hits.length > 0 ? { project, items: hits } : null;
    };
    const out: VisibleTop[] = [];
    for (const item of topItems) {
      if (item.kind === "project") {
        const entry = visible(item.project);
        if (entry) out.push({ kind: "project", entry });
        continue;
      }
      const { group, projects: members } = item;
      // A group-name hit keeps the whole group, as a project-name hit keeps
      // the whole project.
      const entries =
        q !== "" && matchRange(group.name, q)
          ? members.map(whole)
          : members.map(visible).filter((entry): entry is VisibleProject => entry !== null);
      // At rest an empty group stays (it is a standing bucket); under a
      // filter a group with nothing to show leaves like a project does.
      if (q === "" || entries.length > 0) out.push({ kind: "section", group, members, entries });
    }
    return out;
  }, [topItems, itemsByProject, q]);
  // Where the beacon and the dots show when a fold hides their rows. Folds
  // are ignored while a filter holds everything open; the slim rail has no
  // project fold and no project-group fold.
  const carriers = useMemo(
    () =>
      resolveAttentionCarriers(
        projects,
        attentionByWs,
        groupOwners,
        (id) => !isCollapsed && q === "" && !!collapsedProjects[id],
        (id) => q === "" && !!collapsedGroups[id],
        (projectId) => sectionOfProject.get(projectId) ?? null,
        (id) => !isCollapsed && q === "" && !!collapsedGroups[id],
      ),
    [projects, attentionByWs, groupOwners, isCollapsed, q, collapsedProjects, collapsedGroups, sectionOfProject],
  );

  const toggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch (err) {
        console.error("Failed to persist railProjectCollapsed:", err);
      }
      return next;
    });
  }, []);
  // #846: a newly active workspace (a project just opened, a jump key, a
  // palette pick) is scrolled into view, calmly, and only when off-screen.
  const listRef = useRef<HTMLDivElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  useScrollActiveIntoView(listRef, isCollapsed ? null : activeWorkspaceId, visibleTop);

  // Activating a mission that sits in a folded group (its mission group, its
  // project's group, or both) unfolds it, then
  // brings the row into view: the hook above scrolled while the row still had
  // no height, so the scroll is repeated once the fold has opened (at once,
  // which is all reduced motion needs, and again after the 280ms transition).
  // Only the workspace the app restored by itself at launch is not an
  // activation (`workspaceStore.launchRestoredId`): a group folded on purpose
  // stays folded across a restart. Every other first sight of an active id
  // is one, also when the rail mounted with nothing active.
  const seenActive = useRef<string | null>(null);
  const keptForLaunch = useRef<string | null>(null);
  const revealFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (seenActive.current === activeWorkspaceId) return;
    const all = (projects || []).flatMap((p) => p?.workspaces || []);
    const ws = all.find((w) => w?.id === activeWorkspaceId);
    if (!ws) return; // its row has not loaded yet: retry when the projects change
    seenActive.current = activeWorkspaceId;
    const restored = useWorkspaceStore.getState().launchRestoredId;
    if (restored === activeWorkspaceId && keptForLaunch.current !== restored) {
      // Once per restore: coming back to it later is an activation.
      keptForLaunch.current = restored;
      return;
    }
    const ui = useRailGroupUi.getState();
    const folded = [sectionOfProject.get(ws.projectId) ?? null, ownGroupId(ws, ws.projectId, groupOwners)].filter(
      (id): id is string => id !== null && !!ui.collapsed[id],
    );
    if (folded.length === 0) return;
    revealFor.current = activeWorkspaceId;
    for (const id of folded) ui.setCollapsed(id, false);
  }, [activeWorkspaceId, projects, groupOwners, sectionOfProject]);
  useEffect(() => {
    if (!revealFor.current || revealFor.current !== activeWorkspaceId) return;
    revealFor.current = null;
    const reveal = () =>
      asideRef.current?.querySelector<HTMLElement>(ACTIVE_ROW_SELECTOR)?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    reveal();
    const timer = setTimeout(reveal, 300);
    return () => clearTimeout(timer);
  }, [collapsedGroups, activeWorkspaceId]);

  // A group whose name went into edit must be on screen: open its project.
  // The slim rail has no room for the input, so the name stays as it is.
  useEffect(() => {
    if (!renamingGroupId) return;
    if (isCollapsed) {
      useRailGroupUi.getState().stopRename();
      return;
    }
    const projectId = groups.find((g) => g.id === renamingGroupId)?.projectId;
    if (projectId && collapsedProjects[projectId]) toggleProjectCollapsed(projectId);
  }, [renamingGroupId, isCollapsed, groups, collapsedProjects, toggleProjectCollapsed]);

  // The header menu of a group (a mission group's or a project group's),
  // owned by the rail.
  const [groupMenu, setGroupMenu] = useState<{
    groupId: string;
    x: number;
    y: number;
    fromKeyboard: boolean;
  } | null>(null);
  const openGroupMenu = useCallback((groupId: string, x: number, y: number, fromKeyboard = false) => {
    setGroupMenu({ groupId, x, y, fromKeyboard });
  }, []);
  // A menu the keyboard opened gives the focus back to its header when it
  // closes (as `useAnchoredMenu` does for a button's menu), so Escape does
  // not drop the keyboard out of the rail. A pointer-opened one does not
  // move the focus. Rename then takes it for its input; a press elsewhere
  // still lands where it was aimed, since the browser focuses that after.
  const closeGroupMenu = () => {
    const closing = groupMenu;
    setGroupMenu(null);
    if (!closing?.fromKeyboard) return;
    Array.from(asideRef.current?.querySelectorAll<HTMLElement>("[data-rail-group-header]") ?? [])
      .find((el) => el.dataset.railGroupHeader === closing.groupId)
      ?.focus({ preventScroll: true });
  };
  const menuGroup = groupMenu ? groups.find((g) => g.id === groupMenu.groupId) : undefined;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Only a project has a keyboard drag, and it must step from project to
    // project, never onto a mission group's drop target.
    useSensor(KeyboardSensor, { coordinateGetter: projectKeyboardCoordinates }),
  );
  // Projects and project groups drag whenever the list is whole and the owner
  // persists the order.
  const dragEnabled = !isCollapsed && q === "" && !!onReorderProjects;
  // Missions and group headers drag whenever the list is whole (no filter).
  const groupDragEnabled = !isCollapsed && q === "";
  const [dragging, setDragging] = useState<RailDragSubject | null>(null);
  // How far the list could scroll when the drag began. A project or a group
  // is dragged by a transform, and a transformed block that travels past the
  // list's foot lengthens what the list can scroll: dnd-kit's auto-scroll
  // then keeps scrolling after it, the block keeps its place under the
  // pointer, and the list runs away from under the drag. The list is held to
  // the room its own content gave it.
  const scrollLimit = useRef<number | null>(null);
  const holdScroll = (list: HTMLDivElement) => {
    const max = scrollLimit.current;
    if (max === null) return;
    if (list.scrollTop > max) list.scrollTop = max;
    if (list.scrollLeft !== 0) list.scrollLeft = 0;
  };
  const endDrag = () => {
    scrollLimit.current = null;
    setDragging(null);
  };
  const handleDragStart = (e: DragStartEvent) => {
    const subject = railSubjectOf(e.active.data.current);
    const list = listRef.current;
    // A mission and a mission-group header ride in the overlay: they lengthen nothing.
    scrollLimit.current = !subject && list ? Math.max(0, list.scrollHeight - list.clientHeight) : null;
    setDragging(subject);
  };
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    endDrag();
    const subject = railSubjectOf(active.data.current);
    if (subject) {
      const target = railTargetOf(over?.data.current);
      if (!target) return;
      const action = resolveRailDrop(
        subject,
        target,
        missionGroupsOf(groups, subject.projectId).map((g) => g.id),
      );
      if (action?.kind === "move") void moveMissionToGroup(action.workspaceId, action.groupId);
      if (action?.kind === "reorder") void useGroupsStore.getState().setOrder(action.ids);
      return;
    }
    // The top level: a project or a project group. A project dropped in
    // another container (a group, or the loose top level) joins it too.
    if (!over) return;
    const action = resolveTopDrop(topItems, String(active.id), String(over.id));
    if (!action) return;
    if (action.move) {
      // The order travels with the owner's callback, so the move persists none.
      void moveProjectToGroup(action.move.projectId, action.move.groupId, null);
    }
    if (action.order) onReorderProjects?.(action.order);
  };
  // "Move up" / "Move down" in a project group's menu: one block at a time,
  // as the order to persist, or null when the step would change nothing.
  const stepSection = (direction: -1 | 1) =>
    onReorderProjects && menuGroup?.scope === "project"
      ? stepInRail(topItems, sectionDragId(menuGroup.id), direction)
      : null;
  const sectionUp = stepSection(-1);
  const sectionDown = stepSection(1);

  // One project of the expanded rail, loose or in the project group `section`.
  const renderProject = (
    entry: VisibleProject,
    lead: ProjectLead,
    section: Group | null,
    sectionFolded = false,
  ) => {
    const { project, items } = entry;
    return (
      <SortableProjectGroup
        key={project.id}
        project={project}
        items={items}
        lead={lead}
        sectionId={section?.id ?? null}
        sectionTint={section?.tint ?? null}
        hidden={sectionFolded}
        collapsedGroups={collapsedGroups}
        attention={carriers.byProject[project.id] ?? null}
        groupAttention={carriers.byGroup}
        groupDragEnabled={groupDragEnabled}
        dragging={dragging}
        onGroupContextMenu={openGroupMenu}
        onNewWorkspaceInGroup={onNewWorkspaceInGroup}
        q={q}
        folded={q === "" && !!collapsedProjects[project.id]}
        toggleProjectCollapsed={toggleProjectCollapsed}
        activeWorkspaceId={activeWorkspaceId}
        gitSummaryByWs={gitSummaryByWs}
        prByWs={prByWs}
        runningByWs={runningByWs}
        attentionByWs={attentionByWs}
        flagsByWs={flagsByWs}
        shortcutByWs={shortcutByWs}
        onSelect={onSelect}
        onCustomize={onCustomize}
        onContextMenu={onContextMenu}
        onNewWorkspaceForProject={onNewWorkspaceForProject}
        onProjectContextMenu={onProjectContextMenu}
        dragEnabled={dragEnabled}
      />
    );
  };

  return (
    <aside
      ref={asideRef}
      data-tour="rail"
      className={`flex h-full shrink-0 flex-col border-r border-octo-hairline bg-octo-panel pt-2 transition-[width] duration-[220ms] ${EASE} ${
        isCollapsed ? RAIL_WIDTH_COLLAPSED : RAIL_WIDTH_EXPANDED
      }`}
      aria-label="Missions"
    >
      {isCollapsed ? (
        <CollapsedRail
          projects={projects || []}
          activeWorkspaceId={activeWorkspaceId}
          onSelect={onSelect}
          onCustomize={onCustomize}
          onContextMenu={onContextMenu}
          onAddProject={onAddProject}
          onProjectContextMenu={onProjectContextMenu}
          gitSummaryByWs={gitSummaryByWs}
          prByWs={prByWs}
          runningByWs={runningByWs}
          attentionByWs={attentionByWs}
          flagsByWs={flagsByWs}
          shortcutByWs={shortcutByWs}
          topItems={topItems}
          itemsByProject={itemsByProject}
          collapsedGroups={collapsedGroups}
          groupAttention={carriers.byGroup}
          onGroupContextMenu={openGroupMenu}
        />
      ) : (
        <>
          {/* The head — one quiet line: a borderless search whose bottom hairline
              turns brass on focus, and the one "Add project" icon button. */}
          <div className="flex h-9 shrink-0 items-center gap-1.5 pl-3.5 pr-2">
            <label
              data-tour="rail-search"
              className="flex h-[26px] min-w-0 flex-1 items-center gap-2 border-b border-transparent text-octo-mute transition-colors duration-[220ms] focus-within:border-octo-brass focus-within:text-octo-brass"
              title="Find a project, group or mission"
            >
              <Search size={12} aria-hidden className="shrink-0" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setFilter("");
                }}
                placeholder="Find a project, group or mission"
                spellCheck={false}
                aria-label="Find a project, group or mission"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
              />
            </label>
            {onAddProject && (
              <button
                type="button"
                onClick={onAddProject}
                data-tour="rail-add-project"
                title="Add project"
                aria-label="Add project"
                className={`${ICON_BTN} h-6 w-6`}
              >
                <Plus size={14} aria-hidden />
              </button>
            )}
          </div>

          <div
            ref={listRef}
            data-testid="rail-list"
            className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2"
            onScroll={(e) => holdScroll(e.currentTarget)}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={railCollisions}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={endDrag}
            >
              {/* The top level is one sortable list of blocks: loose projects
                  and project groups (each dragged as a unit). A group's
                  projects are a sortable list of their own inside it. */}
              <SortableContext
                items={visibleTop.map((item) =>
                  item.kind === "project" ? item.entry.project.id : sectionDragId(item.group.id),
                )}
                strategy={verticalListSortingStrategy}
              >
                {visibleTop.map((item, topIndex) => {
                  if (item.kind === "project") {
                    const lead =
                      topIndex === 0 ? "first" : visibleTop[topIndex - 1].kind === "section" ? "after-section" : "next";
                    return renderProject(item.entry, lead, null);
                  }
                  const { group, members, entries } = item;
                  const sectionFolded = q === "" && !!collapsedGroups[group.id];
                  return (
                    <RailProjectSection
                      key={`section-${group.id}`}
                      group={group}
                      projectCount={members.length}
                      lead={
                        topIndex === 0
                          ? "first"
                          : visibleTop[topIndex - 1].kind === "section"
                            ? "after-section"
                            : "after-project"
                      }
                      folded={sectionFolded}
                      canFold={q === ""}
                      q={q}
                      holdsActive={members.some((p) => p.workspaces.some((w) => w?.id === activeWorkspaceId))}
                      attention={sectionFolded ? (carriers.bySection[group.id] ?? null) : null}
                      dragEnabled={dragEnabled}
                      hitClassName={HIT_WASH}
                      onToggle={() => useRailGroupUi.getState().toggle(group.id)}
                      onContextMenu={(x, y, fromKeyboard) => openGroupMenu(group.id, x, y, fromKeyboard)}
                    >
                      <SortableContext
                        items={entries.map(({ project }) => project.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {entries.map((entry, index) =>
                          renderProject(entry, index === 0 ? "section-first" : "next", group, sectionFolded),
                        )}
                      </SortableContext>
                    </RailProjectSection>
                  );
                })}
              </SortableContext>
              {/* The ungrouped area under the last block: a project dragged
                  out of its group and dropped here leaves it. Drawn only
                  while there is a group to leave, so a rail without groups
                  is laid out exactly as it always was. */}
              {dragEnabled && topItems.some((item) => item.kind === "section") && <TopLooseArea />}
              {/* The drag ghost of a mission or a group header, drawn outside
                  the list so the folds' clipping never cuts it. It is mounted
                  ONLY for those two drags: a mounted <DragOverlay> wraps any
                  active drag, children or not, and the sortable list then
                  takes the drag for an overlay-driven one and stops moving
                  the dragged project with the pointer. */}
              {dragging && (
                <DragOverlay dropAnimation={null}>
                  <RailDragGhost subject={dragging} projects={projects || []} groups={groups} />
                </DragOverlay>
              )}
            </DndContext>
            {q !== "" && visibleTop.length === 0 && (
              <div className="octo-fade-in px-3.5 py-4 font-serif text-[13px] text-octo-mute">
                Nothing matches
              </div>
            )}
          </div>

          {/* Recently closed (expanded rail only) */}
          {onReopenProject && (
            <RecentlyClosedDrawer projects={closedProjects ?? []} onReopen={onReopenProject} />
          )}
        </>
      )}
      {groupMenu && menuGroup?.scope === "project" && (
        <GroupContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          groupName={menuGroup.name}
          tint={menuGroup.tint}
          holds="projects"
          empty={!(projects || []).some((p) => sectionOfProject.get(p.id) === menuGroup.id)}
          // The slim rail draws no project-group header to rename in.
          onRename={() => {
            if (!isCollapsed) useRailGroupUi.getState().startRename(menuGroup.id);
          }}
          onTint={(tint) => void useGroupsStore.getState().setTint(menuGroup.id, tint)}
          // Offered only where the step shows: an order the pinned-first
          // rule would undo is no step (`stepInRail` answers null for it).
          onMoveUp={sectionUp ? () => onReorderProjects?.(sectionUp) : undefined}
          onMoveDown={sectionDown ? () => onReorderProjects?.(sectionDown) : undefined}
          onUngroup={() => void ungroupProjects(menuGroup.id)}
          onDismiss={closeGroupMenu}
        />
      )}
      {groupMenu && menuGroup?.scope === "workspace" && (
        <GroupContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          groupName={menuGroup.name}
          tint={menuGroup.tint}
          empty={
            !(projects || [])
              .find((p) => p.id === menuGroup.projectId)
              ?.workspaces.some((w) => w?.groupId === menuGroup.id)
          }
          // The slim rail has no room for the inline input.
          onRename={() => {
            if (!isCollapsed) useRailGroupUi.getState().startRename(menuGroup.id);
          }}
          onTint={(tint) => void useGroupsStore.getState().setTint(menuGroup.id, tint)}
          onNewMission={
            onNewWorkspaceInGroup && menuGroup.projectId
              ? () => onNewWorkspaceInGroup(menuGroup.projectId!, menuGroup.id)
              : undefined
          }
          onUngroup={() => void ungroupMissions(menuGroup.id)}
          onDismiss={closeGroupMenu}
        />
      )}
    </aside>
  );
}

/** The rest of the rail under its last block, as a drop target: the ungrouped
 *  area (`TOP_LOOSE_ID`). It draws nothing. */
function TopLooseArea() {
  const { setNodeRef } = useDroppable({
    id: TOP_LOOSE_ID,
    data: { type: "top-loose" } satisfies RailTopData,
  });
  return <div ref={setNodeRef} aria-hidden data-testid="rail-top-loose" className="min-h-4 flex-1" />;
}

/** What follows the pointer while a mission or a group header is dragged. */
function RailDragGhost({
  subject,
  projects,
  groups,
}: {
  subject: RailDragSubject;
  projects: ProjectGroup[];
  groups: Group[];
}) {
  const box =
    "flex h-7 w-[220px] items-center gap-2 rounded border border-octo-hairline bg-octo-panel-2 px-2 shadow-xl";
  if (subject.type === "group") {
    const group = groups.find((g) => g.id === subject.groupId);
    if (!group) return null;
    return (
      <div className={box}>
        <ChevronDown size={12} aria-hidden style={{ color: groupMarkColor(group, "var(--color-octo-mute)") }} />
        <span className="truncate font-mono text-[11px] text-octo-ivory">{group.name}</span>
      </div>
    );
  }
  const ws = projects.flatMap((p) => p?.workspaces || []).find((w) => w?.id === subject.workspaceId);
  if (!ws) return null;
  const mono = resolveMonogram(ws);
  return (
    <div className={box}>
      <span className="font-serif text-[12px] leading-none" style={{ color: TINTS[mono.tint]?.accent }}>
        {mono.glyph}
      </span>
      <span className="truncate text-[13px] text-octo-ivory">{ws.name || "Mission"}</span>
    </div>
  );
}

// ───────────────────────────── shared pieces ─────────────────────────────

/**
 * The reserved identity edge every row and cell carries, so state never
 * shifts content by a pixel. Brass marks the active row; the marching bar
 * marks work (brass on the active row, sage everywhere else — never a status
 * in brass, never the workspace tint); transparent at rest.
 */
function IdentityEdge({ active, running, inset = 0 }: { active: boolean; running: boolean; inset?: number }) {
  if (running) {
    return (
      <span
        aria-hidden
        data-running-bar
        className="rail-bar-running"
        style={
          {
            ["--rail-bar" as string]: active ? "var(--color-octo-brass)" : "var(--color-octo-sage)",
            left: 0,
            width: 2,
            top: inset,
            bottom: inset,
          } as React.CSSProperties
        }
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`absolute left-0 w-[2px] transition-colors duration-[180ms] ${
        active ? "bg-octo-brass" : "bg-transparent"
      }`}
      style={{ top: inset, bottom: inset }}
    />
  );
}

// ───────────────────────────── expanded: project group ─────────────────────────────

/** What stands above a project in the expanded rail, which sets the air (and
 *  the hairline) above its line: nothing (`first`), a project (`next`), its
 *  own group's eyebrow (`section-first`), or the end of a project group, which
 *  a loose project closes with a hairline (`after-section`). */
type ProjectLead = "first" | "next" | "section-first" | "after-section";

const PROJECT_LEAD: Record<ProjectLead, string> = {
  first: "mt-1",
  next: "mt-3",
  "section-first": "mt-0.5",
  "after-section": "mt-0.5 border-t border-octo-hairline pt-2.5",
};

interface SortableProjectGroupProps {
  project: ProjectGroup;
  /** What to show — computed once by the rail (see `VisibleProject`). */
  items: RailItem[];
  lead: ProjectLead;
  /** The project group this project is laid out in, or null for a loose one. */
  sectionId: string | null;
  /** That group's tint, which the hexagon takes when the project has none. */
  sectionTint: TintName | null;
  /** Its project group is folded: the project is out of sight, so nothing
   *  can be dropped on it (the group's header is the target). */
  hidden: boolean;
  /** Folded mission groups by id (the stored state; a filter overrides it). */
  collapsedGroups: Record<string, boolean>;
  /** Set only while folded: the beacon or dot this line carries for the
   *  workspaces it hides. */
  attention: Attention | null;
  /** The same, per folded mission group. */
  groupAttention: Record<string, Attention>;
  /** Missions and group headers can be dragged (the list is whole). */
  groupDragEnabled: boolean;
  dragging: RailDragSubject | null;
  onGroupContextMenu: (groupId: string, x: number, y: number, fromKeyboard?: boolean) => void;
  onNewWorkspaceInGroup?: (projectId: string, groupId: string) => void;
  q: string;
  folded: boolean;
  toggleProjectCollapsed: (projectId: string) => void;
  activeWorkspaceId: string | null;
  gitSummaryByWs?: Record<string, WorkspaceGitSummary>;
  prByWs?: Record<string, Pr | null>;
  runningByWs?: Record<string, boolean>;
  attentionByWs: Record<string, Attention>;
  flagsByWs: Record<string, AttentionFlag>;
  shortcutByWs?: Record<string, string>;
  onSelect: (id: string) => void;
  onCustomize: (id: string) => void;
  onContextMenu?: (workspaceId: string, x: number, y: number) => void;
  onNewWorkspaceForProject?: (projectId: string) => void;
  onProjectContextMenu?: (projectId: string, x: number, y: number, fromKeyboard?: boolean) => void;
  dragEnabled: boolean;
}

function SortableProjectGroup(props: SortableProjectGroupProps) {
  const {
    project, items, lead, sectionId, sectionTint, hidden,
    collapsedGroups, attention, groupAttention, groupDragEnabled, dragging,
    onGroupContextMenu, onNewWorkspaceInGroup,
    q, folded, toggleProjectCollapsed, activeWorkspaceId,
    gitSummaryByWs, prByWs, runningByWs, attentionByWs, flagsByWs, shortcutByWs,
    onSelect, onCustomize, onContextMenu, onNewWorkspaceForProject, onProjectContextMenu,
    dragEnabled,
  } = props;

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: project.id,
      data: { type: "project", sectionId } satisfies RailTopData,
      disabled: { draggable: !dragEnabled, droppable: !dragEnabled || hidden },
    });
  // A translation only (dnd-kit would also scale the block to whatever it is
  // over), and under the pointer even where the list moves nothing: over
  // another group's header or the ungrouped area.
  const shown = useFollowPointer(project.id, isDragging, transform);

  const workspaces = project?.workspaces || [];
  // A project with no group has nothing to drag a mission onto: its rows stay
  // plain, exactly as they were before groups existed.
  const hasGroups = items.some((item) => item.kind === "group");
  const missionDrag = groupDragEnabled && hasGroups;
  // The part of the project that belongs to no group. A mission dropped here
  // leaves its group; a group under the pointer wins (see `railCollisions`).
  const loose = useDroppable({
    id: `loose:${project.id}`,
    data: { type: "loose", projectId: project.id } satisfies RailDropTarget,
    disabled: !missionDrag,
  });

  const renderRow = (ws: Workspace, groupId: string | null) => (
    <WorkspaceRow
      key={ws?.id || `ws-${project.id}`}
      workspace={ws}
      active={ws?.id === activeWorkspaceId}
      q={q}
      grouped={groupId !== null}
      drag={
        missionDrag && ws?.id
          ? { type: "mission", workspaceId: ws.id, projectId: project.id, groupId }
          : null
      }
      ticketKey={ticketKeyFor(ws, project)}
      dirty={gitSummaryByWs?.[ws?.id ?? ""]?.dirty}
      ahead={gitSummaryByWs?.[ws?.id ?? ""]?.ahead}
      behind={gitSummaryByWs?.[ws?.id ?? ""]?.behind}
      hasOpenPr={!!prByWs?.[ws?.id ?? ""]}
      running={!!runningByWs?.[ws?.id ?? ""]}
      attention={attentionByWs[ws?.id ?? ""] ?? null}
      attentionKind={flagsByWs?.[ws?.id ?? ""]?.kind ?? null}
      shortcut={shortcutByWs?.[ws?.id ?? ""] ?? null}
      onSelect={() => ws?.id && onSelect(ws.id)}
      onCustomize={() => ws?.id && onCustomize(ws.id)}
      onContextMenu={onContextMenu && ws?.id ? (x, y) => onContextMenu(ws.id, x, y) : undefined}
    />
  );

  // A live filter forces every project open, so folding is not offered while
  // one is typed: the stored fold state is left exactly as it was.
  const canFold = q === "";
  const lineRef = useRef<HTMLButtonElement | null>(null);
  const hasActive = workspaces.some((w) => w?.id === activeWorkspaceId);
  const dirtyCount = workspaces.filter((w) => gitSummaryByWs?.[w?.id ?? ""]?.dirty).length;
  const openPrCount = workspaces.filter((w) => prByWs?.[w?.id ?? ""]).length;
  const verb = folded ? "Expand" : "Collapse";

  return (
    <div
      ref={setNodeRef}
      data-rail-project={project.id}
      // Dragged, it paints over the blocks it passes.
      className={`flex flex-col ${PROJECT_LEAD[lead]} ${isDragging ? "relative z-10" : ""}`}
      style={{
        transform: shown,
        transition,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      {/* Header — a line of the index: mark, name, then (folded only) the
          aggregates, and the quiet actions revealed on hover/focus. */}
      <div
        className="group/head relative flex h-7 items-center gap-1.5 pl-3.5 pr-2"
        onContextMenu={(e) => {
          e.preventDefault();
          onProjectContextMenu?.(project.id, e.clientX, e.clientY);
        }}
      >
        <button
          ref={lineRef}
          type="button"
          data-rail-project-line={project.id}
          onClick={() => {
            if (canFold) toggleProjectCollapsed(project.id);
          }}
          // The keyboard's way into the project's menu (and so into "Move to
          // group"): ⇧F10 or the context-menu key, opened at the line.
          onKeyDown={(e) => {
            if (!onProjectContextMenu) return;
            if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
            e.preventDefault();
            const r = lineRef.current?.getBoundingClientRect();
            if (r) onProjectContextMenu(project.id, r.left + 24, r.bottom, true);
          }}
          aria-expanded={canFold ? !folded : undefined}
          title={canFold ? `${verb} ${project.name}` : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
        >
          {/* Folded over the beacon's workspace, the mark carries the pulse
              (nearest visible ancestor); the wrapper changes no geometry. */}
          <span
            className={`flex shrink-0 rounded-full ${
              attention === "beacon" ? "rail-beacon animate-attention-pulse" : ""
            }`}
          >
            <ProjectMark size={12} color={projectMarkColor(project.tint, sectionTint)} />
          </span>
          {/* Middle-truncated (E1): projects in one org share their head, so
              the tail is what tells them apart. `flex-1 min-w-0` gives the
              MidTruncate box the definite width it elides into. The button's
              fold title already carries the name; while a filter disables
              folding, the name carries its own. */}
          <span
            data-testid="project-header"
            title={canFold ? undefined : project.name}
            className={`flex min-w-0 flex-1 font-serif text-[13px] leading-none transition-colors duration-[180ms] group-hover/head:text-octo-ivory ${
              hasActive ? "text-octo-ivory" : "text-octo-sage"
            }`}
          >
            <MidTruncate text={project.name} tail={RAIL_NAME_TAIL} />
          </span>
          {attention && <span className="sr-only"> — needs attention</span>}
        </button>

        {/* Aggregates — visible only while folded. Kept mounted so folding
            fades them in rather than popping; while open they take no width
            (the name keeps the line) and are inert. */}
        <span
          aria-hidden={!folded}
          inert={!folded}
          className={`octo-tabular flex shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap font-mono text-[10px] leading-none text-octo-mute transition-[max-width,opacity] duration-[220ms] ${EASE} ${
            folded ? "max-w-[200px] opacity-100" : "pointer-events-none max-w-0 opacity-0"
          }`}
        >
          <span>
            {workspaces.length} {workspaces.length === 1 ? "mission" : "missions"}
          </span>
          {dirtyCount > 0 && (
            <span
              className="flex items-center gap-[3px]"
              title={`${dirtyCount} mission${dirtyCount === 1 ? "" : "s"} with uncommitted changes`}
            >
              <GitCommitHorizontal size={10} aria-hidden />
              {dirtyCount}
            </span>
          )}
          {openPrCount > 0 && (
            <span
              className="flex items-center gap-[3px] text-octo-verdigris"
              title={`${openPrCount} open PR${openPrCount === 1 ? "" : "s"}`}
            >
              <GitPullRequest size={10} aria-hidden />
              {openPrCount}
            </span>
          )}
          {attention === "dot" && (
            <span
              role="img"
              aria-label="Needs your attention"
              title="Needs your attention"
              className="h-[5px] w-[5px] shrink-0 rounded-full bg-octo-brass"
            />
          )}
        </span>

        {/* Hover actions — they take no width until hover/focus reveals them,
            so a long name uses the whole line meanwhile. Clipped while they
            grow, hence the inset focus rings. */}
        <span
          data-testid="project-header-actions"
          className={`flex max-w-0 shrink-0 items-center overflow-hidden opacity-0 transition-[max-width,opacity] duration-[220ms] ${EASE} group-focus-within/head:max-w-[60px] group-focus-within/head:opacity-100 group-hover/head:max-w-[60px] group-hover/head:opacity-100`}
        >
          {onNewWorkspaceForProject && (
            <button
              type="button"
              onClick={() => onNewWorkspaceForProject(project.id)}
              title={`New mission in ${project.name}`}
              aria-label={`New mission in ${project.name}`}
              className={`${ICON_BTN} h-5 w-5 focus-visible:ring-inset`}
            >
              <Plus size={12} aria-hidden />
            </button>
          )}
          {dragEnabled && (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={`Reorder ${project.name}`}
              title="Drag to reorder"
              className={`${ICON_BTN} h-5 w-5 cursor-grab focus-visible:ring-inset active:cursor-grabbing`}
            >
              <GripVertical size={12} aria-hidden />
            </button>
          )}
        </span>
        {/* The chevron is decoration for the pointer: the name button already
            is the one keyboard-reachable fold control, so this adds no second
            tab stop. Hidden while a filter holds every project open. While
            the project is open it takes no width until hover/focus, like the
            actions beside it. */}
        {canFold && (
          <span
            aria-hidden
            data-testid="project-header-chevron"
            className={`flex shrink-0 overflow-hidden transition-[max-width] duration-[220ms] ${EASE} ${
              folded ? "max-w-5" : "max-w-0 group-focus-within/head:max-w-5 group-hover/head:max-w-5"
            }`}
          >
            <span
              onClick={() => toggleProjectCollapsed(project.id)}
              title={`${verb} ${project.name}`}
              className={`${ICON_BTN} h-5 w-5 cursor-pointer ${
                folded ? "opacity-100" : "opacity-0 group-focus-within/head:opacity-100 group-hover/head:opacity-100"
              }`}
            >
              <ChevronDown
                size={12}
                className={`transition-transform duration-[280ms] ${EASE} ${folded ? "-rotate-90" : ""}`}
              />
            </span>
          </span>
        )}
      </div>

      {/* Rows — the grid-rows 0fr↔1fr collapse idiom. The clip wrapper carries
          no padding so a folded project reaches a true 0px. */}
      <div
        aria-hidden={folded}
        inert={folded}
        className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-[280ms] ${EASE}`}
        style={{
          gridTemplateColumns: "minmax(0, 1fr)",
          gridTemplateRows: folded ? "0fr" : "1fr",
          opacity: folded ? 0 : 1,
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div ref={loose.setNodeRef} className="flex flex-col py-0.5">
            {items.map((item) => {
              if (item.kind === "mission") return renderRow(item.workspace, null);
              const { group, members, visible } = item;
              const groupFolded = q === "" && !!collapsedGroups[group.id];
              return (
                <RailMissionGroup
                  key={`group-${group.id}`}
                  group={group}
                  memberCount={members.length}
                  folded={groupFolded}
                  canFold={canFold}
                  q={q}
                  hasOpenPr={members.some((w) => !!prByWs?.[w.id])}
                  holdsActive={members.some((w) => w.id === activeWorkspaceId)}
                  attention={groupFolded ? (groupAttention[group.id] ?? null) : null}
                  dragEnabled={groupDragEnabled}
                  dragging={dragging}
                  hitClassName={HIT_WASH}
                  onToggle={() => useRailGroupUi.getState().toggle(group.id)}
                  onContextMenu={(x, y, fromKeyboard) => onGroupContextMenu(group.id, x, y, fromKeyboard)}
                  onNewMission={
                    onNewWorkspaceInGroup ? () => onNewWorkspaceInGroup(project.id, group.id) : undefined
                  }
                >
                  {visible.map((ws) => renderRow(ws, group.id))}
                </RailMissionGroup>
              );
            })}
            {items.length === 0 && (
              <div className="flex h-8 items-center pl-[42px] pr-3 text-[12px] text-octo-mute">
                No missions yet
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── expanded: row ─────────────────────────────

/** Characters a row's name keeps pinned at its end. Mission names that differ
 *  only at the end — `Production deploy (octopush-api)` / `(octopush-web)`,
 *  `…-flow-8` / `…-flow-9` — stay distinguishable (design-system E1). */
export const RAIL_NAME_TAIL = 14;

/** The width a row's name and meta share at the 280px rail: the row minus its
 *  padding (14 + 12), the 20px monogram and the two 8px gaps. */
const ROW_TEXT_PX = 218;
/** How far a mission group's members are indented (the guide stands in it). */
export const GROUP_INDENT_PX = 14;
/** 13px system sans, rounded up on purpose: an over-estimate only sheds the
 *  ahead/behind rung a little early (it survives in the name's tooltip); an
 *  under-estimate is still caught by the name's middle truncation. */
const NAME_PX_PER_CHAR = 7;
/** 10px JetBrains Mono. */
const META_PX_PER_CHAR = 6;
const META_GAP_PX = 8;
const META_ICON_PX = 11;

export interface RowMeta {
  ticketKey?: string | null;
  ahead?: number;
  behind?: number;
  hasOpenPr?: boolean;
  /** The dirty glyph is shown (not on the active row). */
  dirty?: boolean;
  /** The collision-radar glyph is shown (#732). */
  collision?: boolean;
  dot?: boolean;
}

/** The row's demotion ladder (design-system E2), decided per row because the
 *  rail has a fixed width — what varies is the name, not the band. One rung:
 *  the ahead/behind counts shed before the name loses its tail, and move into
 *  the name's tooltip. Floor: the ticket key, PR, dirty and attention marks. */
export function shedsGitMeta(name: string, meta: RowMeta, textPx: number = ROW_TEXT_PX): boolean {
  const counts = [meta.ahead, meta.behind].filter((n): n is number => !!n);
  if (counts.length === 0) return false;
  const atoms: number[] = [];
  if (meta.ticketKey) atoms.push(meta.ticketKey.length * META_PX_PER_CHAR);
  if (meta.hasOpenPr) atoms.push(META_ICON_PX);
  if (meta.dirty) atoms.push(META_ICON_PX);
  if (meta.collision) atoms.push(META_ICON_PX);
  if (meta.dot) atoms.push(5);
  const floor = atoms.reduce((sum, w) => sum + w + META_GAP_PX, 0);
  // Each count: a 10px arrow, a 2px gap and its digits.
  const rung = counts.reduce(
    (sum, n) => sum + 12 + String(n).length * META_PX_PER_CHAR + META_GAP_PX,
    0,
  );
  return name.length * NAME_PX_PER_CHAR > textPx - floor - rung;
}

function gitCountsLabel(ahead?: number, behind?: number): string {
  return [
    ahead ? `${ahead} commit${ahead === 1 ? "" : "s"} ahead` : null,
    behind ? `${behind} commit${behind === 1 ? "" : "s"} behind` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

interface WorkspaceRowProps {
  workspace: Workspace;
  active: boolean;
  q: string;
  /** The row is a member of a mission group: indented beside the guide. */
  grouped?: boolean;
  /** What dragging this row carries, or null when rows do not drag (a
   *  project with no group, a live filter). */
  drag?: RailDragSubject | null;
  ticketKey?: string | null;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  hasOpenPr?: boolean;
  /** Workspace is actively processing — the identity edge marches. */
  running?: boolean;
  attention: Attention | null;
  attentionKind: string | null;
  shortcut: string | null;
  onSelect: () => void;
  onCustomize: () => void;
  onContextMenu?: (x: number, y: number) => void;
}

function WorkspaceRow({
  workspace,
  active,
  q,
  grouped = false,
  drag = null,
  ticketKey,
  dirty,
  ahead,
  behind,
  hasOpenPr,
  running,
  attention,
  attentionKind,
  shortcut,
  onSelect,
  onCustomize,
  onContextMenu,
}: WorkspaceRowProps) {
  // Hooks must run unconditionally — before any early return (C4). The row's
  // mission posture (missions are 1:1 with code workspaces) is read here as
  // three cheap scalar subscriptions rather than threaded through every layer.
  const missionIntent = useMissionsStore(
    (s) => s.missionByWorkspaceId[workspace?.id ?? ""]?.intent ?? null,
  );
  const missionExec = useMissionsStore(
    (s) => s.missionByWorkspaceId[workspace?.id ?? ""]?.execIsolation ?? null,
  );
  const missionGit = useMissionsStore(
    (s) => s.missionByWorkspaceId[workspace?.id ?? ""]?.gitIsolation ?? null,
  );
  const collisions = useWorkspaceCollisions(workspace?.id);
  // Pointer-only: the row is no extra tab stop, and the keyboard moves a
  // mission through its menu ("Move to group").
  const draggable = useDraggable({
    id: `mission:${workspace?.id ?? ""}`,
    data: drag ?? undefined,
    disabled: !drag,
  });

  if (!workspace) return null;

  let mono: ReturnType<typeof resolveMonogram>;
  let tint: { accent: string; bg: string } | undefined;
  try {
    mono = resolveMonogram(workspace);
    tint = TINTS[mono.tint];
  } catch (e) {
    console.error("Error resolving monogram for workspace:", workspace.id, e);
    return null;
  }

  const name = workspace.name || "Mission";

  // Mission posture rides the monogram's tooltip: the intent word plus the
  // read-only and sandboxed qualifiers. The ContextHeader carries the same
  // posture in full, so the rail spends no glyph slot on it.
  const posture = missionIntent
    ? [
        `${missionIntent} mission`,
        missionGit === "readonly" ? "read-only" : null,
        missionExec === "sandbox" ? "sandboxed" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  const stateSuffix = running
    ? " — working…"
    : attention
      ? ` — needs your attention${attentionKind ? ` (${attentionKind})` : ""}`
      : "";
  const hint = shortcut ? ` (${shortcut})` : "";
  const hit = matchRange(name, q);
  const shedGit = shedsGitMeta(
    name,
    {
      ticketKey,
      ahead,
      behind,
      hasOpenPr,
      dirty: dirty && !active,
      collision: worstSeverity(collisions) !== null,
      dot: attention === "dot",
    },
    grouped ? ROW_TEXT_PX - GROUP_INDENT_PX : ROW_TEXT_PX,
  );
  const shedSuffix = shedGit ? ` · ${gitCountsLabel(ahead, behind)}` : "";

  const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) {
      onContextMenu(e.clientX, e.clientY);
    } else {
      onCustomize();
    }
  };

  return (
    <div
      ref={draggable.setNodeRef}
      onPointerDown={draggable.listeners?.onPointerDown as React.PointerEventHandler<HTMLDivElement> | undefined}
      data-rail-row={grouped ? "member" : "loose"}
      // A member is indented 14px beside its group's guide. The row itself
      // stays full width, so the state edge below remains at the rail's edge.
      className={`group/row octo-fade-in relative flex h-8 items-center gap-2 pr-3 transition-colors duration-[180ms] ${
        grouped ? "pl-7" : "pl-3.5"
      } ${active ? "bg-[var(--brass-ghost)]" : "hover:bg-octo-panel-2"} ${
        draggable.isDragging ? "opacity-40" : ""
      }`}
      onContextMenu={handleContextMenu}
    >
      <IdentityEdge active={active} running={!!running} />

      {/* Monogram — the one carrier of the workspace tint: a bare serif glyph,
          no border, no fill. The single beacon pulses here. */}
      <button
        type="button"
        onClick={onSelect}
        title={posture ?? undefined}
        aria-label={attention ? `${name} — needs attention` : name}
        aria-current={active ? "location" : undefined}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded font-serif text-[12px] leading-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
          attention === "beacon" ? "rail-beacon animate-attention-pulse" : ""
        }`}
        style={{ color: tint?.accent || "var(--color-octo-sage)" }}
      >
        {mono?.glyph || "?"}
      </button>

      {/* Name — a real button (keyboard-operable) that MIDDLE-truncates, so
          the head and the distinguishing tail both stay visible, with the full
          name, any shed git counts, state and jump key as its tooltip. No
          aria-label: its accessible name is the visible text, so the monogram
          stays the single name-labelled control. */}
      <button
        type="button"
        onClick={onSelect}
        title={`${name}${shedSuffix}${stateSuffix}${hint}`}
        className={`flex min-w-0 flex-1 text-left text-[13px] transition-colors duration-[180ms] focus-visible:outline-none ${
          active ? "text-octo-ivory" : "text-octo-sage group-hover/row:text-octo-ivory"
        }`}
      >
        {hit ? (
          <span className="truncate">
            <HighlightedLabel label={name} match={hit} className={HIT_WASH} testId="rail-hit" />
          </span>
        ) : (
          <MidTruncate text={name} tail={RAIL_NAME_TAIL} />
        )}
      </button>

      {/* Meta — unboxed, right-aligned, tabular: ticket · ahead/behind · PR ·
          dirty · collision (#732) · attention. Brass appears here only as the attention dot. The
          ahead/behind pair is the row's one demotion rung (`shedsGitMeta`). */}
      <div className="octo-tabular flex shrink-0 items-center gap-2 font-mono text-[10px] leading-none text-octo-mute">
        {ticketKey && (
          <span className="octo-pop-in text-octo-sage" title={`Linked issue ${ticketKey}`}>
            {ticketKey}
          </span>
        )}
        {(!!ahead || !!behind) && (
          <span
            data-testid="rail-git-rung"
            className={`octo-demote ${shedGit ? "octo-demote-shed" : ""}`}
          >
            {!!ahead && (
              <span
                className="octo-pop-in flex items-center gap-[2px]"
                title={`${ahead} commit${ahead === 1 ? "" : "s"} ahead`}
              >
                <ArrowUp size={10} aria-hidden />
                {ahead}
              </span>
            )}
            {!!behind && (
              <span
                className="octo-pop-in flex items-center gap-[2px]"
                title={`${behind} commit${behind === 1 ? "" : "s"} behind`}
              >
                <ArrowDown size={10} aria-hidden />
                {behind}
              </span>
            )}
          </span>
        )}
        {hasOpenPr && (
          <span
            role="img"
            aria-label="Open pull request"
            title="Open pull request"
            className="octo-pop-in flex text-octo-verdigris"
          >
            <GitPullRequest size={11} aria-hidden />
          </span>
        )}
        {dirty && !active && (
          <span
            role="img"
            aria-label="Uncommitted changes"
            title="Uncommitted changes"
            className="octo-pop-in flex"
          >
            <GitCommitHorizontal size={11} aria-hidden />
          </span>
        )}
        <CollisionMark workspaceId={workspace.id} />
        {attention === "dot" && (
          <span
            role="img"
            aria-label="Needs your attention"
            title="Needs your attention"
            className="octo-pop-in h-[5px] w-[5px] rounded-full bg-octo-brass"
          />
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── collapsed rail ─────────────────────────────

interface CollapsedRailProps {
  projects: ProjectGroup[];
  activeWorkspaceId: string | null;
  onSelect: (id: string) => void;
  onCustomize: (id: string) => void;
  onContextMenu?: (workspaceId: string, x: number, y: number) => void;
  onAddProject?: () => void;
  onProjectContextMenu?: (projectId: string, x: number, y: number) => void;
  gitSummaryByWs?: Record<string, WorkspaceGitSummary>;
  prByWs?: Record<string, Pr | null>;
  runningByWs?: Record<string, boolean>;
  attentionByWs: Record<string, Attention>;
  flagsByWs: Record<string, AttentionFlag>;
  shortcutByWs?: Record<string, string>;
  /** The top level in rail order: loose projects and project groups. */
  topItems: RailTopItem<ProjectGroup>[];
  /** Each project's loose missions and mission groups, in rail order. */
  itemsByProject: Record<string, RailItem[]>;
  collapsedGroups: Record<string, boolean>;
  /** The beacon or dot a folded group's chevron carries. */
  groupAttention: Record<string, Attention>;
  onGroupContextMenu: (groupId: string, x: number, y: number) => void;
}

interface FlyoutAnchor {
  id: string;
  top: number;
  left: number;
}

/**
 * The slim rail: the geometry of Review's collapsed navigator (44px, 32px
 * cells, a reserved identity edge), one cluster per project headed by its mark, and a hover /
 * focus flyout that carries what the width cannot — project, name, status and
 * the jump key. Positioned `fixed` against the measured cell, since the
 * scrolling list would clip an absolutely positioned popover.
 *
 * A mission group keeps its two marks at this width: a 12px chevron in the
 * group's tint (its tooltip is the group's name, and it folds the group) and
 * the 1px guide beside the members' monograms, with 6px of air above and
 * below the group.
 *
 * A project group is a sub-cluster: its projects' clusters stand together
 * between two hairlines that span the rail's width (the short hairline still
 * parts one project from the next, inside a group and outside). There is no
 * room for its name, so each of its projects' marks is titled
 * `group · project`, the flyout's eyebrow starts with the group, and the
 * hexagons take its tint as they do in the expanded rail. It does not fold
 * at this width, like a project.
 */
function CollapsedRail({
  projects,
  activeWorkspaceId,
  onSelect,
  onCustomize,
  onContextMenu,
  onAddProject,
  onProjectContextMenu,
  gitSummaryByWs,
  prByWs,
  runningByWs,
  attentionByWs,
  flagsByWs,
  shortcutByWs,
  topItems,
  itemsByProject,
  collapsedGroups,
  groupAttention,
  onGroupContextMenu,
}: CollapsedRailProps) {
  const [flyout, setFlyout] = useState<FlyoutAnchor | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listRef = useRef<HTMLDivElement | null>(null);
  useScrollActiveIntoView(listRef, activeWorkspaceId, projects);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  }, []);
  const openFlyout = useCallback(
    (id: string, anchor: HTMLElement) => {
      cancelClose();
      const r = anchor.getBoundingClientRect();
      setFlyout({ id, top: r.top - 2, left: r.right + 8 });
    },
    [cancelClose],
  );
  const closeFlyout = useCallback((id: string) => {
    setFlyout((f) => (f?.id === id ? null : f));
  }, []);
  // A short grace window: the pointer crosses 8px of canvas to reach the
  // flyout, and re-entering cancels the close.
  const scheduleClose = useCallback(
    (id: string) => {
      cancelClose();
      closeTimer.current = setTimeout(() => closeFlyout(id), 120);
    },
    [cancelClose, closeFlyout],
  );
  useEffect(() => () => cancelClose(), [cancelClose]);

  const renderCell = (project: ProjectGroup, section: Group | null, ws: Workspace, group: Group | null) => {
    if (!ws?.id) return null;
    return (
      <CollapsedCell
        key={ws.id}
        workspace={ws}
        // Outermost first: project group · project · mission group.
        eyebrow={[section?.name, project?.name || "Project", group?.name].filter(Boolean).join(" · ")}
        active={ws.id === activeWorkspaceId}
        running={!!runningByWs?.[ws.id]}
        attention={attentionByWs[ws.id] ?? null}
        attentionKind={flagsByWs?.[ws.id]?.kind ?? null}
        ticketKey={ticketKeyFor(ws, project)}
        git={gitSummaryByWs?.[ws.id]}
        hasOpenPr={!!prByWs?.[ws.id]}
        shortcut={shortcutByWs?.[ws.id] ?? null}
        flyout={flyout?.id === ws.id ? flyout : null}
        onOpen={openFlyout}
        onScheduleClose={scheduleClose}
        onCancelClose={cancelClose}
        onCloseNow={closeFlyout}
        onSelect={() => onSelect(ws.id)}
        onCustomize={() => onCustomize(ws.id)}
        onContextMenu={onContextMenu ? (x, y) => onContextMenu(ws.id, x, y) : undefined}
      />
    );
  };

  // The top level as runs of clusters: a loose project alone, or a project
  // group's projects together. An empty group has no cluster to draw.
  const blocks = topItems
    .map((item) =>
      item.kind === "project"
        ? { section: null as Group | null, projects: [item.project] }
        : { section: item.group as Group | null, projects: item.projects },
    )
    .filter((block) => block.projects.length > 0);

  const renderCluster = (project: ProjectGroup, section: Group | null, parted: boolean) => {
    const label = [section?.name, project?.name || "Project"].filter(Boolean).join(" · ");
    return (
      <div key={project.id} className="flex w-full flex-col items-center">
        {parted && <div aria-hidden className="my-1 h-px w-5 bg-octo-hairline" />}
        <span
          role="img"
          aria-label={label}
          title={label}
          className="flex h-[18px] items-center"
          onContextMenu={(e) => {
            e.preventDefault();
            onProjectContextMenu?.(project.id, e.clientX, e.clientY);
          }}
        >
          <ProjectMark size={12} color={projectMarkColor(project.tint, section?.tint ?? null)} />
        </span>
        {(itemsByProject[project.id] ?? []).map((item) => {
          if (item.kind === "mission") return renderCell(project, section, item.workspace, null);
          const { group, members } = item;
          const groupFolded = !!collapsedGroups[group.id];
          const carried = groupFolded ? (groupAttention[group.id] ?? null) : null;
          return (
            <div
              key={`group-${group.id}`}
              data-testid={`rail-group-${group.id}`}
              className="my-1.5 flex w-full flex-col items-center"
            >
              <button
                type="button"
                onClick={() => useRailGroupUi.getState().toggle(group.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onGroupContextMenu(group.id, e.clientX, e.clientY);
                }}
                aria-expanded={!groupFolded}
                aria-label={carried ? `${group.name} — needs attention` : group.name}
                title={group.name}
                className="relative flex h-4 w-full items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-octo-brass"
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded ${
                    carried === "beacon" ? "rail-beacon animate-attention-pulse" : ""
                  }`}
                  style={{ color: groupMarkColor(group, "var(--color-octo-mute)") }}
                >
                  <ChevronDown
                    size={12}
                    aria-hidden
                    className={`transition-transform duration-[280ms] ${EASE} ${groupFolded ? "-rotate-90" : ""}`}
                  />
                </span>
                {carried === "dot" && (
                  <span
                    aria-hidden
                    className="octo-pop-in absolute right-[7px] top-[2px] h-[5px] w-[5px] rounded-full bg-octo-brass"
                  />
                )}
              </button>
              <div
                aria-hidden={groupFolded}
                inert={groupFolded}
                className={`grid w-full overflow-hidden transition-[grid-template-rows,opacity] duration-[280ms] ${EASE}`}
                style={{
                  gridTemplateColumns: "minmax(0, 1fr)",
                  gridTemplateRows: groupFolded ? "0fr" : "1fr",
                  opacity: groupFolded ? 0 : 1,
                }}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="relative flex flex-col">
                    {members.map((ws) => renderCell(project, section, ws, group))}
                    {members.length > 0 && (
                      <span
                        aria-hidden
                        data-testid="rail-group-guide"
                        className="pointer-events-none absolute bottom-1 left-[6px] top-1 w-px opacity-50"
                        style={{ backgroundColor: groupMarkColor(group, "var(--color-octo-border-strong)") }}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      <div className="flex h-9 shrink-0 items-center justify-center">
        {onAddProject && (
          <button
            type="button"
            onClick={onAddProject}
            title="Add project"
            aria-label="Add project"
            className={`${ICON_BTN} h-6 w-6`}
          >
            <Plus size={14} aria-hidden />
          </button>
        )}
      </div>
      <div
        ref={listRef}
        className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto pb-2"
        // Scrolling moves the cells out from under a measured flyout, so the
        // flyout goes rather than drifting off its anchor.
        onScroll={() => setFlyout(null)}
      >
        {blocks.map((block, blockIndex) => {
          // A project group's start and end are a hairline across the rail;
          // inside it, and between loose projects, the short one.
          const wide = blockIndex > 0 && (block.section !== null || blocks[blockIndex - 1].section !== null);
          return (
            <div
              key={block.section ? `section-${block.section.id}` : block.projects[0].id}
              data-testid={block.section ? `rail-section-${block.section.id}` : undefined}
              className="flex w-full flex-col items-center"
            >
              {wide && <div aria-hidden data-testid="rail-section-edge" className="my-1 h-px w-full bg-octo-hairline" />}
              {block.projects.map((project, index) =>
                renderCluster(project, block.section, index > 0 || (blockIndex > 0 && !wide)),
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

interface CollapsedCellProps {
  workspace: Workspace;
  /** The flyout's eyebrow: where the workspace sits, outermost first
   *  (`project group · project · mission group`, the groups when it has them). */
  eyebrow: string;
  active: boolean;
  running: boolean;
  attention: Attention | null;
  attentionKind: string | null;
  ticketKey: string | null;
  git?: WorkspaceGitSummary;
  hasOpenPr: boolean;
  shortcut: string | null;
  flyout: FlyoutAnchor | null;
  onOpen: (id: string, anchor: HTMLElement) => void;
  onScheduleClose: (id: string) => void;
  onCancelClose: () => void;
  onCloseNow: (id: string) => void;
  onSelect: () => void;
  onCustomize: () => void;
  onContextMenu?: (x: number, y: number) => void;
}

function CollapsedCell({
  workspace,
  eyebrow,
  active,
  running,
  attention,
  attentionKind,
  ticketKey,
  git,
  hasOpenPr,
  shortcut,
  flyout,
  onOpen,
  onScheduleClose,
  onCancelClose,
  onCloseNow,
  onSelect,
  onCustomize,
  onContextMenu,
}: CollapsedCellProps) {
  const collisions = useWorkspaceCollisions(workspace?.id);
  let mono: ReturnType<typeof resolveMonogram>;
  let tint: { accent: string; bg: string } | undefined;
  try {
    mono = resolveMonogram(workspace);
    tint = TINTS[mono.tint];
  } catch (e) {
    console.error("Error resolving monogram for workspace:", workspace.id, e);
    return null;
  }
  const name = workspace.name || "Mission";
  // The status line says only what is known: "clean" is a statement about a
  // fetched git summary, never a stand-in for one that has not arrived yet.
  const atoms = [
    ticketKey,
    git?.ahead ? `↑${git.ahead}` : null,
    git?.behind ? `↓${git.behind}` : null,
    hasOpenPr ? "PR open" : null,
    git?.dirty ? "uncommitted changes" : null,
    collisionSegment(collisions),
    running ? "working…" : null,
    attention ? `needs your attention${attentionKind ? ` (${attentionKind})` : ""}` : null,
  ].filter(Boolean);
  const status = atoms.length > 0 ? atoms.join(" · ") : git ? "clean" : null;

  const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) {
      onContextMenu(e.clientX, e.clientY);
    } else {
      onCustomize();
    }
  };

  return (
    <div
      className="relative w-full"
      onMouseEnter={(e) => onOpen(workspace.id, e.currentTarget)}
      onMouseLeave={(e) => {
        // A flyout the keyboard opened belongs to the focus, not the pointer:
        // it stays until the cell blurs, however the mouse wanders.
        if (e.currentTarget.contains(document.activeElement)) return;
        onScheduleClose(workspace.id);
      }}
      // Keyboard focus opens the flyout, so keyboard blur has to close it.
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        onCloseNow(workspace.id);
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        onFocus={(e) => onOpen(workspace.id, e.currentTarget)}
        // No native `title`: the flyout opens on the same hover (and on focus)
        // and already carries the name, status and jump key.
        aria-label={attention ? `${name} — needs attention` : name}
        aria-current={active ? "location" : undefined}
        className={`relative flex h-8 w-full items-center justify-center transition-colors duration-[180ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-octo-brass ${
          active ? "bg-[var(--brass-ghost)]" : "hover:bg-octo-panel-2"
        }`}
      >
        <IdentityEdge active={active} running={running} inset={4} />
        <span
          className={`flex h-6 w-6 items-center justify-center rounded font-serif text-[13px] leading-none ${
            attention === "beacon" ? "rail-beacon animate-attention-pulse" : ""
          }`}
          style={{ color: tint?.accent || "var(--color-octo-sage)" }}
        >
          {mono?.glyph || "?"}
        </span>
        {attention === "dot" && (
          <span
            aria-hidden
            className="octo-pop-in absolute right-[7px] top-[6px] h-[5px] w-[5px] rounded-full bg-octo-brass"
          />
        )}
      </button>

      {flyout &&
        createPortal(
        <RailFlyout
          anchor={flyout}
          testId={`rail-flyout-${workspace.id}`}
          onMouseEnter={onCancelClose}
          onMouseLeave={() => onScheduleClose(workspace.id)}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
              {eyebrow}
            </span>
            {shortcut && (
              <span className="shrink-0 font-mono text-[9px] text-octo-mute">{shortcut}</span>
            )}
          </div>
          <div className="mt-1 truncate font-serif text-[13px] text-octo-ivory">{name}</div>
          {status && (
            <div className="octo-tabular mt-1 truncate font-mono text-[10px] text-octo-mute" title={status}>
              {status}
            </div>
          )}
        </RailFlyout>,
        // Portalled out of the rail's scroll container (as MenuSurface is):
        // a wheel over the flyout must not chain into the rail and sweep the
        // flyout away mid-read.
        document.body,
        )}
    </div>
  );
}

/**
 * The flyout panel in the shared menu chrome, portalled to `document.body` and
 * kept inside the viewport: it is measured after mount and pulled up when the
 * cell sits close enough to the window's bottom edge that the panel would run
 * off-screen.
 */
function RailFlyout({
  anchor,
  testId,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  anchor: FlyoutAnchor;
  testId: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const { height } = el.getBoundingClientRect();
    setTop(Math.max(margin, Math.min(anchor.top, window.innerHeight - height - margin)));
  }, [anchor.top]);
  return (
    <div
      ref={ref}
      data-testid={testId}
      className={`${MENU_CHROME} w-[212px] px-3 py-2`}
      style={{ top, left: anchor.left }}
      // The pointer made it across the gap — keep the flyout open.
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  );
}
