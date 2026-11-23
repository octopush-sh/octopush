export type WorkspaceMode = "talk" | "run" | "review" | "direct";

export const MODES: WorkspaceMode[] = ["run", "talk", "review", "direct"];

export const MODE_LABELS: Record<WorkspaceMode, string> = {
  talk: "Talk",
  run: "Run",
  review: "Review",
  direct: "Direct",
};

/** Numbered in switcher order (`MODES`). Direct is a letter because macOS
 *  takes ⌘⇧4 (screenshot) before the webview sees it. */
export const MODE_SHORTCUTS: Record<WorkspaceMode, string> = {
  run: "⌘⇧1",
  talk: "⌘⇧2",
  review: "⌘⇧3",
  direct: "⌘⇧D",
};
