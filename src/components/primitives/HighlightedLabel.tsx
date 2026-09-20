/**
 * Filter-match emphasis: the matched substring alone is styled, the rest of
 * the label is rendered verbatim. `match` is a `[start, end]` range on the
 * label itself (never on a lowercased copy — see `matchRange`), so the
 * emphasis can't drift on names whose case mapping changes length.
 *
 * Shared by the Companion file tree (brass ink) and the workspace rail (the
 * found-match wash).
 */
export function HighlightedLabel({
  label,
  match,
  className = "text-octo-brass",
  testId,
}: {
  label: string;
  match: readonly [number, number];
  className?: string;
  testId?: string;
}) {
  const [start, end] = match;
  return (
    <>
      {label.slice(0, start)}
      <span className={className} data-testid={testId}>
        {label.slice(start, end)}
      </span>
      {label.slice(end)}
    </>
  );
}

/**
 * Case-insensitive substring search that reports the hit's range on the
 * ORIGINAL string. Lowercasing both sides and indexing the copy is the
 * obvious approach, and it is wrong for names like "İstanbul" whose
 * lowercase form is longer — the highlight lands one character off. A
 * case-insensitive regex over the original string (query escaped) keeps the
 * indices honest. Returns null for an empty query or no hit.
 */
export function matchRange(label: string, query: string): readonly [number, number] | null {
  if (query === "") return null;
  const m = matcherFor(query).exec(label);
  return m ? [m.index, m.index + m[0].length] : null;
}

// One compiled matcher per query: a filter keystroke asks for every row's
// range, and the rail asks again per project and per row.
let cachedQuery = "";
let cachedRe: RegExp | null = null;
function matcherFor(query: string): RegExp {
  if (cachedRe === null || query !== cachedQuery) {
    cachedQuery = query;
    cachedRe = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  return cachedRe;
}
