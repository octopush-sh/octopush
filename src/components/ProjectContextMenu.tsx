import {
  FolderOpen,
  Copy,
  PanelsTopLeft,
  SquareTerminal,
  Pencil,
  Palette,
  Link2,
  Archive,
  Trash2,
  Pin,
  PinOff,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { useMenuChrome } from "../lib/useMenuChrome";

interface Props {
  projectId: string;
  projectName: string;
  x: number;
  y: number;
  onRevealInFinder: () => void;
  onCopyPath: () => void;
  onOpenInEditor: () => void;
  onOpenInTerminal: () => void;
  onRename: () => void;
  onChangeTint: () => void;
  onSetJiraProjectKey?: () => void;
  pinned: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onTogglePin: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onClose: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}

const ITEM =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass";
const DANGER =
  "flex w-full items-start gap-2 px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost)] hover:text-octo-rouge";
const SEP = "h-px bg-octo-hairline";

export function ProjectContextMenu({
  projectId: _projectId,
  projectName,
  x,
  y,
  onRevealInFinder,
  onCopyPath,
  onOpenInEditor,
  onOpenInTerminal,
  onRename,
  onChangeTint,
  onSetJiraProjectKey,
  pinned,
  canMoveUp,
  canMoveDown,
  onTogglePin,
  onMoveUp,
  onMoveDown,
  onClose,
  onDelete,
  onDismiss,
}: Props) {
  const { ref, pos } = useMenuChrome(x, y, onDismiss);
  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Project actions"
      className="absolute z-50 w-[244px] rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="truncate px-3 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
        {projectName}
      </div>

      <button type="button" role="menuitem" className={ITEM} onClick={run(onRevealInFinder)}>
        <FolderOpen size={12} className="shrink-0" /> Reveal in Finder
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onCopyPath)}>
        <Copy size={12} className="shrink-0" /> Copy path
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onOpenInEditor)}>
        <PanelsTopLeft size={12} className="shrink-0" /> Open in editor
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onOpenInTerminal)}>
        <SquareTerminal size={12} className="shrink-0" /> Open in terminal
      </button>

      <div className={SEP} />

      <button type="button" role="menuitem" className={ITEM} onClick={run(onRename)}>
        <Pencil size={12} className="shrink-0" /> Rename project
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onChangeTint)}>
        <Palette size={12} className="shrink-0" /> Change tint
      </button>
      {onSetJiraProjectKey && (
        <button type="button" role="menuitem" className={ITEM} onClick={run(onSetJiraProjectKey)}>
          <Link2 size={12} className="shrink-0" /> Set Jira project key…
        </button>
      )}

      <div className={SEP} />

      <button type="button" role="menuitem" className={ITEM} onClick={run(onTogglePin)}>
        {pinned ? <PinOff size={12} className="shrink-0" /> : <Pin size={12} className="shrink-0" />}
        {pinned ? "Unpin" : "Pin to top"}
      </button>
      {canMoveUp && (
        <button type="button" role="menuitem" className={ITEM} onClick={run(onMoveUp)}>
          <ChevronUp size={12} className="shrink-0" /> Move up
        </button>
      )}
      {canMoveDown && (
        <button type="button" role="menuitem" className={ITEM} onClick={run(onMoveDown)}>
          <ChevronDown size={12} className="shrink-0" /> Move down
        </button>
      )}

      <div className={SEP} />

      <button type="button" role="menuitem" className={DANGER} onClick={run(onClose)}>
        <Archive size={12} className="mt-0.5 shrink-0" />
        <span className="flex flex-col text-left">
          <span>Close project</span>
          <span className="text-octo-mute">Restore it later from Recently closed</span>
        </span>
      </button>
      <button type="button" role="menuitem" className={DANGER} onClick={run(onDelete)}>
        <Trash2 size={12} className="mt-0.5 shrink-0" />
        <span className="flex flex-col text-left">
          <span>Delete from disk…</span>
          <span className="text-octo-mute">Removes the folder permanently</span>
        </span>
      </button>
    </div>
  );
}
