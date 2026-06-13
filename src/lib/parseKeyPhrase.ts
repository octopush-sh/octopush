// Splits assistant content into a lead "key phrase" (rendered as Spectral
// upright serif display) and a body (rendered as markdown).
//
// Returns `keyPhrase: null` when the parse should be skipped — content
// starts with a code block, heading, list, has no sentence terminator,
// has no body after the lead, or the lead is too long.
//
// See docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md §4.3.

export interface KeyPhraseSplit {
  keyPhrase: string | null;
  body: string;
}

const MAX_KEY_PHRASE_LEN = 160;

// Matches the first complete sentence (greedy up to first ., !, or ?
// terminator). Captures the sentence and the remainder.
const SENTENCE_RE = /^([^.!?\n]+[.!?])\s*([\s\S]*)$/;

export function parseKeyPhrase(content: string): KeyPhraseSplit {
  const trimmed = content.trim();

  // Skip parse when content opens with structural markdown.
  if (
    trimmed.startsWith("```") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("- ") ||
    trimmed.startsWith("* ") ||
    /^\d+\.\s/.test(trimmed)
  ) {
    return { keyPhrase: null, body: trimmed };
  }

  const match = trimmed.match(SENTENCE_RE);
  if (!match) {
    return { keyPhrase: null, body: trimmed };
  }

  const lead = match[1].trim();
  const rest = match[2].trim();

  if (lead.length > MAX_KEY_PHRASE_LEN) {
    return { keyPhrase: null, body: trimmed };
  }

  if (rest.length === 0) {
    // Nothing after the lead — don't elevate a single sentence.
    return { keyPhrase: null, body: trimmed };
  }

  return { keyPhrase: lead, body: rest };
}
