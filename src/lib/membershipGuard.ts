// Keeps a group-membership change (a project's or workspace's `groupId`) from
// being undone by a list reload that read the database before the change
// landed. Membership rides on the rows `projectStore` and `workspaceStore`
// reload on focus, on a project switch and after many actions, and those
// reloads replace the rows wholesale.
//
// The rule: a reload that STARTED before a change settled cannot know about
// it, so its rows are overlaid with the change. A reload that started after
// the change settled read the truth and is trusted. One logical clock orders
// the two; nothing here depends on wall time. The overlay is applied when the
// rows are COMMITTED to the store, not when they are read: a batch reload
// commits after its slowest read, and a change can start, settle or be
// refused in between.
//
// This module holds no store and imports none, so both the loaders and
// `groupsStore` can use it without an import cycle.

import type { GroupScope } from "./types";

interface Change {
  groupId: string | null;
  /** Clock value when the backend confirmed it; null while still in flight. */
  settledAt: number | null;
}

let clock = 0;
const changes = new Map<string, Change>();
const loadsInFlight = new Set<number>();

const keyOf = (kind: GroupScope, itemId: string) => `${kind}:${itemId}`;

/** Forget settled changes no reload in flight could still contradict. */
function prune() {
  const oldestLoad = loadsInFlight.size > 0 ? Math.min(...loadsInFlight) : Infinity;
  for (const [key, change] of changes) {
    if (change.settledAt !== null && change.settledAt < oldestLoad) changes.delete(key);
  }
}

/** A handle on one membership change, from the optimistic patch to the
 *  backend's answer. */
export interface MembershipChange {
  /** The backend confirmed it. */
  settle: () => void;
  /** The backend refused it (or it was abandoned): stop protecting it. */
  drop: () => void;
}

/** Record that `itemIds` are being moved to `groupId` (null: out of any
 *  group). Call before the backend request; settle or drop it afterwards. A
 *  newer change to the same item replaces an older one. */
export function beginMembershipChange(
  kind: GroupScope,
  itemIds: string[],
  groupId: string | null,
): MembershipChange {
  const mine = itemIds.map((id) => {
    const change: Change = { groupId, settledAt: null };
    changes.set(keyOf(kind, id), change);
    return [keyOf(kind, id), change] as const;
  });
  return {
    settle: () => {
      const at = ++clock;
      for (const [, change] of mine) change.settledAt = at;
      prune();
    },
    drop: () => {
      for (const [key, change] of mine) if (changes.get(key) === change) changes.delete(key);
    },
  };
}

/** A reload of project or workspace rows, from before its first read to its
 *  commit into a store. */
export interface MembershipLoad {
  /** The rows as they must be committed: every membership change this reload
   *  could have missed is laid over them. Call it in the same synchronous
   *  step that writes the rows to the store. An overlay applied earlier (when
   *  one of several reads resolves, say) is stale by the commit: a move that
   *  starts in between would be undone, and one refused in between would come
   *  back. */
  overlay: <T extends { id: string; groupId?: string | null }>(rows: T[]) => T[];
  /** The reload is over, committed or failed. Always call it (`finally`). */
  end: () => void;
}

/** Begin a reload of `kind` rows. Call it before the first read, so the guard
 *  knows which changes the reads may have missed. */
export function beginMembershipLoad(kind: GroupScope): MembershipLoad {
  const startedAt = ++clock;
  loadsInFlight.add(startedAt);
  return {
    overlay: (rows) =>
      rows.map((row) => {
        const change = changes.get(keyOf(kind, row.id));
        if (!change) return row;
        const missed = change.settledAt === null || change.settledAt > startedAt;
        return missed && (row.groupId ?? null) !== change.groupId
          ? { ...row, groupId: change.groupId }
          : row;
      }),
    end: () => {
      loadsInFlight.delete(startedAt);
      prune();
    },
  };
}

/** Test-only: forget everything. */
export function __resetMembershipGuard(): void {
  clock = 0;
  changes.clear();
  loadsInFlight.clear();
}
