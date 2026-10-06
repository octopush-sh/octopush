/** macOS uses ⌘ where every other platform uses Ctrl. Guarded for jsdom and
 *  for the pre-hydration window where `navigator` may be absent. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
}

/** What "show this file in the OS file manager" is called on this platform. */
export function revealLabel(): string {
  if (isMac()) return "Reveal in Finder";
  if (typeof navigator !== "undefined" && /Win/.test(navigator.platform || navigator.userAgent || "")) {
    return "Show in Explorer";
  }
  return "Show in folder";
}

/** The primary modifier as a hint prefix — `⌘` on a Mac, `Ctrl+` elsewhere —
 *  for shortcut hints in tooltips and flyouts (`⌘3` / `Ctrl+3`). The app
 *  binds these chords on `metaKey || ctrlKey`, so the hint must follow the
 *  platform or it names a key the user does not have. */
export function modKeyLabel(): string {
  return isMac() ? "⌘" : "Ctrl+";
}
