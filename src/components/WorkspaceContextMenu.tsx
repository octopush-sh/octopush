import { useEffect, useRef } from "react";
import { Pencil, Trash2, Link2, Link2Off } from "lucide-react";

interface Props {
  x: number;
  y: number;
  workspaceName: string;
  onCustomize: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Whether this workspace has a Jira ticket linked, is unlinked, or has been dismissed. */
  linkageKind?: "linked" | "unlinked" | "dismissed";
  onLinkJira?: () => void;
  onChangeJira?: () => void;
  onUnlinkJira?: () => void;
  onSkipJira?: () => void;
}

export function WorkspaceContextMenu({
  x,
  y,
  workspaceName: _workspaceName,
  onCustomize,
  onDelete,
  onClose,
  linkageKind,
  onLinkJira,
  onChangeJira,
  onUnlinkJira,
  onSkipJira,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Close on outside click (capture phase so it fires before bubbling)
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      // Ignore right-click (button 2) to allow context menu to fire
      if (e.button === 2) return;
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [onClose]);

  const showJiraItems = linkageKind !== undefined;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Workspace actions"
      className="absolute z-50 w-[200px] rounded-md border border-octo-hairline bg-octo-panel shadow-2xl"
      style={{ left: x, top: y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCustomize();
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded-t-md px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
      >
        <Pencil size={12} className="shrink-0" />
        Customize…
      </button>

      {showJiraItems && (
        <>
          <div className="h-px bg-octo-hairline" />

          {(linkageKind === "unlinked" || linkageKind === "dismissed") && onLinkJira && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onLinkJira();
                onClose();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
            >
              <Link2 size={12} className="shrink-0" />
              Link Jira ticket…
            </button>
          )}

          {linkageKind === "linked" && onChangeJira && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onChangeJira();
                onClose();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
            >
              <Link2 size={12} className="shrink-0" />
              Change Jira ticket…
            </button>
          )}

          {linkageKind === "linked" && onUnlinkJira && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onUnlinkJira();
                onClose();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
            >
              <Link2Off size={12} className="shrink-0" />
              Unlink Jira ticket
            </button>
          )}

          {linkageKind !== "dismissed" && onSkipJira && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onSkipJira();
                onClose();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
            >
              <Link2Off size={12} className="shrink-0" />
              Skip Jira here
            </button>
          )}
        </>
      )}

      <div className="h-px bg-octo-hairline" />

      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onDelete();
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded-b-md px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost,rgba(209,139,139,0.08))] hover:text-octo-rouge"
      >
        <Trash2 size={12} className="shrink-0" />
        Delete workspace
      </button>
    </div>
  );
}
