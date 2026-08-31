/**
 * Go to definition — `⌘`/`Ctrl`-click an identifier (or press `F12`) and the
 * editor jumps to where it is declared.
 *
 * Two halves live here:
 *
 *  - **The affordance.** While the modifier is held, the identifier under the
 *    pointer underlines in brass and the cursor turns into a pointer, exactly
 *    as it does in every editor that has this. Without it the gesture is
 *    undiscoverable, and an undiscoverable gesture is the same as a missing
 *    one.
 *  - **The gesture.** `mousedown` with the modifier is swallowed before
 *    CodeMirror's own mouse handling sees it, and reported to the host.
 *
 * Note this takes `⌘`-click away from CodeMirror's default "add a caret here"
 * (`clickAddsSelectionRange`). That is the same trade every mainstream editor
 * makes, and Octopush keeps two keyboard routes to the same place — `⌘D` for
 * the next occurrence, `⌘⇧L` for all of them.
 *
 * Resolution itself is NOT here: this module only says "the user asked about
 * this identifier, at this offset". `EditorPane` decides where to look — the
 * open document first, then the workspace — because only it can open other
 * files.
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type Command,
  type DecorationSet,
} from "@codemirror/view";
import { identifierNear } from "./symbolIndex";

/** What the user asked about, and where they asked from. */
export interface DefinitionRequest {
  name: string;
  /** Offset of the identifier the gesture landed on — used to skip it when the
   *  only "definition" found in the file is the occurrence being clicked. */
  from: number;
  to: number;
}

const LINK = Decoration.mark({ class: "cm-symbolLink" });

/** The slice of EditorView this module needs, so the pointer maths can be
 *  tested against a stub instead of a laid-out browser. */
export interface PointerTarget {
  posAtCoords(coords: { x: number; y: number }): number | null;
  coordsAtPos(pos: number): Rect | null;
  state: { sliceDoc(from: number, to: number): string; doc: { length: number } };
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** How far outside an identifier's own box a click still counts, in px. */
const EDGE_SLOP = 2;

/**
 * The identifier the pointer is actually over, or null.
 *
 * `posAtCoords` answers with the nearest text position, which is not the same
 * question: clicking the empty space to the right of a line returns that line's
 * end, and the caret-adjacency rule then resolves the line's LAST identifier.
 * The same happens BELOW the text — `.cm-content` is at least as tall as its
 * scroller, so any y past the last line answers `doc.length`. So the position is
 * checked against the identifier's own box on BOTH axes before it counts;
 * without the vertical half, clicking empty space under the document still
 * navigated whenever the pointer's column happened to overlap the last
 * identifier's.
 */
export function resolvePointerTarget(
  view: PointerTarget,
  coords: { x: number; y: number },
): DefinitionRequest | null {
  const pos = view.posAtCoords(coords);
  if (pos == null) return null;
  const hit = identifierNear(
    (from, to) => view.state.sliceDoc(from, to),
    view.state.doc.length,
    pos,
  );
  if (!hit) return null;

  // No layout to check against (jsdom, or a position CodeMirror can't measure):
  // trust the position rather than refusing to navigate at all.
  const start = view.coordsAtPos(hit.from);
  const end = view.coordsAtPos(hit.to);

  // Vertical: an identifier can wrap across visual lines, so the band runs from
  // the top of its first box to the bottom of its last.
  const top = Math.min(start?.top ?? Infinity, end?.top ?? Infinity);
  const bottom = Math.max(start?.bottom ?? -Infinity, end?.bottom ?? -Infinity);
  if (Number.isFinite(top) && coords.y < top - EDGE_SLOP) return null;
  if (Number.isFinite(bottom) && coords.y > bottom + EDGE_SLOP) return null;

  // Horizontal: only meaningful while both ends sit on ONE visual line. A
  // wrapped identifier's first glyph is at the right of one line and its last
  // at the left of the next, so [left, right] is not an interval at all there —
  // testing it anyway refused both halves. The vertical band still bounds it.
  if (start && end && start.top === end.top) {
    if (coords.x < start.left - EDGE_SLOP) return null;
    if (coords.x > end.right + EDGE_SLOP) return null;
  }
  return hit;
}

/** macOS uses ⌘ where every other platform uses Ctrl. Guarded for jsdom and
 *  for the pre-hydration window where `navigator` may be absent. */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
}

