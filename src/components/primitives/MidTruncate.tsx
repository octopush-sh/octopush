// src/components/primitives/MidTruncate.tsx

interface Props {
  /** The full string. The caller is responsible for the `title` that carries it. */
  text: string;
  /** How many trailing characters stay pinned. Below `tail + 4` the string
   *  renders whole — eliding two characters out of the middle of a short name
   *  costs more legibility than it buys. */
  tail?: number;
  className?: string;
}

/** Middle truncation for identifiers whose head AND tail disambiguate —
 *  branch names above all. `truncate` keeps the head and discards exactly the
 *  part that tells `…-per-shard-copy` from `…-per-shard-guard` apart; this
 *  keeps both ends and elides the middle instead.
 *
 *  Pure CSS (design-system §6, `.octo-midtrunc`): the head ellipsizes into
 *  whatever space is left over and the tail is pinned, so the elision point
 *  tracks the container's width with no measurement and no resize listener. */
export function MidTruncate({ text, tail = 12, className = "" }: Props) {
  const cls = `octo-midtrunc ${className}`.trim();
  if (text.length <= tail + 4) return <span className={cls}>{text}</span>;
  return (
    <span className={cls}>
      <span className="octo-midtrunc-head">{text.slice(0, text.length - tail)}</span>
      <span className="octo-midtrunc-tail">{text.slice(text.length - tail)}</span>
    </span>
  );
}
