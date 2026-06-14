import { SegmentedControl } from "../controls/SegmentedControl";
import { useChatStore, type Effort } from "../../stores/chatStore";

const OPTIONS: { value: Effort; label: string }[] = [
  { value: "swift", label: "Swift" },
  { value: "standard", label: "Standard" },
  { value: "deep", label: "Deep" },
];

/**
 * Generation-effort control for the composer — maps to the output-token budget
 * (Swift 8k · Standard 32k · Deep 64k). Uses the canonical SegmentedControl so
 * it matches Direct-mode form controls; no native select.
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
