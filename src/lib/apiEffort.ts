// What "Off" (no reasoning effort) does on an API stage, per model.

/** Off on a model where it really means no extra thinking. */
export const EFFORT_OFF_TITLE = "No extra thinking (fastest, cheapest)";

/** Mirrors `openai_compat::effort_off_level`: the GPT-6 models that accept
 *  `reasoning.effort: "none"` on OpenAI's Responses API. */
const GPT6_EFFORT_NONE = ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra"];

/** The Off segment's tooltip on an API stage. GPT-6 reasons at `medium` when
 *  no effort is sent, so Off is `none` where OpenAI accepts it (Sol, Luna,
 *  6.1 Terra) and the model's default elsewhere (Astra, 6.1 Sol). A gateway
 *  (LiteLLM, OpenRouter) gets no effort at all, so the default applies there. */
export function apiEffortOffTitle(model: string): string {
  const id = model.trim().toLowerCase().split("/").pop() ?? "";
  if (!id.includes("gpt-6")) return EFFORT_OFF_TITLE;
  // The bare id or a dated snapshot only: another variant may not take none.
  return GPT6_EFFORT_NONE.some((m) => id.startsWith(m) && /^(-\d{4}-\d{2}-\d{2})?$/.test(id.slice(m.length)))
    ? "No reasoning (effort none on OpenAI; through a gateway, the model's default: medium)"
    : "OpenAI has no off level for this model, so it reasons at its default: medium";
}
