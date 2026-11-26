import { ipc } from "./ipc";
import type { TaskType } from "./types";
import { HELPER_MODEL_FALLBACK, _forgetHelperModels, knownHelperModel, rememberHelperModel, type HelperTier } from "./helperModelIds";

// The models Octopush picks for its own one-shot helpers (commit and PR drafts,
// AI review, the workspace rename) and for new defaults (a Talk thread, a new
// builder stage). They come from the backend's builtin tag lookup
// (`suggest_model` → `builtin_anthropic_model_tagged`), so they follow the
// builtin lineup when a new generation ships instead of a literal going stale.

export { HELPER_MODEL_FALLBACK, helperModelNow, type HelperTier } from "./helperModelIds";

const TASK: Record<HelperTier, TaskType> = { fast: "quick_fix", review: "code_review" };

const pending = new Map<HelperTier, Promise<string>>();

/** The tier's model from the builtin tag lookup; the fallback if that fails
 *  (a failure is not cached, so a later call asks again). */
export function resolveHelperModel(tier: HelperTier): Promise<string> {
  const known = knownHelperModel(tier);
  if (known) return Promise.resolve(known);
  let p = pending.get(tier);
  if (!p) {
    p = Promise.resolve()
      .then(() => ipc.suggestModel(TASK[tier]))
      .then((s) => {
        if (!s?.modelId) return HELPER_MODEL_FALLBACK[tier];
        rememberHelperModel(tier, s.modelId);
        return s.modelId;
      })
      .catch(() => HELPER_MODEL_FALLBACK[tier])
      .finally(() => pending.delete(tier));
    pending.set(tier, p);
  }
  return p;
}

/** Test hook. */
export function _resetHelperModelsForTests(): void {
  _forgetHelperModels();
  pending.clear();
}
