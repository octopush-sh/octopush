import { useState, useEffect } from "react";
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
}

export function WorkspaceRail({
  projects,
  activeWorkspaceId,
  onSelect,
  onCustomize,
  onContextMenu,
  onNewWorkspace,
}: Props) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Listen for ⌘\ keyboard shortcut to toggle collapse
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setIsCollapsed((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <aside
      className={`flex h-full flex-col items-center gap-2 border-r border-octo-hairline bg-octo-panel pb-3 pt-9 transition-all duration-[220ms] ${
        isCollapsed ? "w-[50px]" : "w-[280px]"
      }`}
      aria-label="Workspaces"
    >
      <div className="flex-1 flex flex-col gap-2 w-full overflow-y-auto">
        {projects.map((project, projectIndex) => (
          <div key={project.id} className="flex flex-col gap-2">
            {/* Project header (only when expanded) */}
            {!isCollapsed && (
              <div className="px-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
                — {project.name}
              </div>
            )}

            {/* Project separator (only when collapsed, not on first project) */}
            {isCollapsed && projectIndex > 0 && (
              <div className="flex justify-center">
                <div className="h-[1px] w-6 bg-octo-hairline opacity-50" />
              </div>
            )}

            {/* Workspaces in this project */}
            {project.workspaces.map((ws) => (
              <WorkspaceRow
                key={ws.id}
                workspace={ws}
                active={ws.id === activeWorkspaceId}
                isCollapsed={isCollapsed}
                onSelect={() => onSelect(ws.id)}
                onCustomize={() => onCustomize(ws.id)}
                onContextMenu={
                  onContextMenu
                    ? (x, y) => onContextMenu(ws.id, x, y)
                    : undefined
                }
              />
            ))}
          </div>
        ))}
      </div>

      {/* New workspace button */}
      <button
        type="button"
        onClick={onNewWorkspace}
        title="New workspace (⌘N)"
        aria-label="New workspace"
        className="flex h-6 w-6 items-center justify-center rounded-md border border-dashed border-octo-hairline font-mono text-sm text-octo-mute transition hover:border-octo-brass hover:text-octo-brass"
      >
        +
      </button>

      {/* Toggle button at bottom */}
      <button
        type="button"
        onClick={() => setIsCollapsed(!isCollapsed)}
        title={`${isCollapsed ? "Expand" : "Collapse"} workspace rail (⌘\\)`}
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
  const mono = resolveMonogram(workspace);
  const tint = TINTS[mono.tint];
  const attentionFlag = useAttentionStore(
    (s) => s.flagsByWs[workspace.id],
  );
  const showPulse = !!attentionFlag && !active;

  return (
    <div
      className={`relative flex items-center ${
        isCollapsed ? "justify-center" : "px-3"
      } border-l-2 ${active ? "border-octo-brass" : "border-transparent"}`}
    >
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
        title={
          showPulse
            ? `${workspace.name} — needs your attention (${attentionFlag.kind})`
            : `${workspace.name} (right-click to customize)`
        }
        aria-label={
          showPulse
            ? `${workspace.name} — needs attention`
            : workspace.name
        }
        aria-current={active ? "location" : undefined}
        className={`relative flex h-7 w-7 items-center justify-center rounded-md border font-serif transition ${
          showPulse ? "animate-attention-pulse" : ""
        } ${!isCollapsed ? "flex-shrink-0" : ""}`}
        style={{
          color: tint.accent,
          borderColor: showPulse
            ? "var(--color-octo-brass)"
            : active
              ? tint.accent
              : "transparent",
          background: showPulse
            ? "var(--brass-ghost)"
            : active
              ? tint.bg
              : "transparent",
        }}
      >
        {mono.glyph}
      </button>
      {/* Workspace name (only when expanded) */}
      {!isCollapsed && (
        <div className="ml-3 flex-1 text-left">
          <span className="text-sm text-octo-ivory">{workspace.name}</span>
        </div>
      )}
    </div>
  );
}

