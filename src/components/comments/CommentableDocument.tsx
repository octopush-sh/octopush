import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { ChatMarkdown } from "../chat/ChatMarkdown";
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

interface Pending {
  quote: string;
  at: number;
  len: number;
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
 * A readable document the director can comment on (#957): select a passage,
 * write a note, add it. Comments are listed under the document in document
 * order, each with its quoted passage, and the passages are marked in the
 * text where the engine supports CSS highlights. The component only edits
 * the list; whoever owns it decides where the comments go.
 */
export function CommentableDocument({ text, comments, onAdd, onRemove, tour }: Props) {
  const docRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState("");
  const ordered = inDocumentOrder(comments);

  // Mark every commented passage. Re-run after each render of the text or
  // the list: the Markdown may have replaced the text nodes.
  useEffect(() => {
    const api = highlightApi();
    const root = docRef.current;
    if (!api || !root) return;
    const { registry, Highlight: H } = api;
    const ranges = comments
      .map((c) => rangeAt(root, c.at, c.len))
      .filter((r): r is Range => r !== null);
    if (pending) {
      const r = rangeAt(root, pending.at, pending.len);
      if (r) ranges.push(r);
    }
    registry.set(HIGHLIGHT, new H(...ranges));
    return () => registry.delete(HIGHLIGHT);
  }, [comments, pending, text]);

  function readSelection() {
    const root = docRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return;
    const raw = r.toString();
    if (!normalizeQuote(raw)) return;
    const at = textOffset(root, r.startContainer, r.startOffset);
    setPending({ quote: raw, at, len: raw.length });
    setNote("");
  }

  function cancel() {
    setPending(null);
    setNote("");
  }

  function add() {
    if (!pending || !note.trim()) return;
    onAdd(pending.quote, note, pending.at, pending.len);
    window.getSelection()?.removeAllRanges();
    cancel();
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={docRef}
        data-tour={tour?.document}
        onMouseUp={readSelection}
        onKeyUp={readSelection}
        className="octo-selectable font-sans text-[13px] leading-[1.6] text-octo-sage"
      >
        <ChatMarkdown text={text} />
      </div>

      {pending ? (
        <div
          data-tour={tour?.compose}
          className="octo-rise-in sticky bottom-0 z-10 flex flex-col gap-2 rounded-md border border-[var(--brass-dim)] bg-octo-panel px-3 py-2.5"
        >
          <div className="line-clamp-2 border-l border-[var(--brass-dim)] pl-2 font-mono text-[11px] text-octo-mute" title={normalizeQuote(pending.quote)}>
            {normalizeQuote(pending.quote)}
          </div>
          <textarea
            autoFocus
            aria-label="Your comment on this passage"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); cancel(); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); }
            }}
            placeholder="What should change here…"
            className="h-16 resize-none rounded-md border border-octo-border-strong bg-octo-onyx px-3 py-2 font-sans text-xs text-octo-ivory placeholder:font-serif placeholder:text-octo-mute"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={add}
              disabled={!note.trim()}
              title="Add the comment (⌘↩)"
              className="rounded-md border border-octo-brass px-3 py-1.5 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] disabled:opacity-40"
            >
              Add the comment
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-ivory"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        ordered.length === 0 && (
          <div className="octo-fade-in flex items-center gap-1.5 font-mono text-[10px] text-octo-mute">
            <MessageSquarePlus size={11} strokeWidth={1.75} aria-hidden />
            Select a passage to comment on it.
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
                <div className="line-clamp-2 border-l border-[var(--brass-dim)] pl-2 font-mono text-[11px] text-octo-mute" title={c.quote}>
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
