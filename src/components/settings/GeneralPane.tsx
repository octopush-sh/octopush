// Settings → General — application-wide behavior (attention chime, workspace
// defaults, and future app-wide preferences). Editor preferences live in their
// own pane.
import { useAttentionStore } from "../../stores/attentionStore";
import { useWorkspacePrefs } from "../../stores/workspacePrefsStore";
import { MODES, MODE_LABELS } from "../../lib/modes";
import { PaneHeader, SectionLabel, SegmentedRow, ToggleRow } from "./shared";

const MODE_OPTIONS = MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }));

export function GeneralPane() {
  const soundEnabled = useAttentionStore((s) => s.soundEnabled);
  const setSoundEnabled = useAttentionStore((s) => s.setSoundEnabled);
  const defaultMode = useWorkspacePrefs((s) => s.defaultMode);
  const setDefaultMode = useWorkspacePrefs((s) => s.setDefaultMode);

  return (
    <>
      <PaneHeader
        eyebrow="General"
        title="The basics."
        subtitle="Application-wide preferences live here. More options will appear as the app grows."
      />

      <div className="max-w-[640px] space-y-8">
        <div className="space-y-4">
          <SectionLabel>Workspace defaults</SectionLabel>
          <SegmentedRow
            label="Default mode for new workspaces"
            description="The mode a workspace opens in when you create it. Existing workspaces fall back to this too until you switch them."
            value={defaultMode}
            options={MODE_OPTIONS}
            onChange={setDefaultMode}
            ariaLabel="Default workspace mode"
            testId="default-mode-segmented"
          />
        </div>

        <div className="space-y-4">
          <SectionLabel>Attention</SectionLabel>
          <ToggleRow
            label="Play sound when an agent or terminal needs attention"
            description="A short chime plays when a chat finishes a response or a terminal rings the bell in a workspace you're not currently looking at."
            checked={soundEnabled}
            onChange={setSoundEnabled}
          />
        </div>
      </div>
    </>
  );
}
