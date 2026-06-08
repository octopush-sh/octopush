import { useEffect } from "react";

export interface FlatHunk { fileIdx: number; hunkIdx: number; }
export type NavKey = "j" | "k" | "]" | "[";

export function nextFocus(flat: FlatHunk[], current: number, key: NavKey): number {
  if (flat.length === 0) return -1;
  const cur = Math.max(0, Math.min(current, flat.length - 1));
  if (key === "j") return Math.min(cur + 1, flat.length - 1);
  if (key === "k") return Math.max(cur - 1, 0);
  const curFile = flat[cur]?.fileIdx ?? 0;
  if (key === "]") { const i = flat.findIndex(f => f.fileIdx > curFile); return i === -1 ? cur : i; }
  // "["
  const firstOfCur = flat.findIndex(f => f.fileIdx === curFile);
  if (firstOfCur > 0) { const prevFile = flat[firstOfCur - 1].fileIdx; return flat.findIndex(f => f.fileIdx === prevFile); }
  return cur;
}

export interface DiffKeyboardActions {
  accept: () => void; reject: () => void; acceptFile: () => void;
  toggleViewed: () => void; open: () => void; why: () => void;
  toggleCollapse: () => void; focusFilter: () => void; focusCommit: () => void; toggleHelp: () => void;
}

export function useDiffKeyboard(opts: {
  enabled: boolean; flat: FlatHunk[]; focused: number;
  setFocused: (n: number) => void; actions: DiffKeyboardActions; containerRef: React.RefObject<HTMLElement | null>;
}) {
  const { enabled, flat, focused, setFocused, actions, containerRef } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const el = containerRef.current;
      // Only act when focus is within the diff container (or on body, i.e. nothing else grabbed it).
      if (!el || (!el.contains(document.activeElement) && document.activeElement !== document.body)) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const k = e.key;
      const navMap: Record<string, NavKey> = { j: "j", ArrowDown: "j", k: "k", ArrowUp: "k", "]": "]", "[": "[" };
      if (k in navMap) { e.preventDefault(); setFocused(nextFocus(flat, focused, navMap[k])); return; }
      const map: Record<string, () => void> = {
        a: actions.accept, x: actions.reject, A: actions.acceptFile, v: actions.toggleViewed,
        o: actions.open, w: actions.why, " ": actions.toggleCollapse, "/": actions.focusFilter,
        c: actions.focusCommit, "?": actions.toggleHelp,
      };
      if (k in map) { e.preventDefault(); map[k](); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, flat, focused, setFocused, actions, containerRef]);
}
