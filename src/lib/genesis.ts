// Prompt genesis — pure helpers for turning a raw "what do you want to build"
// prompt into a project. No LLM here: the name is derived locally so genesis
// works before any provider key is configured.

/** The one canonical scope promise — the single source for every genesis
 *  surface's copy (honesty constitution). Never promise a finished app. */
export const GENESIS_PROMISE =
  "A crew scaffolds it and ships a first working slice — you direct every gate.";

/** Filler words dropped when deriving a project name from a prompt. Exported so
 *  the test pins the list. */
export const GENESIS_STOPWORDS = new Set([
  "a", "an", "the", "i", "me", "my", "we", "our", "you", "your", "it", "its",
  "this", "that", "these", "to", "of", "in", "into", "on", "for", "from", "and",
  "or", "with", "without", "so", "as", "at", "by", "is", "are", "be", "am",
  "build", "builds", "make", "makes", "create", "creates", "write", "develop",
  "want", "wants", "would", "like", "need", "needs", "please", "help", "let",
  "lets", "some", "new", "app", "apps", "application", "project", "program",
  "software", "tool", "thing", "something", "which", "can", "will", "should",
  "me", "us",
]);

/** Keep ASCII word chars only, lowercased. */
function cleanToken(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Derive a filesystem/git-safe project slug from a build prompt: drop filler
 * words, keep the first ~4 significant tokens, join with `-`. E.g. "Build me an
 * iOS app to track my daily tasks" → "ios-track-daily-tasks". Falls back to the
 * raw tokens (then "new-project") when everything is filler.
 */
export function deriveProjectName(prompt: string): string {
  const words = prompt.split(/\s+/).map(cleanToken).filter(Boolean);
  const significant = words.filter((w) => !GENESIS_STOPWORDS.has(w));
  const picked = (significant.length > 0 ? significant : words).slice(0, 4);
  return picked.join("-") || "new-project";
}
