import { resolveMonogram, TINTS } from "../lib/monogram";
import type { Workspace } from "../lib/types";

interface Props {
  workspaces: Workspace[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCustomize: (id: string) => void;
  onNewWorkspace: () => void;
}

export function WorkspaceRail({
  workspaces,
  activeId,
  onSelect,
  onCustomize,
  onNewWorkspace,
}: Props) {
  return (
    <aside
      className="flex h-full w-12 flex-col items-center gap-2 border-r border-octo-hairline bg-octo-panel py-3"
      aria-label="Workspaces"
    >
      {workspaces.map((ws) => (
        <MonogramButton
          key={ws.id}
          workspace={ws}
          active={ws.id === activeId}
          onSelect={() => onSelect(ws.id)}
          onCustomize={() => onCustomize(ws.id)}
        />
      ))}
      <button
        type="button"
        onClick={onNewWorkspace}
        title="New workspace (⌘N)"
        aria-label="New workspace"
        className="mt-1 flex h-6 w-6 items-center justify-center rounded-md border border-dashed border-octo-hairline font-mono text-sm text-octo-mute transition hover:border-octo-brass hover:text-octo-brass"
      >
        +
      </button>
    </aside>
  );
}

function MonogramButton({
  workspace,
  active,
  onSelect,
  onCustomize,
}: {
  workspace: Workspace;
  active: boolean;
  onSelect: () => void;
  onCustomize: () => void;
}) {
  const mono = resolveMonogram(workspace);
  const tint = TINTS[mono.tint];

  return (
    <div className="relative">
      {active && (
        <span
          aria-hidden
          className="absolute -left-3 top-1/2 h-6 w-[2px] -translate-y-1/2 rounded-r-sm bg-octo-brass"
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          onCustomize();
        }}
        title={`${workspace.name} (right-click to customize)`}
        aria-label={workspace.name}
        aria-current={active ? "true" : undefined}
        className="flex h-7 w-7 items-center justify-center rounded-md border font-serif italic transition"
        style={{
          color: tint.accent,
          borderColor: active ? tint.accent : "transparent",
          background: active ? tint.bg : "transparent",
        }}
      >
        {mono.glyph}
      </button>
    </div>
  );
}
