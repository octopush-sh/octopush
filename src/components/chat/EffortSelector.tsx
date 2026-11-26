import { SegmentedControl } from "../controls/SegmentedControl";
import { useChatStore, type Effort } from "../../stores/chatStore";

/** Said once per option: on a model without an effort setting, only the cap
 *  applies. */
const NO_EFFORT_NOTE = "A model without an effort setting gets only the cap.";

export const OPTIONS: { value: Effort; label: string; title: string }[] = [
  {
    value: "swift",
    label: "Swift",
    title: `Swift · low reasoning effort · up to 8K output tokens · fastest and cheapest. ${NO_EFFORT_NOTE}`,
  },
  {
    value: "standard",
    label: "Standard",
    title: `Standard · medium reasoning effort · up to 32K output tokens · balanced (default). ${NO_EFFORT_NOTE}`,
  },
  {
    value: "deep",
    label: "Deep",
    title: `Deep · high reasoning effort · up to 64K output tokens · most thorough, slowest and costliest. ${NO_EFFORT_NOTE}`,
  },
];

/**
 * Generation-effort control for the composer: each preset sets the turn's
 * reasoning effort (Swift low · Standard medium · Deep high, `EFFORT_REASONING`)
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
