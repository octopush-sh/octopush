import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import { CommentComposer } from "./CommentComposer";
import { inDocumentOrder, normalizeQuote, type GateComment } from "../../lib/gateComments";

/** The CSS highlight name the comment marks paint with (styles.css). */
const HIGHLIGHT = "octo-comment";

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}
type HighlightCtor = new (...ranges: Range[]) => unknown;

/** Offset of (node, offset) in `root`'s rendered text. */
export function textOffset(root: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** The DOM range covering [at, at + len) of `root`'s rendered text, or null
 *  when the text no longer reaches that far. */
export function rangeAt(root: Node, at: number, len: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let started = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const size = n.textContent?.length ?? 0;
    if (!started && at < pos + size) {
      range.setStart(n, at - pos);
      started = true;
    }
    if (started && at + len <= pos + size) {
      range.setEnd(n, at + len - pos);
      return range;
    }
    pos += size;
  }
  return null;
}

/** The Custom Highlight registry and constructor, where the engine has them
 *  (WebKit does; jsdom doesn't, and then passages simply go unmarked). */
function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const g = globalThis as { CSS?: { highlights?: HighlightRegistry }; Highlight?: HighlightCtor };
  return g.CSS?.highlights && g.Highlight ? { registry: g.CSS.highlights, Highlight: g.Highlight } : null;
}

interface Passage {
  quote: string;
  at: number;
  len: number;
}

/** Where the *Comment* affordance sits: under the end of the selection (or of
 *  the passage the keyboard cursor is on), in the wrapper's coordinates. */
interface Offer extends Passage {
  top: number;
  left: number;
}

/** Room kept for the affordance at the pane's right edge, and its distance
 *  under the passage (px; positions are computed, so they can't be classes). */
const OFFER_ROOM = 96;
const OFFER_GAP = 4;

/** The passages the keyboard cursor moves over: the document's leaf blocks. */
const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th";

function blocksOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCKS)).filter(
    // A leaf: a list item holding paragraphs is covered by those paragraphs.
    (el) => !el.querySelector(BLOCKS) && !!normalizeQuote(el.textContent ?? ""),
  );
}

interface Props {
  /** The document, as Markdown. */
  text: string;
  comments: GateComment[];
  onAdd: (quote: string, note: string, at: number, len: number) => void;
  onRemove: (id: string) => void;
  /** `data-tour` ids for the document, the composer and the comment list. */
  tour?: { document?: string; compose?: string; list?: string };
}

/**
 * A readable document the director can comment on (#957): select a passage
 * (or move over the passages with the arrow keys), use *Comment*, write a
 * note, add it. A selection is never taken over: it stays a selection, so
 * copying from the document works as anywhere else, and the composer opens
 * only from the affordance. Comments are listed under the document in
 * document order, each with its quoted passage, and the passages are marked
 * in the text where the engine supports CSS highlights. The component only
 * edits the list; whoever owns it decides where the comments go.
 */
