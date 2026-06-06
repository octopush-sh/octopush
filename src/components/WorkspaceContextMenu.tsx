import {
  FolderOpen,
  Copy,
  GitBranch,
  PanelsTopLeft,
  SquareTerminal,
  Pencil,
  Link2,
  Link2Off,
  Trash2,
} from "lucide-react";
import { useMenuChrome } from "../lib/useMenuChrome";

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
  onDelete: () => void;
  /** Dismiss the menu. */
  onClose: () => void;
  linkageKind?: "linked" | "unlinked";
  onLinkJira?: () => void;
  onChangeJira?: () => void;
  onUnlinkJira?: () => void;
}

const ITEM =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass";
const DANGER =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost,rgba(209,139,139,0.08))] hover:text-octo-rouge";
const SEP = "h-px bg-octo-hairline";

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
  onDelete,
  onClose,
  linkageKind,
  onLinkJira,
  onChangeJira,
  onUnlinkJira,
}: Props) {
  const { ref, pos } = useMenuChrome(x, y, onClose);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Workspace actions"
      className="absolute z-50 w-[230px] rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="truncate px-3 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
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

      <button type="button" role="menuitem" className={ITEM} onClick={run(onCustomize)}>
        <Pencil size={12} className="shrink-0" /> Customize…
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
          <button type="button" role="menuitem" className={DANGER} onClick={run(onDelete)}>
            <Trash2 size={12} className="shrink-0" /> Delete workspace…
          </button>
        </>
      )}
    </div>
  );
}
