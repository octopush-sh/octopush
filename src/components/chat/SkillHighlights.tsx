import type { RefObject } from "react";
import { splitBySkillTokens } from "../../lib/skillMentions";

/**
 * The composer's inline skill highlight: a backdrop that mirrors the
 * textarea's text with the same metrics (font, size, leading, padding, wrap)
 * and paints a brass wash under every standalone `/name` the worktree knows.
 * The text itself is transparent — the real textarea sits on top and keeps
 * the caret, selection and typing — so a skill reads as part of the sentence
 * ("run /code-review and /release on this"), not as an attachment. Scroll is
 * synced by the textarea's onScroll.
 */
export function SkillHighlights({
  text,
  skillNames,
  scrollRef,
}: {
  text: string;
  skillNames: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const parts = splitBySkillTokens(text, skillNames);
  const any = parts.some((p) => p.kind === "skill");
  return (
    <div
      ref={scrollRef}
      aria-hidden
      data-testid="skill-highlights"
      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3.5 pb-2 text-[14px] leading-[1.5] text-transparent"
      style={{ maxHeight: "calc(8 * 1.25rem + 1.5rem)" }}
    >
      {any
        ? parts.map((p, i) =>
            p.kind === "skill" ? (
              <mark
                key={i}
                data-testid="skill-highlight"
                className="rounded-sm text-transparent"
                style={{ background: "var(--brass-ghost)", boxShadow: "0 0 0 1px var(--brass-dim)" }}
              >
                {p.text}
              </mark>
            ) : (
              <span key={i}>{p.text}</span>
            ),
          )
        : text}
      {/* A trailing newline collapses in a div but not in a textarea; keep
          the heights equal so the wash never drifts a line. */}
      {text.endsWith("\n") ? "​" : null}
    </div>
  );
}
