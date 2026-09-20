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
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { resolveMonogram, TINTS } from "../lib/monogram";
import { detectIssueKeyForProject } from "../lib/detectIssueKey";
import { MENU_CHROME } from "../lib/menuStyles";
import type { Workspace, ProjectInfo, WorkspaceGitSummary, Pr } from "../lib/types";
import { useAttentionStore, type AttentionFlag } from "../stores/attentionStore";
import { useMissionsStore } from "../stores/missionsStore";
import { ProjectMark } from "./icons/ProjectMark";
import { HighlightedLabel, matchRange } from "./primitives/HighlightedLabel";
import { RecentlyClosedDrawer } from "./RecentlyClosedDrawer";

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
 *  - Collapsed, the rail is the Run session rail's geometry (44px, 32px
 *    cells, reserved edge) with a hover flyout for project · name · status.
 */

/** Hierarchical project/workspace structure for the rail. */
export interface ProjectGroup {
  id: string;
  name: string;
  tint?: string;
  jiraProjectKey?: string | null;
  workspaces: Workspace[];
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
  /** Called when user clicks to add a new project. */
  onAddProject?: () => void;
  /** Called when user right-clicks on a project header. */
  onProjectContextMenu?: (projectId: string, x: number, y: number) => void;
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

/** The linked ticket, or one detected from the branch under the project's key. */
function ticketKeyFor(ws: Workspace, project: ProjectGroup): string | null {
  return ws?.linkedIssueKey ?? detectIssueKeyForProject(ws?.branch ?? "", project?.jiraProjectKey ?? null);
}

/** A project and the rows it shows: all of them at rest or on a project-name
 *  hit, only the hits otherwise; a project with nothing to show leaves the rail. */
interface VisibleProject {
  project: ProjectGroup;
  visibleWs: Workspace[];
}

export function WorkspaceRail({
  projects,
  activeWorkspaceId,
  onSelect,
  onCustomize,
  onContextMenu,
  onNewWorkspaceForProject,
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
  const visibleProjects = useMemo<VisibleProject[]>(() => {
    const out: VisibleProject[] = [];
    for (const project of projects || []) {
      const workspaces = project?.workspaces || [];
      if (q === "" || matchRange(project?.name ?? "", q)) {
        out.push({ project, visibleWs: workspaces });
        continue;
      }
      const hits = workspaces.filter((w) => matchRange(w?.name ?? "", q) !== null);
      if (hits.length > 0) out.push({ project, visibleWs: hits });
    }
    return out;
  }, [projects, q]);

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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const dragEnabled = !isCollapsed && q === "" && !!onReorderProjects;
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = (projects || []).map((p) => p.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorderProjects?.(next);
  };

  return (
    <aside
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
        />
      ) : (
        <>
          {/* The head — one quiet line: a borderless search whose bottom hairline
              turns brass on focus, and the one "Add project" icon button. */}
          <div className="flex h-9 shrink-0 items-center gap-1.5 pl-3.5 pr-2">
            <label
              className="flex h-[26px] min-w-0 flex-1 items-center gap-2 border-b border-transparent text-octo-mute transition-colors duration-[220ms] focus-within:border-octo-brass focus-within:text-octo-brass"
              title="Find a project or mission"
            >
              <Search size={12} aria-hidden className="shrink-0" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setFilter("");
                }}
                placeholder="Find a project or mission"
                spellCheck={false}
                aria-label="Find a project or mission"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
              />
            </label>
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

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext
                items={visibleProjects.map(({ project }) => project.id)}
                strategy={verticalListSortingStrategy}
              >
                {visibleProjects.map(({ project, visibleWs }, projectIndex) => (
                  <SortableProjectGroup
                    key={project?.id || `project-${projectIndex}`}
                    project={project}
                    visibleWs={visibleWs}
                    projectIndex={projectIndex}
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
                ))}
              </SortableContext>
            </DndContext>
            {q !== "" && visibleProjects.length === 0 && (
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
    </aside>
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

interface SortableProjectGroupProps {
  project: ProjectGroup;
  /** The rows to show — computed once by the rail (see `VisibleProject`). */
  visibleWs: Workspace[];
  projectIndex: number;
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
  onProjectContextMenu?: (projectId: string, x: number, y: number) => void;
  dragEnabled: boolean;
}

function SortableProjectGroup(props: SortableProjectGroupProps) {
  const {
    project, visibleWs, projectIndex, q, folded, toggleProjectCollapsed, activeWorkspaceId,
    gitSummaryByWs, prByWs, runningByWs, attentionByWs, flagsByWs, shortcutByWs,
    onSelect, onCustomize, onContextMenu, onNewWorkspaceForProject, onProjectContextMenu,
    dragEnabled,
  } = props;

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: project.id, disabled: !dragEnabled });

  const workspaces = project?.workspaces || [];

  // A live filter forces every project open, so folding is not offered while
  // one is typed: the stored fold state is left exactly as it was.
  const canFold = q === "";
  // The project's own tint colours its mark only when the user chose one; an
  // untinted project stays mute, so N projects never mean N brass hexagons.
  const projectTint = project.tint ? TINTS[project.tint as keyof typeof TINTS] : undefined;
  const hasActive = workspaces.some((w) => w?.id === activeWorkspaceId);
  const dirtyCount = workspaces.filter((w) => gitSummaryByWs?.[w?.id ?? ""]?.dirty).length;
  const openPrCount = workspaces.filter((w) => prByWs?.[w?.id ?? ""]).length;
  const verb = folded ? "Expand" : "Collapse";

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col ${projectIndex === 0 ? "mt-1" : "mt-3"}`}
      style={{
        transform: CSS.Transform.toString(transform),
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
          type="button"
          onClick={() => {
            if (canFold) toggleProjectCollapsed(project.id);
          }}
          aria-expanded={canFold ? !folded : undefined}
          title={canFold ? `${verb} ${project.name}` : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
        >
          <ProjectMark
            size={12}
            className="shrink-0"
            color={projectTint?.accent ?? "var(--color-octo-mute)"}
          />
          <span
            data-testid="project-header"
            className={`truncate font-serif text-[13px] leading-none transition-colors duration-[180ms] group-hover/head:text-octo-ivory ${
              hasActive ? "text-octo-ivory" : "text-octo-sage"
            }`}
          >
            {project.name}
          </span>
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
        </span>

        <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-[180ms] group-focus-within/head:opacity-100 group-hover/head:opacity-100">
          {onNewWorkspaceForProject && (
            <button
              type="button"
              onClick={() => onNewWorkspaceForProject(project.id)}
              title={`New mission in ${project.name}`}
              aria-label={`New mission in ${project.name}`}
              className={`${ICON_BTN} h-5 w-5`}
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
              className={`${ICON_BTN} h-5 w-5 cursor-grab active:cursor-grabbing`}
            >
              <GripVertical size={12} aria-hidden />
            </button>
          )}
        </span>
        {/* The chevron is decoration for the pointer: the name button already
            is the one keyboard-reachable fold control, so this adds no second
            tab stop. Hidden while a filter holds every project open. */}
        {canFold && (
          <span
            aria-hidden
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
          <div className="flex flex-col py-0.5">
            {visibleWs.map((ws) => (
              <WorkspaceRow
                key={ws?.id || `ws-${projectIndex}`}
                workspace={ws}
                active={ws?.id === activeWorkspaceId}
                q={q}
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
                onContextMenu={
                  onContextMenu && ws?.id ? (x, y) => onContextMenu(ws.id, x, y) : undefined
                }
              />
            ))}
            {visibleWs.length === 0 && (
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

interface WorkspaceRowProps {
  workspace: Workspace;
  active: boolean;
  q: string;
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
      className={`group/row octo-fade-in relative flex h-8 items-center gap-2 pl-3.5 pr-3 transition-colors duration-[180ms] ${
        active ? "bg-[var(--brass-ghost)]" : "hover:bg-octo-panel-2"
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

      {/* Name — a real button (keyboard-operable) that truncates with the full
          name, state and jump key as its tooltip. No aria-label: its accessible
          name is the visible text, so the monogram stays the single
          name-labelled control. */}
      <button
        type="button"
        onClick={onSelect}
        title={`${name}${stateSuffix}${hint}`}
        className={`min-w-0 flex-1 truncate text-left text-[13px] transition-colors duration-[180ms] focus-visible:outline-none ${
          active ? "text-octo-ivory" : "text-octo-sage group-hover/row:text-octo-ivory"
        }`}
      >
        {hit ? <HighlightedLabel label={name} match={hit} className={HIT_WASH} testId="rail-hit" /> : name}
      </button>

      {/* Meta — unboxed, right-aligned, tabular: ticket · ahead/behind · PR ·
          dirty · attention. Brass appears here only as the attention dot. */}
      <div className="octo-tabular flex shrink-0 items-center gap-2 font-mono text-[10px] leading-none text-octo-mute">
        {ticketKey && (
          <span className="octo-pop-in text-octo-sage" title={`Linked issue ${ticketKey}`}>
            {ticketKey}
          </span>
        )}
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
}

interface FlyoutAnchor {
  id: string;
  top: number;
  left: number;
}

/**
 * The slim rail: the Run session rail's geometry (44px, 32px cells, a reserved
 * identity edge), one cluster per project headed by its mark, and a hover /
 * focus flyout that carries what the width cannot — project, name, status and
 * the jump key. Positioned `fixed` against the measured cell, since the
 * scrolling list would clip an absolutely positioned popover.
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
}: CollapsedRailProps) {
  const [flyout, setFlyout] = useState<FlyoutAnchor | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
        className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto pb-2"
        // Scrolling moves the cells out from under a measured flyout, so the
        // flyout goes rather than drifting off its anchor.
        onScroll={() => setFlyout(null)}
      >
        {projects.map((project, projectIndex) => {
          const projectTint = project?.tint ? TINTS[project.tint as keyof typeof TINTS] : undefined;
          return (
            <div key={project?.id || `project-${projectIndex}`} className="flex w-full flex-col items-center">
              {projectIndex > 0 && <div aria-hidden className="my-1 h-px w-5 bg-octo-hairline" />}
              <span
                role="img"
                aria-label={project?.name || "Project"}
                title={project?.name || "Project"}
                className="flex h-[18px] items-center"
                onContextMenu={(e) => {
                  e.preventDefault();
                  onProjectContextMenu?.(project.id, e.clientX, e.clientY);
                }}
              >
                <ProjectMark size={12} color={projectTint?.accent ?? "var(--color-octo-mute)"} />
              </span>
              {(project?.workspaces || []).map((ws) => {
                if (!ws?.id) return null;
                return (
                  <CollapsedCell
                    key={ws.id}
                    workspace={ws}
                    projectName={project?.name || "Project"}
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
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

interface CollapsedCellProps {
  workspace: Workspace;
  projectName: string;
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
  projectName,
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
              {projectName}
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
