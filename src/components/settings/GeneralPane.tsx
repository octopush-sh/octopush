// Settings → General — application-wide behavior (attention chime, workspace
// defaults, the Talk turn budget, and future app-wide preferences). Editor
// preferences live in their own pane.
import { useEffect, useState } from "react";
import { useAttentionStore } from "../../stores/attentionStore";
import { useWorkspacePrefs } from "../../stores/workspacePrefsStore";
import { MODES, MODE_LABELS } from "../../lib/modes";
import { ipc } from "../../lib/ipc";
import { Stepper } from "../controls/Stepper";
import { PaneHeader, SectionLabel, SegmentedRow, ToggleRow } from "./shared";
import { useNotifyPrefs } from "../../stores/notifyPrefsStore";

const MODE_OPTIONS = MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }));

/** Talk's "Tool turns per message" range — mirrors the backend clamp in
 *  `chat_history.rs` (`TALK_MAX_ITERATIONS_MIN/MAX`, `DEFAULT_TALK_MAX_ITERATIONS`). */
export const TALK_TURNS_DEFAULT = 25;
export const TALK_TURNS_MIN = 5;
export const TALK_TURNS_MAX = 200;
export const TALK_TURNS_STEP = 5;

export function GeneralPane() {
  const crewNotifications = useNotifyPrefs((s) => s.crewNotifications);
  const setCrewNotifications = useNotifyPrefs((s) => s.setCrewNotifications);
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
          <SectionLabel>Talk</SectionLabel>
          <TalkTurnsRow />
        </div>

        <div className="space-y-4">
          <SectionLabel>Attention</SectionLabel>
          <ToggleRow
            label="Play sound when an agent or terminal needs attention"
            description="A short chime plays when a chat finishes a response or a terminal rings the bell in a workspace you're not currently looking at."
            checked={soundEnabled}
            onChange={setSoundEnabled}
          />
          <ToggleRow
            label="Notify when a crew needs you"
            description="A native notification when a crew needs a decision (gate, halt, budget) — always — or finishes while Octopush isn't focused. So a fleet can work unattended."
            checked={crewNotifications}
            onChange={setCrewNotifications}
          />
        </div>
      </div>
    </>
  );
}

function clampTurns(n: number): number {
  return Math.min(TALK_TURNS_MAX, Math.max(TALK_TURNS_MIN, Math.round(n)));
}

/** "Tool turns per message" — how many rounds of tool calls one Talk turn may
 *  run before the engine asks the model to close with what it has. Persisted
 *  in `settings.json` (`talkMaxIterations`); read-modify-write so the other
 *  settings fields aren't clobbered. */
function TalkTurnsRow() {
  const [turns, setTurns] = useState(TALK_TURNS_DEFAULT);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        if (typeof s.talkMaxIterations === "number") setTurns(clampTurns(s.talkMaxIterations));
      })
      .catch(() => {});
  }, []);

  async function change(next: number) {
    const value = clampTurns(next);
    setTurns(value);
    try {
      const s = await ipc.getSettings();
      await ipc.saveSettings({ ...s, talkMaxIterations: value });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      // Leave the stepper where the user put it; the next change retries.
    }
  }

  return (
    <div
      data-testid="talk-turns-row"
      className="flex items-center justify-between gap-4 rounded-lg px-4 py-3"
      style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="font-serif text-[14px] leading-tight text-octo-ivory">Tool turns per message</div>
        <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">
          Rounds of tool calls one message may run before Octopush asks the model to answer with what it has.
          A long review or refactor needs more; the default is {TALK_TURNS_DEFAULT}.
        </div>
        {saved && <div className="mt-1 font-mono text-[10px] text-octo-verdigris">Saved</div>}
      </div>
      <div className="shrink-0">
        <Stepper
          value={turns}
          min={TALK_TURNS_MIN}
          max={TALK_TURNS_MAX}
          step={TALK_TURNS_STEP}
          onChange={change}
          ariaLabel="Tool turns per message"
        />
      </div>
    </div>
  );
}
