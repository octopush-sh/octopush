import { resolveMonogram, TINTS } from "../lib/monogram";
import type { Workspace } from "../lib/types";
import { useAttentionStore } from "../stores/attentionStore";

interface Props {
  workspaces: Workspace[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCustomize: (id: string) => void;
  /** Called when the user right-clicks a workspace monogram. */
  onContextMenu?: (workspaceId: string, x: number, y: number) => void;
  onNewWorkspace: () => void;
}

export function WorkspaceRail({
  workspaces,
  activeId,
  onSelect,
  onCustomize,
  onContextMenu,
  onNewWorkspace,
}: Props) {
  return (
    <aside
      className="flex h-full w-12 flex-col items-center gap-2 border-r border-octo-hairline bg-octo-panel pb-3 pt-9"
      aria-label="Workspaces"
    >
      {workspaces.map((ws) => (
        <MonogramButton
          key={ws.id}
          workspace={ws}
          active={ws.id === activeId}
          onSelect={() => onSelect(ws.id)}
          onCustomize={() => onCustomize(ws.id)}
          onContextMenu={
            onContextMenu
              ? (x, y) => onContextMenu(ws.id, x, y)
              : undefined
          }
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
  onContextMenu,
}: {
  workspace: Workspace;
  active: boolean;
  onSelect: () => void;
  onCustomize: () => void;
  onContextMenu?: (x: number, y: number) => void;
}) {
  const mono = resolveMonogram(workspace);
  const tint = TINTS[mono.tint];
  const attentionFlag = useAttentionStore(
    (s) => s.flagsByWs[workspace.id],
  );
  // Hide the pulse when this workspace IS the active one — the flag is
  // cleared on the next render but for the single render between
  // ping-then-focus we don't want to show a stale dot.
  const showPulse = !!attentionFlag && !active;

  return (
    <div
      className={`relative flex items-center pl-[6px] border-l-2 ${
        active ? "border-octo-brass" : "border-transparent"
      }`}
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
        // When a workspace is asking for attention, we pulse the
        // monogram itself (brass border + halo) instead of a small
        // dot offset from the corner — that dot was hard to associate
        // unambiguously with one specific monogram when monograms sit
        // close together. Pulsing the whole tile makes the source
        // obvious.
        className={`relative flex h-7 w-7 items-center justify-center rounded-md border font-serif transition ${
          showPulse ? "animate-attention-pulse" : ""
        }`}
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
    </div>
  );
}
