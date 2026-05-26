import { useState, useRef, useEffect } from "react";
import { resolveMonogram, TINTS } from "../lib/monogram";
import type { Workspace } from "../lib/types";
import { useAttentionStore } from "../stores/attentionStore";

/** Hierarchical project/workspace structure for the rail. */
export interface ProjectGroup {
  id: string;
  name: string;
  workspaces: Workspace[];
}

interface Props {
  projects: ProjectGroup[];
  activeWorkspaceId: string | null;
  onSelect: (id: string) => void;
  onCustomize: (id: string) => void;
  /** Called when the user right-clicks a workspace monogram. */
  onContextMenu?: (workspaceId: string, x: number, y: number) => void;
  onNewWorkspace: () => void;
  /** Called when user clicks to create a workspace for a specific project. */
  onNewWorkspaceForProject?: (projectId: string) => void;
  /** Called when user clicks to add a new project. */
  onAddProject?: () => void;
  /** Called when user right-clicks on a project header. */
  onProjectContextMenu?: (projectId: string, x: number, y: number) => void;
}

export function WorkspaceRail({
  projects,
  activeWorkspaceId,
  onSelect,
  onCustomize,
  onContextMenu,
  onNewWorkspace,
  onNewWorkspaceForProject,
  onAddProject,
  onProjectContextMenu,
}: Props) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <aside
      className={`flex h-full flex-col items-center gap-2 border-r border-octo-hairline bg-octo-panel pb-3 pt-9 transition-all duration-[220ms] ${
        isCollapsed ? "w-[50px]" : "w-[280px]"
      }`}
      aria-label="Workspaces"
    >
      <div className="flex-1 flex flex-col gap-2 w-full overflow-y-auto">
        {(projects || []).map((project, projectIndex) => (
          <div key={project?.id || `project-${projectIndex}`} className="flex flex-col gap-1" style={{ marginBottom: projectIndex < projects.length - 1 ? '0.75rem' : '0' }}>
            {/* Project header (only when expanded) */}
            {!isCollapsed && project?.name && (
              <div
                className="flex items-center justify-between gap-2 px-3 group"
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (onProjectContextMenu) {
                    onProjectContextMenu(project.id, e.clientX, e.clientY);
                  }
                }}
              >
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
                  — {project.name}
                </div>
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
              </div>
            )}

            {/* Project separator (only when collapsed, not on first project) */}
            {isCollapsed && projectIndex > 0 && (
              <div className="flex justify-center">
                <div className="h-[1px] w-6 bg-octo-hairline opacity-50" />
              </div>
            )}

            {/* Workspaces in this project */}
            {(project?.workspaces || []).map((ws) => (
              <WorkspaceRow
                key={ws?.id || `ws-${projectIndex}`}
                workspace={ws}
                active={ws?.id === activeWorkspaceId}
                isCollapsed={isCollapsed}
                onSelect={() => ws?.id && onSelect(ws.id)}
                onCustomize={() => ws?.id && onCustomize(ws.id)}
                onContextMenu={
                  onContextMenu && ws?.id
                    ? (x, y) => onContextMenu(ws.id, x, y)
                    : undefined
                }
              />
            ))}
          </div>
        ))}
      </div>

      {/* Add project button */}
      {onAddProject && (
        <button
          type="button"
          onClick={onAddProject}
          className={`w-full flex ${isCollapsed ? "justify-center" : ""} items-center gap-2 px-3 py-2 text-octo-mute hover:text-octo-brass transition font-mono text-sm`}
          title="Add project"
          aria-label="Add project"
        >
          ◉ {!isCollapsed && "Add project"}
        </button>
      )}

      {/* New workspace button */}
      <button
        type="button"
        onClick={onNewWorkspace}
        title="New workspace (⌘N)"
        aria-label="New workspace"
        className="flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-octo-hairline font-mono text-base text-octo-mute transition hover:border-octo-brass hover:text-octo-brass"
      >
        +
      </button>

      {/* Toggle button at bottom */}
      <button
        type="button"
        onClick={() => setIsCollapsed(!isCollapsed)}
        title={`${isCollapsed ? "Expand" : "Collapse"} workspace rail`}
        aria-label={`${isCollapsed ? "Expand" : "Collapse"} workspace rail`}
        className={`w-full border border-octo-hairline text-octo-mute transition hover:border-octo-brass hover:text-octo-sage ${
          isCollapsed ? "px-1" : "px-3"
        } py-1 text-center font-mono text-[11px]`}
      >
        {isCollapsed ? "▲" : "▼ Collapse"}
      </button>
    </aside>
  );
}

interface WorkspaceRowProps {
  workspace: Workspace;
  active: boolean;
  isCollapsed: boolean;
  onSelect: () => void;
  onCustomize: () => void;
  onContextMenu?: (x: number, y: number) => void;
}

function WorkspaceRow({
  workspace,
  active,
  isCollapsed,
  onSelect,
  onCustomize,
  onContextMenu,
}: WorkspaceRowProps) {
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

  const attentionFlag = useAttentionStore(
    (s) => s.flagsByWs?.[workspace.id],
  );
  const showPulse = !!attentionFlag && !active;

  const [showFadeOut, setShowFadeOut] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

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

  if (isCollapsed) {
    // Collapsed mode: 32px monogram only
    return (
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          if (onContextMenu) {
            onContextMenu(e.clientX, e.clientY);
          } else {
            onCustomize();
          }
        }}
        title={workspace?.name || "Workspace"}
        aria-label={
          showPulse
            ? `${workspace?.name || "Workspace"} — needs attention`
            : workspace?.name || "Workspace"
        }
        aria-current={active ? "location" : undefined}
        className={`relative flex h-8 w-8 items-center justify-center rounded-md border font-serif transition ${
          showPulse ? "animate-attention-pulse" : ""
        }`}
        style={{
          color: tint?.accent || "var(--color-octo-onyx)",
          borderColor: showPulse
            ? "var(--color-octo-brass)"
            : active
              ? tint?.accent || "transparent"
              : "transparent",
          background: active && tint ? tint.bg : "transparent",
        }}
      >
        {mono?.glyph || "?"}
      </button>
    );
  }

  // Expanded mode
  const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    if (onContextMenu) {
      onContextMenu(e.clientX, e.clientY);
    } else {
      onCustomize();
    }
  };

  return (
    <div
      className={`group relative flex h-11 items-center gap-2 border-l-2 px-3 transition-all duration-[220ms] ${
        active ? "border-octo-brass bg-octo-panel-2" : "border-transparent hover:bg-octo-panel-2"
      }`}
    >
      {/* Monogram (24px) */}
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={handleContextMenu}
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
          onContextMenu={handleContextMenu}
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

      {/* Active dot (6px, brass, visible only when active) */}
      {active && (
        <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-octo-brass" />
      )}
    </div>
  );
}