/** Is the go-to-definition modifier held for this event? */
export function hasNavModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/** Resolve the identifier at the caret and hand it to `onRequest`. Bound to
 *  `F12`, the shortcut this gesture carries in every editor that has it. */
export function goToDefinitionCommand(
  onRequest: (req: DefinitionRequest, view: EditorView) => void,
): Command {
  return (view) => {
    const { state } = view;
    const hit = identifierNear(
      (from, to) => state.sliceDoc(from, to),
      state.doc.length,
      state.selection.main.head,
    );
    if (!hit) return false;
    onRequest(hit, view);
    return true;
  };
}

/**
 * The click gesture and its hover affordance.
 *
 * `onRequest` is called with the identifier the pointer landed on; it never
 * fires for a click on whitespace or punctuation, so an accidental `⌘`-click
 * in the margin does nothing at all rather than jumping somewhere arbitrary.
 */
export function symbolNav(
  onRequest: (req: DefinitionRequest, view: EditorView) => void,
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      view: EditorView;
      private modHeld = false;
      private hovered: { from: number; to: number } | null = null;
      // Modifier state has to come from the window, not the editor: the key can
      // be pressed or released while focus sits in the find overlay or outside
      // the app entirely, and a stuck underline is worse than none.
      private readonly onKey = (e: KeyboardEvent) => this.setMod(hasNavModifier(e));
      private readonly onBlur = () => this.setMod(false);

      constructor(view: EditorView) {
        this.view = view;
        window.addEventListener("keydown", this.onKey);
        window.addEventListener("keyup", this.onKey);
        window.addEventListener("blur", this.onBlur);
      }

      update(update: { docChanged: boolean }) {
        // `hovered` is a pair of absolute offsets, and the pointer hasn't moved
        // — but the text under it has. Undo or a cut with the modifier still
        // held would otherwise leave the underline stranded over unrelated (or
        // past-the-end) text until the next mousemove. Dropping it is honest:
        // the next pointer move re-establishes it.
        if (!update.docChanged || !this.hovered) return;
        this.hovered = null;
        this.decorations = Decoration.none;
      }

      destroy() {
        window.removeEventListener("keydown", this.onKey);
        window.removeEventListener("keyup", this.onKey);
        window.removeEventListener("blur", this.onBlur);
      }

      private setMod(held: boolean) {
        if (held === this.modHeld) return;
        this.modHeld = held;
        if (!held) this.hovered = null;
        this.repaint();
      }

      /** Point the pointer at `x,y` and remember the identifier there. */
      hover(e: MouseEvent) {
        if (!this.modHeld) {
          if (this.hovered) {
            this.hovered = null;
            this.repaint();
          }
          return;
        }
        const hit = this.identifierAtEvent(e);
        const next = hit ? { from: hit.from, to: hit.to } : null;
        if (next?.from === this.hovered?.from && next?.to === this.hovered?.to) return;
        this.hovered = next;
        this.repaint();
      }

      clear() {
        if (!this.hovered) return;
        this.hovered = null;
        this.repaint();
      }

      identifierAtEvent(e: MouseEvent): DefinitionRequest | null {
        return resolvePointerTarget(this.view, { x: e.clientX, y: e.clientY });
      }

      request(req: DefinitionRequest) {
        this.hovered = null;
        this.repaint();
        onRequest(req, this.view);
      }

      private repaint() {
        this.decorations =
          this.modHeld && this.hovered
            ? Decoration.set([LINK.range(this.hovered.from, this.hovered.to)])
            : Decoration.none;
        // The plugin owns a decoration field, so CodeMirror only re-reads it
        // during an update; nudge one so the underline lands on keydown alone.
        this.view.dispatch({});
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousemove(e) {
          this.hover(e);
        },
        mouseleave() {
          this.clear();
        },
        mousedown(e) {
          if (e.button !== 0 || !hasNavModifier(e)) return false;
          const hit = this.identifierAtEvent(e);
          if (!hit) return false;
          // Swallow it: CodeMirror's default for this chord is "add a caret",
          // which would leave a stray selection behind the jump.
          e.preventDefault();
          this.request(hit);
          return true;
        },
      },
    },
  );
}

