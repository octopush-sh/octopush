import { SegmentedControl } from "../controls/SegmentedControl";
import { useChatStore, type Effort } from "../../stores/chatStore";

export const OPTIONS: { value: Effort; label: string; title: string }[] = [
  {
    value: "swift",
    label: "Swift",
    title:
      "Swift · the least reasoning the model takes, never more than Standard: a lower effort, thinking never turned on · up to 8K output tokens · fastest and cheapest. A model without an effort setting, or one that thinks only with a budget, gets nothing extra.",
  },
  {
    value: "standard",
    label: "Standard",
    title:
      "Standard · the model's own default reasoning, with no effort or thinking setting sent · up to 32K output tokens · balanced (default)",
  },
  {
    value: "deep",
    label: "Deep",
    title:
      "Deep · the most reasoning the model takes: effort max, or high where max isn't offered, or a 24K thinking budget on models that use one · up to 64K output tokens · most thorough, slowest and costliest. A model with neither gets only the cap.",
  },
];

/**
 * Generation-effort control for the composer: each preset sets the turn's
 * reasoning effort (Swift low · Standard the model's default, nothing sent ·
 * Deep the model's highest, `EFFORT_REASONING`)
 * and its output-token cap (8k · 32k · 64k, `EFFORT_MAX_TOKENS`). Uses the
 * canonical SegmentedControl so it matches Direct-mode form controls; no
 * native select.
 */
export function EffortSelector() {
  const effort = useChatStore((s) => s.effort);
  const setEffort = useChatStore((s) => s.setEffort);
  return (
    <SegmentedControl
      options={OPTIONS}
      value={effort}
      onChange={setEffort}
      ariaLabel="Generation effort"
    />
  );
}
