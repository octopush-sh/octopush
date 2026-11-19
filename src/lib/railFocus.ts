// Keeping the keyboard on a project's line, or on a mission's row, in the
// rail while the line moves.
//
// A project's (or a mission's) menu opened from the keyboard gives its line
// the focus back when it closes. Some of the menu's actions then MOVE that line: "Move to
// group" renders the project under another parent, which React can only do by
// unmounting the line and mounting a new one, and a reorder moves its node.
// Either way the focused element is gone and the focus falls to <body>, out
// of the rail. So the wish is held for a moment and granted again after the
// rail renders, until the user acts.

/** A held line: a project's line or a mission row's name button. */
interface Wish {
  kind: "project" | "mission";
  id: string;
}

let wanted: Wish | null = null;
let listening = false;

const line = ({ kind, id }: Wish) =>
  kind === "project"
    ? Array.from(document.querySelectorAll<HTMLElement>("[data-rail-project-line]")).find(
        (el) => el.dataset.railProjectLine === id,
      )
    : Array.from(document.querySelectorAll<HTMLElement>("[data-rail-mission]")).find(
        (el) => el.dataset.railMission === id,
      );

/** Nothing real holds the focus: it fell to <body> or to a removed node. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

function hold(wish: Wish) {
  release();
  wanted = wish;
  listening = true;
  window.addEventListener("keydown", release, true);
  window.addEventListener("pointerdown", release, true);
}

/** The user did something: the wish has been granted or overtaken. */
function release() {
  wanted = null;
  if (!listening) return;
  listening = false;
  window.removeEventListener("keydown", release, true);
  window.removeEventListener("pointerdown", release, true);
}

/**
 * Focus a project's line now, and keep it focused through the renders that
 * follow (`restoreProjectLineFocus`) until the next key or pointer press.
 */
export function holdProjectLineFocus(projectId: string): void {
  hold({ kind: "project", id: projectId });
  line({ kind: "project", id: projectId })?.focus({ preventScroll: true });
}

/**
 * The same for a mission row (its name button, `data-rail-mission`), for a
 * mission menu or a Move-to-group menu the keyboard opened. Unlike a project
 * line it is focused only where the focus was lost: a menu action may have
 * opened a dialog (Rename…, Customize…) that took the focus on purpose.
 */
export function holdMissionRowFocus(workspaceId: string): void {
  const wish: Wish = { kind: "mission", id: workspaceId };
  hold(wish);
  if (focusIsLost()) line(wish)?.focus({ preventScroll: true });
}

/**
 * Called by the rail after each render: when a held line lost the focus to
 * nothing (its element was replaced or moved), focus the line as it is now.
 * A focus that went somewhere real (a dialog, a rename input) is left alone.
 */
export function restoreProjectLineFocus(): void {
  if (!wanted || !focusIsLost()) return;
  line(wanted)?.focus({ preventScroll: true });
}

/** Test-only: forget the held line. */
export function __releaseProjectLineFocus(): void {
  release();
}
