import {
  FolderOpen,
  Copy,
  GitBranch,
  PanelsTopLeft,
  SquareTerminal,
  Pencil,
  Palette,
  Archive,
  Link2,
  Link2Off,
  Trash2,
  Hourglass,
} from "lucide-react";
import { MenuSurface } from "./MenuSurface";
import { MoveToGroupItem, type MoveTargetGroup } from "./MoveToGroupItem";
import {
  MENU_DANGER,
  MENU_HEADER,
  MENU_ITEM,
  MENU_ITEM_MULTILINE,
  MENU_SEP,
} from "../lib/menuStyles";

interface Props {
  x: number;
  y: number;
  workspaceName: string;
  ticketKey?: string | null;
  /** True for the project's main worktree — Delete is hidden (C6). */
  isMain: boolean;
  onRevealInFinder: () => void;
  onCopyPath: () => void;
  onCopyBranch: () => void;
  onOpenInEditor: () => void;
  onOpenInTerminal: () => void;
  onCustomize: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** Dismiss the menu. */
  onClose: () => void;
  linkageKind?: "linked" | "unlinked";
  onLinkJira?: () => void;
  onChangeJira?: () => void;
  onUnlinkJira?: () => void;
  /** What the link items name: "Jira ticket" (default) or "Epiku story". */
  ticketNoun?: string;
  /** Mission groups. "Move to group ›" shows when `onMoveToGroup` and
   *  `onNewGroup` are wired: `groups` are the groups of this workspace's
   *  project and `groupId` the one it is in. */
  groups?: MoveTargetGroup[];
  groupId?: string | null;
  onMoveToGroup?: (groupId: string) => void;
  onNewGroup?: () => void;
  onRemoveFromGroup?: () => void;
  /** "Start after…" (#960): opens the dialog that makes this mission wait. */
  onStartAfter?: () => void;
}

const ITEM = MENU_ITEM;
const ITEM_MULTILINE = MENU_ITEM_MULTILINE;
const DANGER = MENU_DANGER;
const SEP = MENU_SEP;

export function WorkspaceContextMenu({
  x,
  y,
  workspaceName,
  ticketKey,
  isMain,
  onRevealInFinder,
  onCopyPath,
  onCopyBranch,
  onOpenInEditor,
  onOpenInTerminal,
  onCustomize,
  onRename,
  onArchive,
  onDelete,
  onClose,
  linkageKind,
  onLinkJira,
  onChangeJira,
  onUnlinkJira,
  ticketNoun = "Jira ticket",
  groups,
  groupId,
  onMoveToGroup,
  onNewGroup,
  onRemoveFromGroup,
  onStartAfter,
}: Props) {
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <MenuSurface x={x} y={y} ariaLabel="Workspace actions" onDismiss={onClose} widthClass="w-[230px]">
      <div className={MENU_HEADER}>
        {workspaceName}
        {ticketKey ? ` · ${ticketKey}` : ""}
      </div>

      <button type="button" role="menuitem" className={ITEM} onClick={run(onRevealInFinder)}>
        <FolderOpen size={12} className="shrink-0" /> Reveal in Finder
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onCopyPath)}>
        <Copy size={12} className="shrink-0" /> Copy path
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onCopyBranch)}>
        <GitBranch size={12} className="shrink-0" /> Copy branch name
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onOpenInEditor)}>
        <PanelsTopLeft size={12} className="shrink-0" /> Open in editor
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onOpenInTerminal)}>
        <SquareTerminal size={12} className="shrink-0" /> Open in terminal
      </button>

      <div className={SEP} />

      <button type="button" role="menuitem" className={ITEM} onClick={run(onRename)}>
        <Pencil size={12} className="shrink-0" /> Rename workspace…
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onCustomize)}>
        <Palette size={12} className="shrink-0" /> Customize…
      </button>
      {onMoveToGroup && onNewGroup && (
        <MoveToGroupItem
          groups={groups ?? []}
          currentGroupId={groupId ?? null}
          onMove={(id) => run(() => onMoveToGroup(id))()}
          onNewGroup={run(onNewGroup)}
          onRemoveFromGroup={groupId && onRemoveFromGroup ? run(onRemoveFromGroup) : undefined}
        />
      )}
      {onStartAfter && (
        <button type="button" role="menuitem" data-tour="rail-menu-start-after" className={ITEM} onClick={run(onStartAfter)}>
          <Hourglass size={12} className="shrink-0" /> Start after…
        </button>
      )}

      {linkageKind && (
        <>
          <div className={SEP} />
          {linkageKind === "unlinked" && onLinkJira && (
            <button type="button" role="menuitem" className={ITEM} onClick={run(onLinkJira)}>
              <Link2 size={12} className="shrink-0" /> Link {ticketNoun}…
            </button>
          )}
          {linkageKind === "linked" && onChangeJira && (
            <button type="button" role="menuitem" className={ITEM} onClick={run(onChangeJira)}>
              <Link2 size={12} className="shrink-0" /> Change {ticketNoun}…
            </button>
          )}
          {linkageKind === "linked" && onUnlinkJira && (
            <button type="button" role="menuitem" className={ITEM} onClick={run(onUnlinkJira)}>
              <Link2Off size={12} className="shrink-0" /> Unlink {ticketNoun}
            </button>
          )}
        </>
      )}

      {!isMain && (
        <>
          <div className={SEP} />
          <button type="button" role="menuitem" className={ITEM_MULTILINE} onClick={run(onArchive)}>
            <Archive size={12} className="mt-0.5 shrink-0" />
            <span className="flex flex-col text-left">
              <span>Archive workspace</span>
              <span className="text-octo-mute">Keeps the branch; removes the worktree</span>
            </span>
          </button>
          <button type="button" role="menuitem" className={DANGER} onClick={run(onDelete)}>
            <Trash2 size={12} className="shrink-0" /> Delete workspace…
          </button>
        </>
      )}
    </MenuSurface>
  );
}
