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
/** Per item, its live changes, oldest first. An older one is kept under a
 *  newer one: if the newer is dropped, a reload that read before the older
 *  settled must still show the older. */
const changes = new Map<string, Change[]>();
const loadsInFlight = new Set<number>();

const keyOf = (kind: GroupScope, itemId: string) => `${kind}:${itemId}`;

/** Forget settled changes no reload in flight could still contradict. */
function prune() {
  const oldestLoad = loadsInFlight.size > 0 ? Math.min(...loadsInFlight) : Infinity;
  for (const [key, list] of changes) {
    const kept = list.filter((c) => c.settledAt === null || c.settledAt >= oldestLoad);
    if (kept.length === 0) changes.delete(key);
    else if (kept.length !== list.length) changes.set(key, kept);
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
 *  newer change to the same item wins over an older one while both live. */
export function beginMembershipChange(
  kind: GroupScope,
  itemIds: string[],
  groupId: string | null,
): MembershipChange {
  const mine = itemIds.map((id) => {
    const key = keyOf(kind, id);
    const change: Change = { groupId, settledAt: null };
    changes.set(key, [...(changes.get(key) ?? []), change]);
    return [key, change] as const;
  });
  return {
    settle: () => {
      const at = ++clock;
      for (const [, change] of mine) change.settledAt = at;
      prune();
    },
    drop: () => {
      for (const [key, change] of mine) {
        const kept = (changes.get(key) ?? []).filter((c) => c !== change);
        if (kept.length === 0) changes.delete(key);
        else changes.set(key, kept);
      }
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
        // The newest live change says where the item belongs; if the read
        // already saw it, the read is the truth.
        const change = changes.get(keyOf(kind, row.id))?.at(-1);
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
