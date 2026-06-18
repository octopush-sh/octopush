// Settings → General — application-wide behavior (attention chime, and future
// app-wide preferences). Editor preferences now live in their own pane.
import { useAttentionStore } from "../../stores/attentionStore";
import { PaneHeader, SectionLabel, ToggleRow } from "./shared";

export function GeneralPane() {
  const soundEnabled = useAttentionStore((s) => s.soundEnabled);
  const setSoundEnabled = useAttentionStore((s) => s.setSoundEnabled);

  return (
    <>
      <PaneHeader
        eyebrow="General"
        title="The basics."
        subtitle="Application-wide preferences live here. More options will appear as the app grows."
      />

      <div className="max-w-[640px] space-y-4">
        <SectionLabel>Attention</SectionLabel>
        <ToggleRow
          label="Play sound when an agent or terminal needs attention"
          description="A short chime plays when a chat finishes a response or a terminal rings the bell in a workspace you're not currently looking at."
          checked={soundEnabled}
          onChange={setSoundEnabled}
        />
      </div>
    </>
  );
}
