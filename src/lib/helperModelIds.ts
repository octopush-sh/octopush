// The synchronous half of `helperModels.ts`, with no IPC import: pure modules
// (the builder graph, which test-setup loads before any mock) read it safely.

/** `fast`: the cheap tier (rename). `review`: the balanced tier (drafting, review). */
export type HelperTier = "fast" | "review";

/** Used until the backend answers, or when it can't. Must stay a current
 *  builtin of that tier — `helperModels.test.ts` rejects the legacy ids. */
export const HELPER_MODEL_FALLBACK: Record<HelperTier, string> = {
  fast: "claude-haiku-5-5",
  review: "claude-sonnet-5-5",
};

const resolved: Partial<Record<HelperTier, string>> = {};

/** The tier's model right now, for synchronous defaults: the looked-up id once
 *  `resolveHelperModel` answered, else the fallback. */
export function helperModelNow(tier: HelperTier): string {
  return resolved[tier] ?? HELPER_MODEL_FALLBACK[tier];
}

/** The looked-up id, if one was recorded (`helperModels.ts` only). */
export function knownHelperModel(tier: HelperTier): string | undefined {
  return resolved[tier];
}

/** Record a looked-up id (`helperModels.ts` only). */
export function rememberHelperModel(tier: HelperTier, id: string): void {
  resolved[tier] = id;
}

/** Test hook. */
export function _forgetHelperModels(): void {
  delete resolved.fast;
  delete resolved.review;
}
