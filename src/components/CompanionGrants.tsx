import { useEffect, useState } from "react";
import { FolderPen, FolderSearch, SquareTerminal, X } from "lucide-react";
import { ipc, type TalkGrant } from "../lib/ipc";
import { useChatStore } from "../stores/chatStore";

const ICON = { read: FolderSearch, write: FolderPen, command: SquareTerminal } as const;

/** What a grant lets the conversation do, as its title says it. Pure. */
export function grantTitle(g: TalkGrant): string {
  if (g.kind === "read") return `Commands read in ${g.shown} without asking`;
  if (g.kind === "write") return `The file tools write in ${g.shown} without asking`;
  return `Runs without asking: ${g.shown}`;
}

/**
 * The Conversation section's "allowed" row (#1229): the grants the open
 * conversation holds, each kept from an approval card, with a revoke button
 * (its next call asks again). Re-read on a thread change and when a card
 * keeps one (`chat://grants-changed`); hidden when there is none.
 */
export function CompanionGrants({ workspaceId }: { workspaceId?: string }) {
  const threadId = useChatStore((s) => (workspaceId ? (s.activeThreadByWs[workspaceId] ?? null) : null));
  const [held, setHeld] = useState<{ threadId: string; grants: TalkGrant[] } | null>(null);

  useEffect(() => {
    if (!threadId) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const load = () =>
      void ipc
        .listThreadGrants(threadId)
        .then((grants) => !disposed && setHeld({ threadId, grants }))
        .catch(() => {});
    load();
    void ipc
      .onGrantsChanged((t) => t === threadId && load())
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [threadId]);

  // A list read for another conversation is never shown in this one.
  const grants = held && held.threadId === threadId ? held.grants : [];
  if (!threadId || grants.length === 0) return null;
  const revoke = (g: TalkGrant) =>
    void ipc
      .revokeThreadGrant(threadId, g)
      .then((rest) => setHeld({ threadId, grants: rest }))
      .catch(() => {});
  return (
    <div className="octo-rise-in mt-3 flex flex-wrap items-center gap-x-3 gap-y-1" data-tour="companion-grants" data-testid="companion-grants">
      <span
        className="text-octo-sage"
        title="What this conversation may do without asking, each allowed from an approval card. A credentials location always asks, and none of these applies in Plan only."
      >
        allowed
      </span>
      {grants.map((g) => {
        const Icon = ICON[g.kind];
        return (
          <span key={`${g.kind}:${g.value}`} className="octo-fade-in flex min-w-0 items-center gap-1 text-[10px]" title={grantTitle(g)}>
            <Icon size={10} aria-hidden className="shrink-0 text-octo-mute" />
            <span className="max-w-[14rem] truncate font-mono text-octo-ivory">{g.shown}</span>
            <button
              type="button"
              onClick={() => revoke(g)}
              title="Revoke: it asks again"
              aria-label={`Revoke: ${grantTitle(g)}`}
              className="-mr-1 rounded p-0.5 text-octo-mute transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)] hover:bg-[var(--brass-ghost)] hover:text-octo-rouge focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              <X size={9} aria-hidden />
            </button>
          </span>
        );
      })}
    </div>
  );
}
