import { RefreshCw, X, Laptop, ChevronLeft } from "lucide-react";
import { useHistoryStore } from "../stores/historyStore";
import { runStatusMeta, stageStatusWord } from "../lib/runStatus";
import { formatRelTime } from "../lib/relTime";
import { labelForRole } from "../lib/stageMeta";
import { iconForRole, iconForTool } from "../lib/roleIcons";
import { ModalShell } from "./ModalShell";
import { FadeSwap } from "./primitives/FadeSwap";
import { StageDots } from "./direct/StageDots";
import { DiffViewer } from "./DiffViewer";
import type { SyncedRun, SyncedRunStageDetail } from "../lib/ipc";

/** Global cross-machine run History (Pro-real Part B). The list (B1) shows the
 *  signed-in Pro user's terminal Direct runs from every machine; drilling into
 *  a run (B2) fetches its full story — per-stage journals, artifact texts, and
 *  diff snapshots — lazily from the cloud. Read-only.
 *
 *  SECURITY: every synced value (task, names, journal lines, artifacts, diffs)
 *  originates on another machine and is rendered as INERT TEXT via JSX children
 *  only — never `dangerouslySetInnerHTML`. Do not change that. */
export function HistorySheet() {
  const open = useHistoryStore((s) => s.open);
  const runs = useHistoryStore((s) => s.runs);
  const loading = useHistoryStore((s) => s.loading);
  const error = useHistoryStore((s) => s.error);
  const viewedRunId = useHistoryStore((s) => s.viewedRunId);
  const close = useHistoryStore((s) => s.close);
  const closeRun = useHistoryStore((s) => s.closeRun);
  const refresh = useHistoryStore((s) => s.refresh);

  if (!open) return null;

  const viewedRun = viewedRunId ? runs.find((r) => r.run_id === viewedRunId) ?? null : null;

  return (
    <ModalShell onClose={close} ariaLabel="Run history" panelClassName="w-full max-w-[720px]">
      <div className="flex max-h-[76vh] flex-col overflow-hidden rounded-xl border border-octo-hairline bg-octo-panel shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-octo-hairline px-6 pt-5 pb-4">
          <div className="flex min-w-0 items-start gap-2">
            {viewedRun && (
              <button
                type="button"
                onClick={closeRun}
                aria-label="Back to the history list"
                title="Back to the list"
                className="mt-0.5 shrink-0 rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-ivory"
              >
                <ChevronLeft size={14} />
              </button>
            )}
            <div className="min-w-0">
              <span className="font-mono text-[11px] uppercase tracking-wide text-octo-brass">
                Direct · history across machines
              </span>
              <h2 className="mt-1 truncate font-serif text-[18px] leading-tight text-octo-ivory" title={viewedRun?.task}>
                {viewedRun ? viewedRun.task : "Your runs, on every machine."}
              </h2>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!viewedRun && (
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading}
                aria-label="Refresh history"
                title="Refresh from the cloud"
                className="rounded p-1.5 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass disabled:opacity-50"
              >
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              </button>
            )}
            <button
              type="button"
              onClick={close}
              aria-label="Close history"
              title="Close"
              className="rounded p-1.5 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-ivory"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {error && runs.length > 0 && !viewedRun && (
          <div className="border-b border-octo-hairline px-6 py-1.5 font-mono text-[10px] text-octo-mute">
            Couldn't refresh — showing last-known history.
          </div>
        )}

        <FadeSwap swapKey={viewedRun ? viewedRun.run_id : "list"} className="min-h-0 flex-1 overflow-y-auto">
          {viewedRun ? <RunDetailView run={viewedRun} /> : <RunList runs={runs} loading={loading} error={error} />}
        </FadeSwap>
      </div>
    </ModalShell>
  );
}

