import { useState } from "react";
import { Hourglass } from "lucide-react";
import type { PendingCap } from "../../stores/chatStore";
import { iconForRole } from "../../lib/roleIcons";

/** The turn budgets the card can grant. */
export const CAP_TURN_OPTIONS = [15, 25, 50] as const;
export const DEFAULT_CAP_TURNS = 25;

/** `Give it 25 more turns` — the granting phrase. Pure so the wording is tested. */
export function grantLabel(turns: number): string {
  return `Give it ${turns} more turn${turns === 1 ? "" : "s"}`;
}

interface Props {
  cap: PendingCap;
  /** `extraTurns` to continue, `null` to accept the partial report. */
  onRespond: (extraTurns: number | null) => void;
}

/**
 * Inline turn-limit card: a sub-agent that WRITES ran out of turns mid-work.
 * The director's turn is paused on this card, so nothing is built on a
 * half-done implementation unless the user says so. Brass, not rouge: it is
 * a decision, not a danger.
 */
export function SubagentCapCard({ cap, onRespond }: Props) {
  const [turns, setTurns] = useState<number>(DEFAULT_CAP_TURNS);
  const RoleIcon = iconForRole(cap.subagentType ?? "");
  return (
    <div
      data-testid="subagent-cap-card"
      className="octo-rise-in my-2 rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <Hourglass size={14} className="shrink-0 text-octo-brass" />
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
          Turn limit reached
        </span>
        <span className="ml-auto font-mono text-[10px] text-octo-mute">
          the director is waiting
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[12.5px] leading-[1.5] text-octo-sage">
        <span title={cap.subagentType ?? "sub-agent"} className="shrink-0 text-octo-sage">
          <RoleIcon size={12} strokeWidth={1.75} />
        </span>
        <span className="min-w-0">
          <span className="text-octo-ivory">{cap.description}</span>
          {cap.subagentType && <span className="font-mono text-[11px] text-octo-mute"> · {cap.subagentType}</span>}
          <span> used its {cap.turnsUsed} turns and stopped mid-work.</span>
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
          turns
          <select
            value={turns}
            onChange={(e) => setTurns(Number(e.target.value))}
            aria-label="More turns to give"
            title="How many more tool turns the sub-agent may take"
            className="rounded bg-octo-onyx px-1 py-0.5 font-mono text-[10px] tracking-normal text-octo-ivory outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            {CAP_TURN_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => onRespond(turns)}
          title="Resume this sub-agent where it left off; the director waits for the full report"
          className="rounded-md px-3 py-1 font-serif text-[12px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          {grantLabel(turns)}
        </button>
        <button
          type="button"
          onClick={() => onRespond(null)}
          title="Hand the director the partial report as it stands; it will say what is done and what is not"
          className="ml-auto font-mono text-[10px] text-octo-mute transition-colors hover:text-octo-sage"
        >
          Accept what it has
        </button>
      </div>
    </div>
  );
}
