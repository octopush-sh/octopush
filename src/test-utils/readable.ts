/** What a reader and a copy get from an element: its text without anything
 *  `aria-hidden` (MidTruncate's `…` span, a `lead` glyph). Exact — no
 *  normalising, so a stray no-break space or a missing space fails. */
export function readable(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("[aria-hidden='true']").forEach((n) => n.remove());
  return clone.textContent ?? "";
}
