export type WorkspaceMode = "talk" | "run" | "review" | "direct";

export const MODES: WorkspaceMode[] = ["run", "talk", "review", "direct"];

export const MODE_LABELS: Record<WorkspaceMode, string> = {
  talk: "Talk",
  run: "Run",
  review: "Review",
  direct: "Direct",
};

export const MODE_SHORTCUTS: Record<WorkspaceMode, string> = {
  talk: "⌘⇧1",
  run: "⌘⇧2",
  review: "⌘⇧3",
  direct: "⌘⇧D",
};
