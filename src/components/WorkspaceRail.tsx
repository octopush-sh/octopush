import { useState } from "react";
import {
  ChevronDown, GripVertical, Plus, Hammer, Shield,
  GitCommitHorizontal, GitPullRequest, ArrowUp, ArrowDown,
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
import type { Workspace, ProjectInfo, WorkspaceGitSummary, Pr } from "../lib/types";
import { useAttentionStore } from "../stores/attentionStore";
import { useMissionsStore } from "../stores/missionsStore";
import { INTENT_ICON } from "../lib/missionIntent";
import { ProjectMark } from "./icons/ProjectMark";
import { RecentlyClosedDrawer } from "./RecentlyClosedDrawer";

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
  /** Called when the user right-clicks a workspace monogram. */
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
   *  / DIRECT run). When true the row's identity bar animates; mutually
   *  exclusive with the attention pulse. */
  runningByWs?: Record<string, boolean>;
  /** Collapsed state is owned by the parent — the toggle lives in the footer. */
  isCollapsed: boolean;
  /** Persist a new project order (ids top→bottom). */
  onReorderProjects?: (ids: string[]) => void;
}

const COLLAPSE_KEY = "railProjectCollapsed";

/** Per-project collapsed map from localStorage. Absent id ⇒ expanded (§4.6). */
function loadCollapsedFromStorage(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
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
}: Props) {
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(
    loadCollapsedFromStorage,
  );
  const [filter, setFilter] = useState("");
  const q = isCollapsed ? "" : filter.trim().toLowerCase();
  const toggleProjectCollapsed = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch (err) {
        console.error("Failed to persist railProjectCollapsed:", err);
      }
      return next;
    });
  };
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
      className={`flex h-full flex-col items-center border-r border-octo-hairline bg-octo-panel pb-3 pt-9 transition-all duration-[220ms] ${
        isCollapsed ? "w-[50px] gap-1" : "w-[280px] gap-2"
      }`}
      aria-label="Missions"
    >
      <div className={`flex-1 flex flex-col w-full overflow-y-auto ${isCollapsed ? "gap-0.5" : "gap-2"}`}>
        {!isCollapsed && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setFilter(""); }}
            placeholder="Filter projects & missions"
            spellCheck={false}
            aria-label="Filter the rail"
            className="mx-3 mb-1 rounded-md border border-octo-hairline bg-octo-onyx px-2.5 py-1.5 font-mono text-[11px] text-octo-ivory placeholder:text-octo-mute outline-none focus:border-octo-brass"
          />
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={(projects || []).map((p) => p.id)} strategy={verticalListSortingStrategy}>
            {(projects || []).map((project, projectIndex) => {
              // Hide projects with no filter hit (header name or any workspace).
              if (q !== "") {
                const nameMatch = (project?.name ?? "").toLowerCase().includes(q);
                const anyWs = (project?.workspaces || []).some((w) =>
                  (w?.name ?? "").toLowerCase().includes(q),
                );
                if (!nameMatch && !anyWs) return null;
              }
              return (
                <SortableProjectGroup
                  key={project?.id || `project-${projectIndex}`}
                  project={project}
                  projectIndex={projectIndex}
                  projectCount={projects.length}
                  isCollapsed={isCollapsed}
                  q={q}
                  collapsedProjects={collapsedProjects}
                  toggleProjectCollapsed={toggleProjectCollapsed}
                  activeWorkspaceId={activeWorkspaceId}
                  gitSummaryByWs={gitSummaryByWs}
                  prByWs={prByWs}
                  runningByWs={runningByWs}
                  onSelect={onSelect}
                  onCustomize={onCustomize}
                  onContextMenu={onContextMenu}
                  onNewWorkspaceForProject={onNewWorkspaceForProject}
                  onProjectContextMenu={onProjectContextMenu}
                  dragEnabled={dragEnabled}
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </div>

      {/* Recently closed (expanded rail only) */}
      {!isCollapsed && onReopenProject && (
        <RecentlyClosedDrawer
          projects={closedProjects ?? []}
          onReopen={onReopenProject}
        />
      )}

      {/* Add project — kept deliberately quiet (one calm footer action). */}
      {onAddProject && (
        <button
          type="button"
          onClick={onAddProject}
          className="flex w-full items-center justify-center gap-1.5 px-3 py-2 font-mono text-[12px] text-octo-mute transition-colors hover:text-octo-brass"
          title="Add project"
          aria-label="Add project"
        >
          <Plus size={14} className="shrink-0" /> {!isCollapsed && "Add project"}
        </button>
      )}

    </aside>
  );
}

interface SortableProjectGroupProps {
  project: ProjectGroup;
  projectIndex: number;
  projectCount: number;
  isCollapsed: boolean;
  q: string;
  collapsedProjects: Record<string, boolean>;
  toggleProjectCollapsed: (projectId: string) => void;
  activeWorkspaceId: string | null;
  gitSummaryByWs?: Record<string, WorkspaceGitSummary>;
  prByWs?: Record<string, Pr | null>;
  runningByWs?: Record<string, boolean>;
  onSelect: (id: string) => void;
  onCustomize: (id: string) => void;
  onContextMenu?: (workspaceId: string, x: number, y: number) => void;
  onNewWorkspaceForProject?: (projectId: string) => void;
  onProjectContextMenu?: (projectId: string, x: number, y: number) => void;
  dragEnabled: boolean;
}

function SortableProjectGroup(props: SortableProjectGroupProps) {
  const {
    project, projectIndex, projectCount, isCollapsed, q, collapsedProjects,
    toggleProjectCollapsed, activeWorkspaceId, gitSummaryByWs, prByWs, runningByWs,
    onSelect, onCustomize, onContextMenu, onNewWorkspaceForProject, onProjectContextMenu,
    dragEnabled,
  } = props;

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: project.id, disabled: !dragEnabled });

  const nameMatch = q === "" || (project?.name ?? "").toLowerCase().includes(q);
  const visibleWs =
    q === "" || nameMatch
      ? (project?.workspaces || [])
      : (project?.workspaces || []).filter((w) => (w?.name ?? "").toLowerCase().includes(q));
  const projectExpanded = q !== "" ? true : !collapsedProjects[project.id];

  const tint = project.tint ? TINTS[project.tint as keyof typeof TINTS] : TINTS.brass;
  const dirtyCount = (project.workspaces || []).filter((w) => gitSummaryByWs?.[w.id]?.dirty).length;
  const openPrCount = (project.workspaces || []).filter((w) => prByWs?.[w.id]).length;

  // The workspace list — shared by expanded (grouped card) and collapsed modes.
  const wsGrid = (
    <div
      aria-hidden={!isCollapsed && !projectExpanded}
      inert={!isCollapsed && !projectExpanded}
      className="grid overflow-hidden transition-all duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
      style={{
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: isCollapsed || projectExpanded ? "1fr" : "0fr",
        opacity: isCollapsed || projectExpanded ? 1 : 0,
      }}
    >
      {/* Clip wrapper carries NO padding so the grid-rows 0fr collapse reaches a
          true 0px — padding on the grid item itself survives the collapse and
          left a visible "lip" of border below a collapsed project's header. The
          row padding lives on the inner content div instead. */}
      <div className="min-h-0 overflow-hidden">
        <div className={`flex flex-col gap-0.5 ${isCollapsed ? "" : "p-1"}`}>
          {visibleWs.map((ws) => (
            <WorkspaceRow
              key={ws?.id || `ws-${projectIndex}`}
              workspace={ws}
              active={ws?.id === activeWorkspaceId}
              isCollapsed={isCollapsed}
              ticketKey={
                ws?.linkedIssueKey ??
                detectIssueKeyForProject(ws?.branch ?? "", project.jiraProjectKey ?? null)
              }
              dirty={gitSummaryByWs?.[ws?.id ?? ""]?.dirty}
              ahead={gitSummaryByWs?.[ws?.id ?? ""]?.ahead}
              behind={gitSummaryByWs?.[ws?.id ?? ""]?.behind}
              hasOpenPr={!!prByWs?.[ws?.id ?? ""]}
              running={!!runningByWs?.[ws?.id ?? ""]}
              onSelect={() => ws?.id && onSelect(ws.id)}
              onCustomize={() => ws?.id && onCustomize(ws.id)}
              onContextMenu={
                onContextMenu && ws?.id
                  ? (x, y) => onContextMenu(ws.id, x, y)
                  : undefined
              }
            />
          ))}
          {!isCollapsed && visibleWs.length === 0 && (
            <div className="px-3 py-1.5 font-mono text-[10px] tracking-[0.15em] text-octo-mute">
              No missions yet
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      ref={setNodeRef}
      className="flex flex-col"
      style={{
        marginBottom: projectIndex < projectCount - 1 ? (isCollapsed ? "0.5rem" : "0.6rem") : "0",
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      {isCollapsed ? (
        <>
          {/* Separator between project clusters in the slim rail. */}
          {projectIndex > 0 && (
            <div className="flex justify-center my-1">
              <div className="h-[1px] w-5 bg-octo-hairline opacity-60" />
            </div>
          )}
          {wsGrid}
        </>
      ) : (
        // Console grouping: each project is a single-bordered card with a
        // panel-2 header — the boundary the old flat list lacked.
        <div className="overflow-hidden rounded-lg border border-octo-hairline">
          {project?.name && (
            <div
              className="group flex items-center justify-between gap-2 bg-octo-panel-2 px-3 py-2"
              onContextMenu={(e) => {
                e.preventDefault();
                onProjectContextMenu?.(project.id, e.clientX, e.clientY);
              }}
            >
              <div
                data-testid="project-header"
                className="flex min-w-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em]"
                style={{ color: tint.accent }}
              >
                <ProjectMark size={14} className="shrink-0" />
                <span className="truncate">{project.name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {/* Aggregate status — same chip vocabulary as the rows. */}
                {dirtyCount > 0 && (
                  <StatusChip
                    icon={<GitCommitHorizontal size={11} />}
                    label={String(dirtyCount)}
                    tone="sage"
                    title={`${dirtyCount} mission${dirtyCount === 1 ? "" : "s"} with uncommitted changes`}
                  />
                )}
                {openPrCount > 0 && (
                  <StatusChip
                    icon={<GitPullRequest size={11} />}
                    label={String(openPrCount)}
                    tone="verdigris"
                    title={`${openPrCount} open PR${openPrCount === 1 ? "" : "s"}`}
                  />
                )}
                {dragEnabled && (
                  <button
                    type="button"
                    ref={setActivatorNodeRef}
                    {...attributes}
                    {...listeners}
                    aria-label={`Reorder ${project.name}`}
                    title="Drag to reorder"
                    className="flex h-5 w-5 cursor-grab items-center justify-center text-octo-mute opacity-0 outline-none transition-opacity hover:text-octo-brass focus-visible:text-octo-brass focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 active:cursor-grabbing"
                  >
                    <GripVertical size={12} aria-hidden="true" />
                  </button>
                )}
                {onNewWorkspaceForProject && (
                  <button
                    type="button"
                    onClick={() => onNewWorkspaceForProject(project.id)}
                    title={`New mission in ${project.name}`}
                    aria-label={`New mission in ${project.name}`}
                    className="flex h-5 w-5 items-center justify-center text-octo-mute opacity-0 transition-opacity hover:text-octo-brass group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Plus size={12} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => toggleProjectCollapsed(project.id)}
                  aria-expanded={!collapsedProjects[project.id]}
                  aria-label={
                    collapsedProjects[project.id]
                      ? `Expand ${project.name}`
                      : `Collapse ${project.name}`
                  }
                  className="flex h-5 w-5 items-center justify-center text-octo-mute transition hover:text-octo-brass"
                >
                  <ChevronDown
                    size={12}
                    aria-hidden="true"
                    className={`transition-transform duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
                      collapsedProjects[project.id] ? "-rotate-90" : ""
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
          {wsGrid}
        </div>
      )}
    </div>
  );
}

interface WorkspaceRowProps {
  workspace: Workspace;
  active: boolean;
  isCollapsed: boolean;
  ticketKey?: string | null;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  hasOpenPr?: boolean;
  /** Workspace is actively processing — animates the identity bar. */
  running?: boolean;
  onSelect: () => void;
  onCustomize: () => void;
  onContextMenu?: (x: number, y: number) => void;
}

function WorkspaceRow({
  workspace,
  active,
  isCollapsed,
  ticketKey,
  dirty,
  ahead,
  behind,
  hasOpenPr,
  running,
  onSelect,
  onCustomize,
  onContextMenu,
}: WorkspaceRowProps) {
  // Hooks must run unconditionally — before any early return (C4).
  const attentionFlag = useAttentionStore(
    (s) => s.flagsByWs?.[workspace?.id ?? ""],
  );
  // The row's mission posture (missions are 1:1 with code workspaces). Read here
  // — like attentionFlag — rather than threaded through every prop layer. Three
  // cheap scalar subscriptions so the row re-renders only on the field it shows.
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

  // "Needs attention" and "processing" are mutually exclusive: a running
  // workspace shows the marching bar, never the pulse. (A run that pauses or
  // finishes drops `running`, at which point the attention flag may take over.)
  // The suppression only applies in the expanded rail, where the bar exists to
  // replace the pulse — the collapsed rail has no bar, so it keeps pulsing.
  const showPulse = !!attentionFlag && !active && (isCollapsed || !running);

  const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) {
      onContextMenu(e.clientX, e.clientY);
    } else {
      onCustomize();
    }
  };

  if (isCollapsed) {
    // Collapsed mode: a single centered monogram button — the only identity cue
    // when the rail is slim, so the tint background stays here.
    return (
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        title={workspace?.name || "Workspace"}
        aria-label={
          showPulse
            ? `${workspace?.name || "Workspace"} — needs attention`
            : workspace?.name || "Workspace"
        }
        aria-current={active ? "location" : undefined}
        className={`relative flex h-7 w-7 mx-auto items-center justify-center rounded-md border font-serif transition ${
          showPulse ? "animate-attention-pulse" : "octo-fade-in"
        }`}
        style={{
          color: tint?.accent || "var(--color-octo-onyx)",
          borderColor: showPulse
            ? "var(--color-octo-brass)"
            : active
              ? tint?.accent || "transparent"
              : "transparent",
          background: tint?.bg || "transparent",
        }}
      >
        {mono?.glyph || "?"}
      </button>
    );
  }

  // Expanded mode — Console row: tint left edge (brass when active), a neutral
  // monogram, the name, then an aligned status-chip column. Brass marks only
  // the active workspace; git/PR status is sage/verdigris/mute.
  const barColor = active ? "var(--color-octo-brass)" : tint?.accent || "transparent";

  // Mission posture, read at a glance: the intent word, plus read-only and
  // sandboxed qualifiers. Read-only rides the tooltip (the intent glyph already
  // signals it — a second icon would be redundant); sandboxed earns its own
  // Shield because exec isolation is orthogonal to intent (a build mission can
  // be sandboxed too). Mirrors ContextHeader's Shield.
  const sandboxed = missionExec === "sandbox";
  const posture = missionIntent
    ? [
        `${missionIntent} mission`,
        missionGit === "readonly" ? "read-only" : null,
        sandboxed ? "sandboxed" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div
      className={`octo-fade-in group relative flex h-9 items-center gap-2.5 rounded-r-md border-l-[3px] pl-2.5 pr-2 transition-colors duration-[180ms] ${
        active ? "border-octo-brass bg-[var(--brass-ghost)]" : "hover:bg-octo-panel-2"
      }`}
      // While running, the static colored edge is replaced by the marching bar
      // overlay below — hide the border so its solid color doesn't fill the
      // gradient's gaps. Idle/active rendering is unchanged.
      style={
        running
          ? { borderLeftColor: "transparent" }
          : active
            ? undefined
            : { borderLeftColor: tint?.accent || "transparent" }
      }
      onContextMenu={handleContextMenu}
    >
      {/* Processing bar — marches over the identity edge while the workspace
          works. aria-hidden: the running state is conveyed in the name tooltip. */}
      {running && (
        <span
          aria-hidden
          data-running-bar
          className="rail-bar-running"
          style={{ "--rail-bar": barColor } as React.CSSProperties}
        />
      )}

      {/* Monogram (24px, neutral — identity color lives on the row edge) */}
      <button
        type="button"
        onClick={onSelect}
        title={workspace?.name || "Workspace"}
        aria-label={workspace?.name || "Workspace"}
        className={`relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-octo-hairline bg-transparent font-serif text-[12px] transition ${
          showPulse ? "animate-attention-pulse" : ""
        }`}
        style={{
          color: active ? tint?.accent || "var(--color-octo-ivory)" : "var(--color-octo-mute)",
          borderColor: showPulse ? "var(--color-octo-brass)" : "var(--color-octo-hairline)",
        }}
      >
        {mono?.glyph || "?"}
      </button>

      {/* Mission posture — reserved slot so the row never shifts as missions
          load; every code workspace has a mission, so it fills fast. The intent
          glyph carries the tooltip (intent · read-only · sandboxed); a sandboxed
          mission adds a mute Shield, the one posture orthogonal to intent. */}
      <span
        // Fixed two-glyph width, left-aligned: intent glyphs line up across every
        // row (sandboxed or not) and the name column never shifts — not on load,
        // not between a sandboxed row and its neighbours. A lone intent glyph
        // leaves the Shield's slot reserved-but-empty.
        className="flex h-4 w-6 flex-shrink-0 items-center justify-start gap-0.5"
        role={posture ? "img" : undefined}
        aria-label={posture ?? undefined}
        title={posture ?? undefined}
      >
        {missionIntent &&
          (() => {
            const Icon = INTENT_ICON[missionIntent] ?? Hammer;
            return <Icon size={11} aria-hidden className="octo-pop-in text-octo-mute" />;
          })()}
        {sandboxed && (
          <Shield size={10} aria-hidden className="octo-pop-in text-octo-mute" />
        )}
      </span>

      {/* Workspace name — a real button (keyboard-operable) that truncates with
          the full name as its tooltip. No aria-label: its accessible name is the
          visible text, so the monogram stays the single name-labelled control. */}
      <button
        type="button"
        onClick={onSelect}
        title={
          running
            ? `${workspace?.name || "Workspace"} — working…`
            : showPulse
              ? `${workspace?.name || "Workspace"} — needs your attention${attentionFlag?.kind ? ` (${attentionFlag.kind})` : ""}`
              : `${workspace?.name || "Workspace"} (right-click to customize)`
        }
        className="min-w-0 flex-1 cursor-pointer truncate bg-transparent text-left text-[13px] transition"
        style={{ color: active ? "var(--color-octo-ivory)" : "var(--color-octo-sage)" }}
      >
        {workspace?.name || "Workspace"}
      </button>

      {/* Aligned status column (§4.3) — ticket · ahead/behind · PR · dirty. */}
      <div className="flex shrink-0 items-center justify-end gap-1">
        {ticketKey && (
          <StatusChip tone="sage" label={ticketKey} title={`Linked issue ${ticketKey}`} />
        )}
        {!!ahead && (
          <StatusChip icon={<ArrowUp size={11} />} label={String(ahead)} tone="mute" title={`${ahead} commit${ahead === 1 ? "" : "s"} ahead`} />
        )}
        {!!behind && (
          <StatusChip icon={<ArrowDown size={11} />} label={String(behind)} tone="mute" title={`${behind} commit${behind === 1 ? "" : "s"} behind`} />
        )}
        {hasOpenPr && (
          <StatusChip icon={<GitPullRequest size={11} />} tone="verdigris" title="Open pull request" />
        )}
        {dirty && !active && (
          <StatusChip icon={<GitCommitHorizontal size={11} />} tone="sage" title="Uncommitted changes" />
        )}
      </div>
    </div>
  );
}

/** A small status token — icon and/or short label — used identically by the
 *  project header (aggregates) and the workspace rows. Brass is never used
 *  here; it belongs to the active workspace alone. */
function StatusChip({
  icon,
  label,
  tone,
  title,
}: {
  icon?: React.ReactNode;
  label?: string;
  tone: "sage" | "verdigris" | "mute";
  title: string;
}) {
  const toneClass =
    tone === "verdigris"
      ? "border-octo-verdigris/40 text-octo-verdigris"
      : tone === "mute"
        ? "border-octo-hairline text-octo-mute"
        : "border-octo-hairline text-octo-sage";
  return (
    <span
      title={title}
      // Icon-only chips carry no text, so give them an image role + label that
      // screen readers announce; labelled chips are read via their text.
      role={label ? undefined : "img"}
      aria-label={label ? undefined : title}
      className={`octo-pop-in octo-tabular inline-flex items-center gap-[3px] rounded border px-1 py-[1px] font-mono text-[9.5px] leading-none ${toneClass}`}
    >
      {icon}
      {label}
    </span>
  );
}
