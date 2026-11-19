// Keeping the keyboard on a project's line in the rail while the line moves.
//
// A project's menu opened from the keyboard gives its line the focus back
// when it closes. Some of the menu's actions then MOVE that line: "Move to
// group" renders the project under another parent, which React can only do by
// unmounting the line and mounting a new one, and a reorder moves its node.
// Either way the focused element is gone and the focus falls to <body>, out
// of the rail. So the wish is held for a moment and granted again after the
// rail renders, until the user acts or the moment is over (`HOLD_MS`): a
// reload long after the move (the window regaining focus) must not pull the
// focus back to a line the user has left.

/** How long a hold lasts: the move's own renders land well within it. */
export const HOLD_MS = 1000;

let wanted: string | null = null;
let listening = false;
let timer: ReturnType<typeof setTimeout> | null = null;

const line = (projectId: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-rail-project-line]")).find(
    (el) => el.dataset.railProjectLine === projectId,
  );

/** The user did something, or the time is up: the wish has been granted or overtaken. */
function release() {
  wanted = null;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!listening) return;
  listening = false;
  window.removeEventListener("keydown", release, true);
  window.removeEventListener("pointerdown", release, true);
}

/**
 * Focus a project's line now, and keep it focused through the renders that
 * follow (`restoreProjectLineFocus`) until the next key or pointer press, for
 * `HOLD_MS` at most.
 */
export function holdProjectLineFocus(projectId: string): void {
  release();
  wanted = projectId;
  listening = true;
  window.addEventListener("keydown", release, true);
  window.addEventListener("pointerdown", release, true);
  timer = setTimeout(release, HOLD_MS);
  line(projectId)?.focus({ preventScroll: true });
}

/**
 * Called by the rail after each render: when a held line lost the focus to
 * nothing (its element was replaced or moved), focus the line as it is now.
 * A focus that went somewhere real (a dialog, a rename input) is left alone.
 */
export function restoreProjectLineFocus(): void {
  if (!wanted) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  line(wanted)?.focus({ preventScroll: true });
}

/** Test-only: forget the held line. */
export function __releaseProjectLineFocus(): void {
  release();
}
