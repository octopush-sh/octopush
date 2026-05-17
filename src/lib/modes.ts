// Workspace mode — what the canvas is showing right now.
// Modes replace the previous tab system. Only one mode is active per workspace.

export type WorkspaceMode = "talk" | "run" | "review";

export const MODES: WorkspaceMode[] = ["talk", "run", "review"];

export const MODE_LABELS: Record<WorkspaceMode, string> = {
  talk: "Talk",
  run: "Run",
  review: "Review",
};

/** Keyboard shortcut letter shown in tooltips. Mapping: ⌘⇧1/2/3 → talk/run/review. */
export const MODE_SHORTCUTS: Record<WorkspaceMode, string> = {
  talk: "⌘⇧1",
  run: "⌘⇧2",
  review: "⌘⇧3",
};
