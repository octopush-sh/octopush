import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "../../lib/markdownComponents";

// Stable across renders: the component map has no per-render inputs and the
// plugin list never changes, so build both once at module load.
const COMPONENTS = markdownComponents();
const REMARK_PLUGINS = [remarkGfm];

interface Props {
  source: string;
  /** Jump the editor's caret to the source line a rendered block came from.
   *  Omitted (e.g. in a preview with no editor beside it) disables the
   *  margin marker and the ⌘/Ctrl-click shortcut entirely. */
  onJumpToLine?: (line: number) => void;
}

/** The rendered block under `target` and the 1-based source line it came from,
 *  or null when the pointer is outside the document (or over a block the parser
 *  gave no position). The innermost stamped element wins, so a list item beats
 *  its list and a table row beats its table. */
function blockFor(
  target: EventTarget | null,
  within: HTMLElement | null,
): { el: HTMLElement; line: number } | null {
  if (!(target instanceof globalThis.Element) || !within) return null;
  const el = target.closest<HTMLElement>("[data-md-line]");
  if (!el || !within.contains(el)) return null;
  const line = Number(el.getAttribute("data-md-line"));
  return Number.isFinite(line) && line > 0 ? { el, line } : null;
}

/** Rendered Markdown pane for REVIEW's editor split. Renders the live editor
 *  buffer (`source`) with GFM. No rehype-raw: embedded HTML stays inert text.
 *
 *  Two affordances point back at the source: a brass line-number marker that
 *  tracks the hovered block in the left margin (the discoverable path), and
 *  ⌘/Ctrl-click anywhere in a block (the editor idiom). Both are opt-in via
 *  `onJumpToLine` — a plain click, a drag-selection and a link all keep
 *  behaving as they do anywhere else, which is what makes the prose copyable. */
export function MarkdownPreview({ source, onJumpToLine }: Props) {
  const rendered = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    ),
    [source],
  );

  const bodyRef = useRef<HTMLDivElement>(null);
  // `marker` keeps its last position while hidden so the button can fade out
  // in place instead of snapping to the top of the document.
  const [marker, setMarker] = useState<{ line: number; top: number } | null>(null);
  const [markerShown, setMarkerShown] = useState(false);

  // A stale marker points at the wrong place: the preview renders the LIVE
  // buffer, so typing in the source column reflows the document underneath a
  // resting pointer. Hide it and let the next hover re-measure.
  useEffect(() => {
    setMarkerShown(false);
  }, [source]);

  // Same hazard without a source change: the pane animating between view
  // modes, a window resize, or an image loading above the hovered block all
  // reflow the document while the pointer sits still, so no mouseover comes to
  // re-measure. One observer on the document covers all three.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setMarkerShown(false));
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  const onMouseOver = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const body = bodyRef.current;
      if (!onJumpToLine || !body) return;
      const block = blockFor(e.target, body);
      // Everything that isn't a block — the marker itself, and the gutter strip
      // the pointer must cross to reach it — leaves the marker exactly as it
      // is. Only leaving the pane dismisses it; dismissing on the gutter would
      // make the marker unreachable, since it turns inert the moment it hides.
      if (!block) return;
      // Measured against the document wrapper rather than with `offsetTop`:
      // a <tr>/<td>'s offsetParent is its <table>, not the wrapper, so the
      // offset would be the row's position INSIDE the table.
      const top = block.el.getBoundingClientRect().top - body.getBoundingClientRect().top;
      setMarker((prev) =>
        prev && prev.line === block.line && prev.top === top ? prev : { line: block.line, top },
      );
      setMarkerShown(true);
    },
    [onJumpToLine],
  );

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // ⌘/Ctrl-click always means "go to the source" — including over a link,
      // which a plain click already opens. Anything unmodified is left alone.
      if (!onJumpToLine || !(e.metaKey || e.ctrlKey)) return;
      const block = blockFor(e.target, bodyRef.current);
      if (!block) return;
      e.preventDefault();
      onJumpToLine(block.line);
    },
    [onJumpToLine],
  );

  return (
    <div
      data-testid="markdown-preview"
      className="octo-fade-in octo-selectable octo-scroll h-full overflow-auto py-5 pl-11 pr-6"
      style={{ background: "var(--color-octo-onyx)" }}
      onMouseOver={onMouseOver}
      onMouseLeave={() => setMarkerShown(false)}
      onClick={onClick}
    >
      <div ref={bodyRef} className="relative mx-auto max-w-[72ch]">
        {rendered}
        {onJumpToLine && marker && (
          <button
            type="button"
            onClick={() => onJumpToLine(marker.line)}
            title={`Jump to line ${marker.line}`}
            aria-label={`Jump to line ${marker.line}`}
            className={`absolute -left-8 z-10 rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px] leading-none tabular-nums text-octo-brass focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-octo-brass ${
              markerShown ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            style={{
              top: marker.top,
              background: "var(--brass-ghost)",
              borderColor: "var(--brass-quiet)",
              // The house curve and duration band (§6); the app-wide
              // reduced-motion neutralizer in styles.css freezes it.
              transition: "opacity 220ms cubic-bezier(0.2,0.8,0.3,1)",
            }}
          >
            {marker.line}
          </button>
        )}
      </div>
    </div>
  );
}
