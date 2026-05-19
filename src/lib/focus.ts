/**
 * Tiny module-level "currently focused workspace + mode" so background
 * stores (chatStore, attentionStore consumers) can decide whether the
 * user is already looking at the surface that just produced an event —
 * in which case there's no point firing an attention chime.
 *
 * App.tsx writes to this whenever the active workspace or mode changes.
 * Stores read it ad-hoc when they need to make focus-conditional
 * decisions. Keeping this out of zustand means we don't trigger
 * re-renders for state that only matters to background logic.
 */

import type { WorkspaceMode } from "./modes";

export const focus: {
  workspaceId: string | null;
  mode: WorkspaceMode;
} = {
  workspaceId: null,
  mode: "talk",
};
