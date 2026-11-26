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
  FolderPlus,
  GitMerge,
} from "lucide-react";
import { MenuSurface } from "./MenuSurface";
import { MoveToGroupItem, type MoveTargetGroup } from "./MoveToGroupItem";
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
  /** How many missions say "merged · archive?" (#963). "Archive merged
   *  missions…" is drawn only while there is one and `onArchiveMerged` is given;
   *  it opens a confirm that lists them. */
  mergedCount?: number;
  onArchiveMerged?: () => void;
  /** "New mission group": create an empty mission group (a folder for this
   *  project's missions; its name opens in edit). Never labelled plain "New
   *  group": in this menu that phrase belongs to "Move to group", which
   *  groups the project itself. */
  onNewGroup?: () => void;
  /** The project groups this project may join, in rail order. "Move to
   *  group" is drawn when `onMoveToGroup` and `onNewProjectGroup` are given. */
  projectGroups?: MoveTargetGroup[];
  /** The project group this project is in (shown checked), or null. */
  projectGroupId?: string | null;
  onMoveToGroup?: (groupId: string) => void;
  /** "Move to group › New group…": create a project group that already holds
   *  this project (its name opens in edit). */
  onNewProjectGroup?: () => void;
  onRemoveFromGroup?: () => void;
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
  mergedCount = 0,
  onArchiveMerged,
  onNewGroup,
  projectGroups,
  projectGroupId,
  onMoveToGroup,
  onNewProjectGroup,
  onRemoveFromGroup,
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

      <div className={SEP} />

      {/* Where the project stands in the rail: its group, pin and place.
          "Move to group" is about PROJECT groups: "New group…" in it makes a
          group that already holds this project. */}
      {onMoveToGroup && onNewProjectGroup && (
        <MoveToGroupItem
          groups={projectGroups ?? []}
          currentGroupId={projectGroupId ?? null}
          onMove={(id) => run(() => onMoveToGroup(id))()}
          onNewGroup={run(onNewProjectGroup)}
          onRemoveFromGroup={projectGroupId && onRemoveFromGroup ? run(onRemoveFromGroup) : undefined}
        />
      )}
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

      {/* The project's missions. A mission group is made here, named for what
          it is and a block away from "Move to group", so the two group
          actions cannot be taken for one another. */}
      {onNewGroup && (
        <button type="button" role="menuitem" className={ITEM} onClick={run(onNewGroup)}>
          <FolderPlus size={12} className="shrink-0" /> New mission group
        </button>
      )}
      <button type="button" role="menuitem" className={ITEM} onClick={run(onViewArchived)}>
        <Archive size={12} className="shrink-0" /> Archived workspaces…
      </button>
      {onArchiveMerged && mergedCount > 0 && (
        <button type="button" role="menuitem" className={ITEM} onClick={run(onArchiveMerged)}>
          <GitMerge size={12} className="shrink-0" />
          <span className="flex-1 text-left">Archive merged missions…</span>
          <span className="octo-tabular text-octo-mute">{mergedCount}</span>
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
