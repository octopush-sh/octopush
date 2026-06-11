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
} from "lucide-react";
import { MenuSurface } from "./MenuSurface";
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

      {linkageKind && (
        <>
          <div className={SEP} />
          {linkageKind === "unlinked" && onLinkJira && (
            <button type="button" role="menuitem" className={ITEM} onClick={run(onLinkJira)}>
              <Link2 size={12} className="shrink-0" /> Link Jira ticket…
            </button>
          )}
          {linkageKind === "linked" && onChangeJira && (
            <button type="button" role="menuitem" className={ITEM} onClick={run(onChangeJira)}>
              <Link2 size={12} className="shrink-0" /> Change Jira ticket…
            </button>
          )}
          {linkageKind === "linked" && onUnlinkJira && (
            <button type="button" role="menuitem" className={ITEM} onClick={run(onUnlinkJira)}>
              <Link2Off size={12} className="shrink-0" /> Unlink Jira ticket
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
