import { useEffect, useRef } from "react";
import { MessageSquare, X } from "lucide-react";
import { commentLocation, type ReviewComment } from "../../lib/reviewComments";

/** The inline "Ask for a change" field under a hunk (#956). ⌘⏎ adds the
 *  comment to the Companion's tray; Escape drops the draft. The note is the
 *  caller's state, so it outlives this field: picking another line, folding
 *  the file or a refetch that moves the hunk remounts the field with what
 *  was typed. `stale` = the hunk changed since the place was picked. */
export function CommentComposer({
  location,
  note,
  stale = false,
  onNoteChange,
  onSubmit,
  onCancel,
}: {
  location: string;
  note: string;
  stale?: boolean;
  onNoteChange: (note: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  // Focus with the caret after what was already typed (a remount must not
  // send the next keystroke to the diff's own keys, or to the note's start).
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => { if (note.trim()) onSubmit(); };
  return (
    <div data-tour="review-comment-composer" className="octo-rise-in mt-1 flex flex-col gap-1.5 border-l-2 border-[var(--brass-dim)] bg-octo-panel px-3 py-2">
      <div className="font-mono text-[10px] text-octo-mute">
        {location}
        {stale && <span data-comment-stale> · this hunk changed; the comment keeps the lines it quoted</span>}
      </div>
      <textarea
        ref={field}
        value={note}
        aria-label="What should change"
        placeholder="What should change here…"
        onChange={(e) => onNoteChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        }}
        className="h-16 resize-none rounded-md border border-octo-border-strong bg-octo-onyx px-2 py-1.5 text-[12px] text-octo-ivory placeholder:font-serif placeholder:text-octo-mute focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      />
      <div className="flex gap-2">
        <button
          type="button"
          data-tour="review-comment-add"
          onClick={submit}
          disabled={!note.trim()}
          title="Add to the comments for the agent (⌘⏎)"
          className="rounded-md border border-[var(--brass-dim)] px-2.5 py-1 font-serif text-[12px] text-octo-brass transition-colors duration-[var(--dur-quick)] hover:bg-[var(--brass-ghost)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          Ask for this change
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-octo-border-strong px-2.5 py-1 font-mono text-[10px] text-octo-mute transition-colors hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The comments already left on one hunk, under its lines. */
export function HunkCommentList({ comments, onRemove }: { comments: ReviewComment[]; onRemove: (id: string) => void }) {
  if (comments.length === 0) return null;
  return (
    <ul aria-label="Comments on this hunk" className="mt-1 space-y-0.5">
      {comments.map((c) => (
        <li key={c.id} className="octo-rise-in group flex items-start gap-1.5 border-l-2 border-[var(--brass-rule-dim)] px-3 py-1 text-[11.5px] text-octo-sage">
          <MessageSquare size={11} aria-hidden className="mt-[3px] shrink-0 text-octo-mute" />
          <span className="shrink-0 font-mono text-[10px] leading-[1.7] text-octo-mute">{commentLocation(c).split(":").pop()}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{c.note}</span>
          <button
            type="button"
            onClick={() => onRemove(c.id)}
            aria-label="Remove comment"
            title="Remove comment"
            className="shrink-0 text-octo-mute transition-colors hover:text-octo-rouge focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            <X size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}
