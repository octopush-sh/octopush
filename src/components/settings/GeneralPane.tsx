// Settings → General — application-wide behavior (attention chime, workspace
// defaults, the Talk turn limits — off by default — and future app-wide
// preferences). Editor preferences live in their own pane.
import { useEffect, useState } from "react";
import { useAttentionStore } from "../../stores/attentionStore";
import { useWorkspacePrefs } from "../../stores/workspacePrefsStore";
import { MODES, MODE_LABELS } from "../../lib/modes";
import { ipc } from "../../lib/ipc";
import { Stepper } from "../controls/Stepper";
import { Reveal } from "../primitives/Reveal";
import { PaneHeader, SectionLabel, SegmentedRow, Switch, ToggleRow } from "./shared";
import { useNotifyPrefs } from "../../stores/notifyPrefsStore";

const MODE_OPTIONS = MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }));

/** Talk's turn-limit range — mirrors the backend clamp in `chat_history.rs`
 *  (`TALK_MAX_ITERATIONS_MIN/MAX`). Both limits are OFF by default (no
 *  limit); `TALK_TURNS_DEFAULT` is only the value a freshly switched-on
 *  limit starts at. */
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
          <LimitTurnsRow
            field="talkMaxIterations"
            label="Limit tool turns per message"
            description="Off, a message runs as many rounds of tool calls as the answer needs, until the model answers or you stop it. On, Octopush asks the model to answer with what it has after this many rounds."
            stepperLabel="Tool turns per message"
            testId="talk-turns-row"
          />
          <LimitTurnsRow
            field="subagentMaxTurns"
            label="Limit sub-agent tool turns"
            description="Off, a sub-agent runs until it finishes or you stop it, so the director never builds on a report cut mid-work. On, one run may take this many rounds of tool calls; a definition's own max-turns applies under it, and a sub-agent that writes and runs out of turns pauses the conversation until you give it more or accept what it has."
            stepperLabel="Sub-agent tool turns"
            testId="subagent-turns-row"
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

/** One persisted turn limit, **off by default — no limit**: the director's
 *  own rounds (`talkMaxIterations`) or one sub-agent run's
 *  (`subagentMaxTurns`). A switch turns the limit on (starting at
 *  `TALK_TURNS_DEFAULT`) and reveals the rounds stepper; off again persists
 *  `null`. Read-modify-write on `settings.json` so the other fields aren't
 *  clobbered. */
function LimitTurnsRow({
  field,
  label,
  description,
  stepperLabel,
  testId,
}: {
  field: "talkMaxIterations" | "subagentMaxTurns";
  label: string;
  description: string;
  stepperLabel: string;
  testId: string;
}) {
  const [limit, setLimit] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        const v = s[field];
        setLimit(typeof v === "number" ? clampTurns(v) : null);
      })
      .catch(() => {});
  }, [field]);

  async function persist(value: number | null) {
    setLimit(value);
    try {
      const s = await ipc.getSettings();
      await ipc.saveSettings({ ...s, [field]: value });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      // Leave the control where the user put it; the next change retries.
    }
  }

  const limited = limit !== null;
  return (
    <div
      data-testid={testId}
      className="rounded-lg px-4 py-3"
      style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[14px] leading-tight text-octo-ivory">{label}</div>
          <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">{description}</div>
          {saved && <div className="mt-1 font-mono text-[10px] text-octo-verdigris">Saved</div>}
        </div>
        <Switch
          checked={limited}
          onChange={(on) => void persist(on ? TALK_TURNS_DEFAULT : null)}
          ariaLabel={label}
          testId={`${testId}-switch`}
        />
      </div>
      <Reveal open={limited}>
        <div className="mt-3 flex items-center justify-between gap-4">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">rounds</span>
          <Stepper
            value={limit ?? TALK_TURNS_DEFAULT}
            min={TALK_TURNS_MIN}
            max={TALK_TURNS_MAX}
            step={TALK_TURNS_STEP}
            onChange={(n) => void persist(clampTurns(n))}
            ariaLabel={stepperLabel}
          />
        </div>
      </Reveal>
    </div>
  );
}
