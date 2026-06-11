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
import { MenuSurface } from "./MenuSurface";
import { MENU_DANGER_MULTILINE, MENU_HEADER, MENU_ITEM, MENU_SEP } from "../lib/menuStyles";

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
  onViewArchived: () => void;
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

const ITEM = MENU_ITEM;
// Two-line danger rows (label + muted hint).
const DANGER = MENU_DANGER_MULTILINE;
const SEP = MENU_SEP;

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
  onViewArchived,
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
  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };

  return (
    <MenuSurface x={x} y={y} ariaLabel="Project actions" onDismiss={onDismiss} widthClass="w-[244px]">
      <div className={MENU_HEADER}>
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
      <button type="button" role="menuitem" className={ITEM} onClick={run(onViewArchived)}>
        <Archive size={12} className="shrink-0" /> Archived workspaces…
      </button>

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
    </MenuSurface>
  );
}
