// src/components/primitives/MidTruncate.tsx

import type { ReactNode } from "react";

interface Props {
  /** The full string. The caller is responsible for the `title` that carries it. */
  text: string;
  /** How many trailing characters stay pinned. Below `tail + 4` the string
   *  renders whole — eliding two characters out of the middle of a short name
   *  costs more legibility than it buys. */
  tail?: number;
  /** Optional glyph drawn INSIDE the box, before the text, and never shrunk
   *  (the ContextHeader's `GitBranch`). Inside, so a wash or a ring drawn on
   *  the box covers glyph and text as one chip. */
  lead?: ReactNode;
  className?: string;
}

/** Middle truncation for identifiers whose head AND tail disambiguate —
 *  branch names above all. `truncate` keeps the head and discards exactly the
 *  part that tells `…-per-shard-copy` from `…-per-shard-guard` apart; this
 *  keeps both ends and elides the middle instead.
 *
 *  Pure CSS (design-system §6, `.octo-midtrunc`): the head ellipsizes into
 *  whatever space is left over and the tail is pinned, so the elision point
 *  tracks the container's width with no measurement and no resize listener.
 *  The parent must give it a DEFINITE width — a `flex-1 min-w-0` item, as in
 *  the rail and the ContextHeader. Inside a shrink-to-fit parent the box is
 *  sized from its own text and WebKit hard-cuts it instead of eliding. */
export function MidTruncate({ text, tail = 12, lead, className = "" }: Props) {
  const leadEl =
    lead != null ? (
      <span className="octo-midtrunc-lead" aria-hidden>
        {lead}
      </span>
    ) : null;
  // The short path is a plain truncating line, NOT the flex box — a bare
  // string inside a flex container is an anonymous flex item that wraps at
  // every hyphen and slash. See `.octo-midtrunc-whole` in styles.css.
  if (text.length <= tail + 4) {
    return (
      <span className={`octo-midtrunc-whole ${className}`.trim()}>
        {leadEl}
        {text}
      </span>
    );
  }
  return (
    <span className={`octo-midtrunc ${className}`.trim()}>
      {leadEl}
      <span className="octo-midtrunc-head">{text.slice(0, text.length - tail)}</span>
      <span className="octo-midtrunc-tail">{text.slice(text.length - tail)}</span>
    </span>
  );
}
