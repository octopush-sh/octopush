import { RefreshCw, X, Laptop } from "lucide-react";
import { useHistoryStore } from "../stores/historyStore";
import { runStatusMeta } from "../lib/runStatus";
import { formatRelTime } from "../lib/relTime";
import { ModalShell } from "./ModalShell";

/** Global cross-machine run History (Pro-real Part B / B1). Lists the signed-in
 *  Pro user's terminal Direct runs from every machine they've signed in on —
 *  task, status, cost, when, and which machine. Read-only.
 *
 *  SECURITY: every synced value (task, workspace name, machine name) originates
 *  on another machine and is rendered as INERT TEXT via JSX children only — never
 *  `dangerouslySetInnerHTML`. Do not change that. */
export function HistorySheet() {
  const open = useHistoryStore((s) => s.open);
  const runs = useHistoryStore((s) => s.runs);
  const loading = useHistoryStore((s) => s.loading);
  const error = useHistoryStore((s) => s.error);
  const close = useHistoryStore((s) => s.close);
  const refresh = useHistoryStore((s) => s.refresh);

  if (!open) return null;

  return (
    <ModalShell onClose={close} ariaLabel="Run history" panelClassName="w-full max-w-[620px]">
      <div className="flex max-h-[72vh] flex-col overflow-hidden rounded-xl border border-octo-hairline bg-octo-panel shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-octo-hairline px-6 pt-5 pb-4">
          <div className="min-w-0">
            <span className="font-mono text-[11px] uppercase tracking-wide text-octo-brass">
              Direct · history across machines
            </span>
            <h2 className="mt-1 font-serif text-[18px] leading-tight text-octo-ivory">
              Your runs, on every machine.
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          {runs.length === 0 ? (
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
          ) : (
            <ul>
              {runs.map((run) => {
                const meta = runStatusMeta(run.status);
                const t = Date.parse(run.created_at);
                const when = Number.isNaN(t) ? "" : formatRelTime(t);
                return (
                  <li
                    key={run.run_id}
                    className="border-b border-octo-hairline/60 px-6 py-3 last:border-b-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 ${meta.className}`}>{meta.glyph}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-octo-ivory">
                        {run.task}
                      </span>
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
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
