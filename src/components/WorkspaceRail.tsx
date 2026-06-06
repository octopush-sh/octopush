import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { resolveMonogram, TINTS } from "../lib/monogram";
import { detectIssueKeyForProject } from "../lib/detectIssueKey";
import type { Workspace, ProjectInfo, WorkspaceGitSummary } from "../lib/types";
import { useAttentionStore } from "../stores/attentionStore";
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
  /** Collapsed state is owned by the parent — the toggle lives in the footer. */
  isCollapsed: boolean;
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
  isCollapsed,
}: Props) {
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(
    loadCollapsedFromStorage,
  );
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
  return (
    <aside
      className={`flex h-full flex-col items-center border-r border-octo-hairline bg-octo-panel pb-3 pt-9 transition-all duration-[220ms] ${
        isCollapsed ? "w-[50px] gap-1" : "w-[280px] gap-2"
      }`}
      aria-label="Workspaces"
    >
      <div className={`flex-1 flex flex-col w-full overflow-y-auto ${isCollapsed ? "gap-0.5" : "gap-2"}`}>
        {(projects || []).map((project, projectIndex) => (
          <div key={project?.id || `project-${projectIndex}`} className={`flex flex-col ${isCollapsed ? "gap-1" : "gap-1"}`} style={{ marginBottom: isCollapsed && projectIndex < projects.length - 1 ? '0.5rem' : !isCollapsed && projectIndex < projects.length - 1 ? '0.75rem' : '0' }}>
            {/* Project header (only when expanded) */}
            {!isCollapsed && project?.name && (() => {
              const tint = project.tint ? TINTS[project.tint as keyof typeof TINTS] : TINTS.brass;
              const dirtyCount = (project.workspaces || []).filter(
                (w) => gitSummaryByWs?.[w.id]?.dirty,
              ).length;
              return (
              <div
                className="flex items-center justify-between gap-2 px-3 group"
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (onProjectContextMenu) {
                    onProjectContextMenu(project.id, e.clientX, e.clientY);
                  }
                }}
              >
                <div
                  data-testid="project-header"
                  className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em]"
                  style={{ color: tint.accent }}
                >
                  <ProjectMark size={15} className="shrink-0" />
                  {project.name}
                </div>
                <div className="flex items-center gap-1">
                  {/* Git pulse: brass count when work is uncommitted, else a
                      quiet verdigris all-clear dot (§4.2). */}
                  {dirtyCount > 0 ? (
                    <span
                      className="flex items-center gap-1 font-mono text-[10px] text-octo-brass"
                      title={`${dirtyCount} workspace${dirtyCount === 1 ? "" : "s"} with uncommitted changes`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-octo-brass" />
                      {dirtyCount}
                    </span>
                  ) : (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-octo-verdigris opacity-40"
                      title="All workspaces clean"
                    />
                  )}
                  {onNewWorkspaceForProject && (
                    <button
                      type="button"
                      onClick={() => onNewWorkspaceForProject(project.id)}
                      title={`New workspace in ${project.name}`}
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center h-5 w-5 text-xs text-octo-mute hover:text-octo-brass"
                    >
                      +
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
                    className="flex items-center justify-center h-5 w-5 text-[10px] text-octo-mute hover:text-octo-brass transition"
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
            );
            })()}

            {/* Project separator (only when collapsed, not on first project) */}
            {isCollapsed && projectIndex > 0 && (
              <div className="flex justify-center my-1">
                <div className="h-[1px] w-5 bg-octo-hairline opacity-60" />
              </div>
            )}

            {/* Workspaces in this project */}
            {(isCollapsed || !collapsedProjects[project.id]) &&
              (project?.workspaces || []).map((ws) => (
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
                onSelect={() => ws?.id && onSelect(ws.id)}
                onCustomize={() => ws?.id && onCustomize(ws.id)}
                onContextMenu={
                  onContextMenu && ws?.id
                    ? (x, y) => onContextMenu(ws.id, x, y)
                    : undefined
                }
              />
            ))}

            {/* Empty project (expanded rail, expanded project, no workspaces). */}
            {!isCollapsed &&
              !collapsedProjects[project.id] &&
              (project?.workspaces || []).length === 0 && (
                <div className="px-3 py-1.5 font-mono text-[10px] tracking-[0.15em] text-octo-mute">
                  No workspaces yet
                </div>
              )}
          </div>
        ))}
      </div>

      {/* Recently closed (expanded rail only) */}
      {!isCollapsed && onReopenProject && (
        <RecentlyClosedDrawer
          projects={closedProjects ?? []}
          onReopen={onReopenProject}
        />
      )}

      {/* Add project button */}
      {onAddProject && (
        <button
          type="button"
          onClick={onAddProject}
          className="w-full flex justify-center items-center gap-2 px-3 py-2 text-octo-mute hover:text-octo-brass transition font-mono text-sm"
          title="Add project"
          aria-label="Add project"
        >
          ◉ {!isCollapsed && "Add project"}
        </button>
      )}

    </aside>
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
  onSelect,
  onCustomize,
  onContextMenu,
}: WorkspaceRowProps) {
  // Hooks must run unconditionally — before any early return (C4).
  const attentionFlag = useAttentionStore(
    (s) => s.flagsByWs?.[workspace?.id ?? ""],
  );
  const [showFadeOut, setShowFadeOut] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!workspace) return null;

  let mono: ReturnType<typeof resolveMonogram>;
  let tint: any;
  try {
    mono = resolveMonogram(workspace);
    tint = TINTS[mono.tint];
  } catch (e) {
    console.error("Error resolving monogram for workspace:", workspace.id, e);
    return null;
  }

  const showPulse = !!attentionFlag && !active;

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setShowFadeOut(true);
    }, 500);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setShowFadeOut(false);
  };

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
    // Collapsed mode: simple centered button
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
          showPulse ? "animate-attention-pulse" : ""
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

  // Expanded mode
  return (
    <div
      className={`group relative flex h-11 items-center gap-2 border-l-2 px-3 transition-all duration-[220ms] ${
        active ? "border-octo-brass bg-octo-panel-2" : "border-transparent hover:bg-octo-panel-2"
      }`}
      onContextMenu={handleContextMenu}
    >
      {/* Monogram (24px) */}
      <button
        type="button"
        onClick={onSelect}
        title={workspace?.name || "Workspace"}
        aria-label={workspace?.name || "Workspace"}
        className={`relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border bg-transparent font-serif transition ${
          showPulse ? "animate-attention-pulse" : ""
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

      {/* Workspace name container with fade-out gradient */}
      <div
        className="relative flex-1 overflow-hidden"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          onClick={onSelect}
          title={
            showPulse
              ? `${workspace?.name || "Workspace"} — needs your attention${attentionFlag?.kind ? ` (${attentionFlag.kind})` : ""}`
              : `${workspace?.name || "Workspace"} (right-click to customize)`
          }
          className="truncate text-left text-sm transition cursor-pointer"
          style={{
            color: active ? "var(--color-octo-ivory)" : "var(--color-octo-sage)",
          }}
        >
          {workspace?.name || "Workspace"}
        </div>

        {/* Fade-out gradient */}
        <div
          className={`pointer-events-none absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-octo-onyx to-transparent transition-opacity duration-[220ms] ${
            showFadeOut ? "opacity-100" : "opacity-0"
          }`}
          style={{
            transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.3, 1)",
          }}
        />
      </div>

      {/* Trailing signal: ticket key · ahead/behind · dirty · active (§4.3) */}
      {ticketKey && (
        <span className="flex-shrink-0 font-mono text-[10px] text-octo-sage">
          {ticketKey}
        </span>
      )}
      {!!ahead && (
        <span className="flex-shrink-0 font-mono text-[10px] text-octo-mute">↑{ahead}</span>
      )}
      {!!behind && (
        <span className="flex-shrink-0 font-mono text-[10px] text-octo-mute">↓{behind}</span>
      )}
      {dirty && !active && (
        <div
          className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-octo-brass"
          title="Uncommitted changes"
        />
      )}
      {active && (
        <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-octo-brass" />
      )}
    </div>
  );
}