export function CommentableDocument({ text, comments, onAdd, onRemove, tour }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);
  /** A passage on offer: selected, or under the keyboard cursor. */
  const [offer, setOffer] = useState<Offer | null>(null);
  /** The keyboard cursor: an index into the document's blocks. */
  const [cursor, setCursor] = useState<number | null>(null);
  /** The passage the open composer comments on. */
  const [pending, setPending] = useState<Passage | null>(null);
  const [note, setNote] = useState("");
  // The composer takes the focus when it opens and when it is pointed at
  // another passage (`focusKey`), so the note goes on where it was.
  const ordered = inDocumentOrder(comments);

  // One element per text: typing a note or a parent's re-render must not
  // rebuild the Markdown, which would replace the text nodes under the marks
  // and under the director's selection.
  const rendered = useMemo(() => <ChatMarkdown text={text} />, [text]);

  // Mark every commented passage, and the one being commented on. The marks
  // are ranges over the rendered text nodes, so they are laid again whenever
  // those nodes change (a new text, or the Markdown filling in late).
  useEffect(() => {
    const api = highlightApi();
    const root = docRef.current;
    if (!api || !root) return;
    const { registry, Highlight: H } = api;
    const mark = () => {
      const ranges = [...comments, ...(pending ? [pending] : [])]
        .map((c) => rangeAt(root, c.at, c.len))
        .filter((r): r is Range => r !== null);
      registry.set(HIGHLIGHT, new H(...ranges));
    };
    mark();
    const seen = typeof MutationObserver === "undefined" ? null : new MutationObserver(mark);
    seen?.observe(root, { childList: true, characterData: true, subtree: true });
    return () => {
      seen?.disconnect();
      registry.delete(HIGHLIGHT);
    };
  }, [comments, pending, text]);

  // A new document: nothing on offer or under the cursor points into it.
  useEffect(() => {
    setOffer(null);
    setCursor(null);
  }, [text]);

  /** Where to put the affordance for a range, in the wrapper's coordinates. */
  function place(range: Range): { top: number; left: number } {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const rects = range.getClientRects?.();
    const end = rects && rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect?.();
    if (!wrap || !end) return { top: 0, left: 0 };
    // Just under the passage's end, kept inside the pane's width.
    const left = Math.min(end.right - wrap.left, wrap.width - OFFER_ROOM);
    return { top: end.bottom - wrap.top + OFFER_GAP, left: Math.max(0, left) };
  }

  // Follow the selection without touching it: a passage selected inside the
  // document puts *Comment* next to it; any other selection takes it away.
  useEffect(() => {
    const onSelection = () => {
      const root = docRef.current;
      const sel = window.getSelection();
      if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        // A keyboard offer has no selection behind it: it stays.
        setOffer((o) => (o && cursorRef.current !== null ? o : null));
        return;
      }
      const r = sel.getRangeAt(0);
      const raw = r.toString();
      if (!root.contains(r.startContainer) || !root.contains(r.endContainer) || !normalizeQuote(raw)) {
        setOffer(null);
        return;
      }
      setCursor(null);
      setOffer({ quote: raw, at: textOffset(root, r.startContainer, r.startOffset), len: raw.length, ...place(r) });
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // The keyboard cursor shows on its block (styles.css paints the attribute).
  useEffect(() => {
    const root = docRef.current;
    if (!root || cursor === null) return;
    const block = blocksOf(root)[cursor];
    if (!block) return;
    block.setAttribute("data-comment-cursor", "");
    block.scrollIntoView?.({ block: "nearest" });
    return () => block.removeAttribute("data-comment-cursor");
  }, [cursor, text]);

  /** Move the keyboard cursor to block `i` and offer it for a comment. */
  function moveTo(i: number) {
    const root = docRef.current;
    if (!root) return;
    const blocks = blocksOf(root);
    if (blocks.length === 0) return;
    const at = Math.max(0, Math.min(i, blocks.length - 1));
    const block = blocks[at];
    const range = document.createRange();
    range.selectNodeContents(block);
    const raw = range.toString();
    window.getSelection()?.removeAllRanges();
    setCursor(at);
    setOffer({ quote: raw, at: textOffset(root, range.startContainer, range.startOffset), len: raw.length, ...place(range) });
  }

  function onDocKey(e: KeyboardEvent<HTMLDivElement>) {
    // Shift+arrows extend a selection: that stays the engine's.
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      moveTo(cursor === null ? 0 : cursor + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && offer) {
      e.preventDefault();
      e.stopPropagation();
      compose();
    } else if (e.key === "Escape" && cursor !== null) {
      e.preventDefault();
      e.stopPropagation();
      setCursor(null);
      setOffer(null);
    }
  }

  /** Open the composer on the offered passage. A note already being typed
   *  stays: the director is pointing it at another passage. */
  function compose() {
    if (!offer) return;
    setPending({ quote: offer.quote, at: offer.at, len: offer.len });
    setOffer(null);
    setCursor(null);
  }

  function cancel() {
    setPending(null);
    setNote("");
  }

  function add() {
    if (!pending || !note.trim()) return;
    onAdd(pending.quote, note, pending.at, pending.len);
    cancel();
  }

  return (
    <div ref={wrapRef} className="relative flex flex-col gap-3">
      <div
        ref={docRef}
        data-tour={tour?.document}
        tabIndex={0}
        role="group"
        aria-label="Stage output. Up and Down move over its passages; Enter comments on the one marked."
        onKeyDown={onDocKey}
        onBlur={() => { if (cursor !== null) { setCursor(null); setOffer(null); } }}
        className="octo-selectable octo-commentable rounded-sm font-sans text-[13px] leading-[1.6] text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        {rendered}
      </div>

      {offer && (
        <button
          type="button"
          data-comment-offer
          // The press must not collapse the selection it is offered for.
          onMouseDown={(e) => e.preventDefault()}
          onClick={compose}
          title="Comment on this passage"
          style={{ top: offer.top, left: offer.left }}
          className="octo-pop-in absolute z-20 flex items-center gap-1 rounded-md border border-[var(--brass-dim)] bg-octo-panel px-2 py-1 font-mono text-[10px] text-octo-brass transition-colors duration-[var(--dur-quick)] hover:bg-[var(--brass-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <MessageSquarePlus size={11} strokeWidth={1.75} aria-hidden />
          Comment
        </button>
      )}

      {pending ? (
        <CommentComposer
          tour={{ root: tour?.compose }}
          className="sticky bottom-0 z-10 rounded-md border border-[var(--brass-dim)]"
          focusKey={pending}
          context={
            <div className="line-clamp-2 border-l border-[var(--brass-dim)] pl-2 font-mono text-[11px] text-octo-mute" title={normalizeQuote(pending.quote)}>
              {normalizeQuote(pending.quote)}
            </div>
          }
          note={note}
          onNoteChange={setNote}
          onSubmit={add}
          onCancel={cancel}
          label="Your comment on this passage"
          submitLabel="Add the comment"
          submitTitle="Add the comment (⌘⏎)"
        />
      ) : (
        ordered.length === 0 && (
          <div className="octo-fade-in flex items-center gap-1.5 font-mono text-[10px] text-octo-mute">
            <span title="Comment on a passage" className="inline-flex">
              <MessageSquarePlus size={11} strokeWidth={1.75} aria-hidden />
            </span>
            Select a passage, then Comment. From the keyboard: ↑ ↓ and ⏎.
          </div>
        )
      )}

      {ordered.length > 0 && (
        <div data-tour={tour?.list} className="flex flex-col gap-2 border-t border-octo-hairline pt-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
            your comments · <span className="octo-tabular tracking-normal">{ordered.length}</span>
          </div>
          {ordered.map((c) => (
            <div key={c.id} className="octo-rise-in flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="line-clamp-2 border-l border-octo-hairline pl-2 font-mono text-[11px] text-octo-mute" title={c.quote}>
                  {c.quote}
                </div>
                <div className="whitespace-pre-wrap pl-2 font-sans text-xs text-octo-ivory">{c.note}</div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(c.id)}
                aria-label="Remove this comment"
                title="Remove this comment"
                className="shrink-0 rounded p-1 text-octo-mute transition-colors duration-[180ms] hover:text-octo-rouge"
              >
                <X size={12} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
