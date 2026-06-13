import { runStatusMeta, savingsVsBaseline } from "../../lib/runStatus";
import { formatRelTime } from "../../lib/relTime";
import type { Run } from "../../lib/ipc";

interface Props {
  run: Run;
  pipelineName: string | null;
  selected: boolean;
  onSelect: () => void;
}

/** The richer main-canvas card for a single Direct run — the dashboard
 *  counterpart to the cramped CompanionRuns list row. Pure presentational. */
export function RunCard({ run, pipelineName, selected, onSelect }: Props) {
  const meta = runStatusMeta(run.status);
  const { saved, pct } = savingsVsBaseline(run.costUsd, run.baselineUsd);
  const showSaved = run.baselineUsd > 0 && saved > 0;
  // Guard a malformed/legacy timestamp so the slot reads "—" rather than the
  // literal "Invalid Date" formatRelTime would yield from NaN.
  const createdMs = Date.parse(run.createdAt);
  const when = Number.isNaN(createdMs) ? "—" : formatRelTime(createdMs);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`octo-rise-in flex w-full flex-col gap-2 rounded-md border px-4 py-3 text-left transition-colors duration-[180ms] ${
        selected
          ? "border-octo-brass bg-[var(--brass-ghost)]"
          : "border-octo-hairline hover:border-[var(--brass-dim)]"
      }`}
    >
      {/* Top row: status (left) · relative time (right). Both in fixed slots so
          the row never reflows as words/timestamps change width. */}
      <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
        <span className="flex items-center gap-1.5" title={meta.word}>
          {/* Fixed glyph slot — the one status glyph on the card. */}
          <span className={`w-2 shrink-0 text-center ${meta.className}`}>{meta.glyph}</span>
          <span className={meta.className}>{meta.word}</span>
          {run.status === "running" && (
            <span
              className="octo-stage-pulse ml-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-octo-verdigris"
              title="In flight"
              aria-hidden="true"
            />
          )}
          {run.status === "paused" && (
            <span
              className="ml-0.5 rounded-full border border-octo-brass px-1.5 py-px text-[9px] uppercase tracking-[0.15em] text-octo-brass"
              title="Awaiting your decision"
            >
              decide
            </span>
          )}
        </span>
        <span className="octo-tabular shrink-0 text-octo-mute" title="Started">
          {when}
        </span>
      </div>

      {/* Task — the moment of the card, in serif. */}
      <div className="line-clamp-2 font-serif text-[14px] leading-snug text-octo-ivory">
        {run.task || "(untitled run)"}
      </div>

      {/* Meta line: pipeline · cost (· saved) · issue. */}
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-octo-mute">
        {pipelineName && <span className="min-w-0 truncate">{pipelineName}</span>}
        <span className="octo-tabular shrink-0">
          {pipelineName ? "· " : ""}${run.costUsd.toFixed(2)}
          {showSaved && (
            <span className="text-octo-verdigris">
              {" · saved "}${saved.toFixed(2)} ({pct}%)
            </span>
          )}
        </span>
        {run.linkedIssueKey && <span className="shrink-0">· {run.linkedIssueKey}</span>}
      </div>
    </button>
  );
}