function RunList({ runs, loading, error }: { runs: SyncedRun[]; loading: boolean; error: string | null }) {
  const openRun = useHistoryStore((s) => s.openRun);
  if (runs.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <p className="text-[13px] text-octo-sage">
          {loading ? "Syncing your run history…" : "No synced runs yet."}
        </p>
        {!loading && (
          <p className="mt-1.5 text-[12px] text-octo-mute">
            Finish a Direct run and it will appear here — on all your machines.
          </p>
        )}
        {!loading && error && (
          <p className="mt-3 font-mono text-[11px] text-octo-mute">
            Couldn't reach the sync service. Showing the last-known history.
          </p>
        )}
      </div>
    );
  }
  return (
    <ul>
      {runs.map((run) => {
        const meta = runStatusMeta(run.status);
        const t = Date.parse(run.created_at);
        const when = Number.isNaN(t) ? "" : formatRelTime(t);
        return (
          <li key={run.run_id} className="border-b border-octo-hairline/60 last:border-b-0">
            <button
              type="button"
              onClick={() => void openRun(run.run_id)}
              title="Read what this crew did"
              className="block w-full px-6 py-3 text-left opacity-45 transition-opacity duration-[180ms] hover:opacity-85 focus-visible:opacity-85 focus-visible:outline-none"
            >
              <div className="flex items-center gap-2">
                <span className={`shrink-0 ${meta.className}`}>{meta.glyph}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-octo-ivory">{run.task}</span>
                <span className="shrink-0 font-mono text-[12px] text-octo-brass octo-tabular">
                  ${run.cost_usd.toFixed(2)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-octo-mute">
                <span className={meta.className}>{meta.word}</span>
                {run.workspace_name && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="truncate">{run.workspace_name}</span>
                  </>
                )}
                {run.machine_name && (
                  <>
                    <span aria-hidden>·</span>
                    <Laptop size={10} className="shrink-0" />
                    <span className="truncate">{run.machine_name}</span>
                  </>
                )}
                {when && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{when}</span>
                  </>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One synced run's full story, fetched lazily (B2). Read-only; inert text. */
function RunDetailView({ run }: { run: SyncedRun }) {
  const detail = useHistoryStore((s) => s.detailByRun[run.run_id]);
  const detailLoading = useHistoryStore((s) => s.detailLoading);
  const detailError = useHistoryStore((s) => s.detailError);
  const openRun = useHistoryStore((s) => s.openRun);
  const meta = runStatusMeta(run.status);

  return (
    <div className="px-6 py-4">
      {/* The run at a glance — machine · when · status · dots. */}
      <div className="flex items-center gap-2 font-mono text-[10px] text-octo-mute">
        <span className={meta.className}>{meta.word}</span>
        {run.machine_name && (
          <>
            <span aria-hidden>·</span>
            <Laptop size={10} className="shrink-0" />
            <span className="truncate">{run.machine_name}</span>
          </>
        )}
        {run.workspace_name && (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{run.workspace_name}</span>
          </>
        )}
        <span aria-hidden>·</span>
        <span className="octo-tabular shrink-0 text-octo-brass">${run.cost_usd.toFixed(2)}</span>
        {detail && detail.stages.length > 0 && (
          <StageDots
            className="ml-auto shrink-0"
            stages={detail.stages.map((s) => ({ status: s.status, title: labelForRole(s.role) }))}
          />
        )}
      </div>

      {detailLoading && (
        <p className="py-10 text-center text-[13px] text-octo-sage">Fetching this run's story…</p>
      )}

      {!detailLoading && detailError && (
        <div className="py-10 text-center">
          <p className="text-[13px] text-octo-sage">Couldn't fetch this run's story.</p>
          <button
            type="button"
            onClick={() => void openRun(run.run_id)}
            className="mt-3 rounded-md border border-octo-hairline px-3 py-1.5 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:border-[var(--brass-dim)]"
          >
            Try again
          </button>
        </div>
      )}

      {!detailLoading && !detailError && detail === null && (
        <p className="py-10 text-center text-[13px] text-octo-mute">
          This run synced before journals were kept — only its summary is available.
        </p>
      )}

      {!detailLoading && !detailError && detail && (
        <div className="mt-3 flex flex-col gap-5">
          {detail.stages.map((stage) => (
            <StageSection key={`${detail.run_id}-${stage.position}`} stage={stage} />
          ))}
        </div>
      )}
    </div>
  );
}

function StageSection({ stage }: { stage: SyncedRunStageDetail }) {
  const RoleIcon = iconForRole(stage.role);
  const word = stageStatusWord(stage.status);
  return (
    <section>
      {/* Stage header — icon · role · position · model · status · cost. */}
      <div className="flex items-center gap-2 border-b border-octo-hairline pb-1.5">
        <RoleIcon size={13} className="shrink-0 text-octo-sage" aria-hidden />
        <span className="min-w-0 truncate font-serif text-[14px] text-octo-ivory">
          {labelForRole(stage.role)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-octo-mute">
          {stage.position + 1}
          {stage.model ? ` · ${stage.model}` : ""} · {word}
        </span>
        <span className="octo-tabular shrink-0 font-mono text-[11px] text-octo-brass">
          ${stage.cost_usd.toFixed(2)}
        </span>
      </div>

      {stage.error && (
        <p className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-octo-rouge">
          {stage.error}
        </p>
      )}

      {stage.artifact && (
        <p className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-octo-sage">
          {stage.artifact}
        </p>
      )}

      {stage.journal.length > 0 && <Journal entries={stage.journal} />}

      {stage.diff && (
        <div className="mt-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
            worktree when this stage finished
          </div>
          <DiffViewer diff={stage.diff} />
        </div>
      )}
    </section>
  );
}

/** A journal entry as this build understands it. Anything else is skipped —
 *  the wire format is forward-compatible by ignoring the unknown. */
interface JournalLine {
  kind: string;
  text?: string;
  tool?: string;
  hint?: string;
}

function asJournalLine(v: unknown): JournalLine | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== "string") return null;
  return {
    kind: o.kind,
    text: typeof o.text === "string" ? o.text : undefined,
    tool: typeof o.tool === "string" ? o.tool : undefined,
    hint: typeof o.hint === "string" ? o.hint : undefined,
  };
}

/** The stage's work journal, rendered as inert mono lines. */
function Journal({ entries }: { entries: unknown[] }) {
  const lines = entries.map(asJournalLine).filter((l): l is JournalLine => l !== null);
  if (lines.length === 0) return null;
  return (
    <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2">
      {lines.map((l, i) => {
        if (l.kind === "tool" && l.tool) {
          const ToolIcon = iconForTool(l.tool);
          return (
            <div key={i} className="flex items-baseline gap-1.5 py-0.5 font-mono text-[11px] text-octo-sage">
              <ToolIcon size={11} className="shrink-0 translate-y-[1.5px] text-octo-mute" aria-hidden />
              <span className="shrink-0">{l.tool}</span>
              {l.hint && <span className="min-w-0 truncate text-octo-mute">{l.hint}</span>}
            </div>
          );
        }
        if ((l.kind === "text" || l.kind === "notice") && l.text) {
          return (
            <div
              key={i}
              className={`whitespace-pre-wrap py-0.5 font-mono text-[11px] leading-relaxed ${
                l.kind === "notice" ? "text-octo-verdigris" : "text-octo-sage"
              }`}
            >
              {l.text}
            </div>
          );
        }
        return null; // reset markers, tool_results, unknown kinds
      })}
    </div>
  );
}
