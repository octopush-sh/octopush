import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  /** What the comment is on, above the field: a place, or a quoted passage. */
  context: ReactNode;
  note: string;
  onNoteChange: (note: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** The field's accessible name. */
  label: string;
  /** The add button's phrase, and its tooltip (which names ⌘⏎). */
  submitLabel: string;
  submitTitle: string;
  /** ⌥↑ / ⌥↓ move what the comment is on, and with ⇧ extend it (Review's
   *  line picking). Without it those keys stay the field's. */
  onMovePlace?: (dir: -1 | 1, extend: boolean) => void;
  /** Changes when the composer is pointed at another place while it stays
   *  open: the field takes the focus again, caret after the note. */
  focusKey?: unknown;
  /** Where the composer sits (margin, border, stickiness); its look is its own. */
  className?: string;
  tour?: { root?: string; submit?: string };
}

/**
 * The one comment composer of Review's "Ask for a change" (#956) and a Direct
 * gate's commentable document (#957): what the comment is on, the note, and
 * add / cancel. ⌘⏎ adds, Escape cancels (and goes no further, so it doesn't
 * reach the diff's keys or a dialog behind). The note is the caller's state,
 * so it outlives the field: a remount comes back with what was typed, and
 * focuses with the caret after it, so the next keystroke is typed, not taken
 * by the surface's own keys.
 */
export function CommentComposer({
  context,
  note,
  onNoteChange,
  onSubmit,
  onCancel,
  label,
  submitLabel,
  submitTitle,
  onMovePlace,
  focusKey,
  className = "",
  tour,
}: Props) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusKey]);
  const submit = () => { if (note.trim()) onSubmit(); };
  return (
    <div data-tour={tour?.root} className={`octo-rise-in flex flex-col gap-1.5 bg-octo-panel px-3 py-2 ${className}`}>
      {context}
      <textarea
        ref={field}
        value={note}
        aria-label={label}
        placeholder="What should change here…"
        onChange={(e) => onNoteChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          if (onMovePlace && e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            onMovePlace(e.key === "ArrowUp" ? -1 : 1, e.shiftKey);
          }
        }}
        className="h-16 resize-none rounded-md border border-octo-border-strong bg-octo-onyx px-2 py-1.5 text-[12px] text-octo-ivory placeholder:font-serif placeholder:text-octo-mute focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      />
      <div className="flex gap-2">
        <button
          type="button"
          data-tour={tour?.submit}
          onClick={submit}
          disabled={!note.trim()}
          title={submitTitle}
          className="rounded-md border border-[var(--brass-dim)] px-2.5 py-1 font-serif text-[12px] text-octo-brass transition-colors duration-[var(--dur-quick)] hover:bg-[var(--brass-ghost)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-octo-border-strong px-2.5 py-1 font-mono text-[10px] text-octo-mute transition-colors duration-[var(--dur-quick)] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
