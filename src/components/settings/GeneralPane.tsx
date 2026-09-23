// Settings → General — application-wide behavior (attention chime, workspace
// defaults, the Talk turn budget, and future app-wide preferences). Editor
// preferences live in their own pane.
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
          <TurnsRow
            field="talkMaxIterations"
            label="Tool turns per message"
            description={`Rounds of tool calls one message may run before Octopush asks the model to answer with what it has. A long review or refactor needs more; the default is ${TALK_TURNS_DEFAULT}.`}
            testId="talk-turns-row"
          />
          <SubagentTurnsRow />
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

/** The director's own persisted turn budget ("Tool turns per message";
 *  `settings.json`, read-modify-write so the other settings fields aren't
 *  clobbered). */
function TurnsRow({
  field,
  label,
  description,
  testId,
}: {
  field: "talkMaxIterations";
  label: string;
  description: string;
  testId: string;
}) {
  const [turns, setTurns] = useState(TALK_TURNS_DEFAULT);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        const v = s[field];
        if (typeof v === "number") setTurns(clampTurns(v));
      })
      .catch(() => {});
  }, [field]);

  async function change(next: number) {
    const value = clampTurns(next);
    setTurns(value);
    try {
      const s = await ipc.getSettings();
      await ipc.saveSettings({ ...s, [field]: value });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      // Leave the stepper where the user put it; the next change retries.
    }
  }

  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-4 rounded-lg px-4 py-3"
      style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="font-serif text-[14px] leading-tight text-octo-ivory">{label}</div>
        <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">{description}</div>
        {saved && <div className="mt-1 font-mono text-[10px] text-octo-verdigris">Saved</div>}
      </div>
      <div className="shrink-0">
        <Stepper
          value={turns}
          min={TALK_TURNS_MIN}
          max={TALK_TURNS_MAX}
          step={TALK_TURNS_STEP}
          onChange={change}
          ariaLabel={label}
        />
      </div>
    </div>
  );
}

/** Sub-agent turns: **off by default — no limit.** A sub-agent runs until it
 *  finishes or is stopped, so the director never builds on a report cut
 *  mid-work. Switched on, one run may take the stepper's rounds (a
 *  definition's own `max-turns` applies under it) and a writing sub-agent
 *  that runs out pauses the conversation for more turns. Persists
 *  `subagentMaxTurns`: a number when limited, `null` when not. */
function SubagentTurnsRow() {
  const [limit, setLimit] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        const v = s.subagentMaxTurns;
        setLimit(typeof v === "number" ? clampTurns(v) : null);
      })
      .catch(() => {});
  }, []);

  async function persist(value: number | null) {
    setLimit(value);
    try {
      const s = await ipc.getSettings();
      await ipc.saveSettings({ ...s, subagentMaxTurns: value });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      // Leave the control where the user put it; the next change retries.
    }
  }

  const limited = limit !== null;
  return (
    <div
      data-testid="subagent-turns-row"
      className="rounded-lg px-4 py-3"
      style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[14px] leading-tight text-octo-ivory">Limit sub-agent tool turns</div>
          <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">
            Off, a sub-agent runs until it finishes or you stop it, so the director never builds on a report cut mid-work.
            On, one run may take this many rounds of tool calls; a definition's own max-turns applies under it, and a
            sub-agent that writes and runs out of turns pauses the conversation until you give it more or accept what it has.
          </div>
          {saved && <div className="mt-1 font-mono text-[10px] text-octo-verdigris">Saved</div>}
        </div>
        <Switch
          checked={limited}
          onChange={(on) => void persist(on ? TALK_TURNS_DEFAULT : null)}
          ariaLabel="Limit sub-agent tool turns"
          testId="subagent-turns-switch"
        />
      </div>
      <Reveal open={limited}>
        <div className="mt-3 flex items-center justify-between gap-4">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">turns per run</span>
          <Stepper
            value={limit ?? TALK_TURNS_DEFAULT}
            min={TALK_TURNS_MIN}
            max={TALK_TURNS_MAX}
            step={TALK_TURNS_STEP}
            onChange={(n) => void persist(clampTurns(n))}
            ariaLabel="Sub-agent tool turns"
          />
        </div>
      </Reveal>
    </div>
  );
}
