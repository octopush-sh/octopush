import { useEffect, useMemo, useState } from "react";
import { Copy, Lock } from "lucide-react";
import { OverlayRoom, RoomClose } from "./primitives/OverlayRoom";
import { ipc } from "../lib/ipc";
import { isUpgradeRequired } from "../lib/upgradeError";
import { useUpgradeStore } from "../stores/upgradeStore";
import { useEntitlementStore } from "../stores/entitlementStore";
import { copyToClipboard } from "../lib/clipboard";
import { INTENT_ICON } from "../lib/missionIntent";
import {
  PERIODS,
  type PeriodKey,
  periodRange,
  fmtHours,
  logbookTotals,
  logbookToMarkdown,
} from "../lib/logbook";
import type { LogbookMissionRow, ProjectInfo } from "../lib/types";

const LOGBOOK_FEATURE = "logbook.reports";

type Scope = "project" | "global";

interface Props {
  open: boolean;
  onClose: () => void;
  project: ProjectInfo | null;
}

/**
 * The Logbook Room — the cross-mission rollup (⌘⇧L). Project and global scopes
 * are Pro (`logbook.reports`); per-mission stays free in the Companion card.
 * A free user still opens the room but meets a proactive upsell rather than a
 * failed fetch.
 */
export function LogbookRoom({ open, onClose, project }: Props) {
  const entitled = useEntitlementStore((s) => s.hasFeature(LOGBOOK_FEATURE));
  const showUpgrade = useUpgradeStore((s) => s.show);

  const [scope, setScope] = useState<Scope>(project ? "project" : "global");
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [rows, setRows] = useState<LogbookMissionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // With no project open, project scope has nothing to key off — force global.
  const effScope: Scope = project ? scope : "global";
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";
  const scopeLabel = effScope === "project" ? (project?.name ?? "Project") : "All missions";

  useEffect(() => {
    if (!open || !entitled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { from, to } = periodRange(period, new Date());
    const scopeId = effScope === "project" ? (project?.id ?? null) : null;
    void ipc
      .logbookSummary(effScope, scopeId, from, to)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        const up = isUpgradeRequired(e);
        if (up) showUpgrade(up);
        else setError(String(e).split("\n")[0]);
        setRows(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, entitled, effScope, period, project?.id, showUpgrade]);

  const totals = useMemo(() => logbookTotals(rows ?? []), [rows]);
  const sorted = useMemo(
    () => [...(rows ?? [])].sort((a, b) => b.costUsd - a.costUsd),
    [rows],
  );

  const onCopy = () => {
    if (!rows || rows.length === 0) return;
    void copyToClipboard(
      logbookToMarkdown(rows, { scopeLabel, periodLabel: `Last ${periodLabel}` }),
      "Logbook copied as Markdown",
    );
  };

  if (!open) return null;

  const hasRows = !!rows && rows.length > 0;

  return (
    <OverlayRoom onClose={onClose} ariaLabel="Logbook">
      <header className="flex flex-wrap items-baseline gap-x-5 gap-y-3 border-b border-octo-hairline px-8 py-6">
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
          Logbook
        </span>

        {/* Scope switch — hidden when there is no project to scope to. */}
        {project && (
          <Segmented
            options={[
              { key: "project", label: project.name },
              { key: "global", label: "All missions" },
            ]}
            value={scope}
            onChange={(k) => setScope(k as Scope)}
          />
        )}

        <Segmented
          options={PERIODS.map((p) => ({ key: p.key, label: p.label }))}
          value={period}
          onChange={(k) => setPeriod(k as PeriodKey)}
        />

        <span className="ml-auto flex shrink-0 items-baseline gap-4">
          {entitled && hasRows && (
            <>
              <span className="flex items-baseline gap-3 font-mono text-[11px]">
                <span className="octo-tabular text-octo-sage" title="Total worked time">
                  {fmtHours(totals.hoursSecs)}
                </span>
                {totals.savingsUsd > 0 && (
                  <span
                    className="octo-tabular text-octo-verdigris"
                    title="Saved vs an all-premium baseline"
                  >
                    saved ${totals.savingsUsd.toFixed(2)}
                  </span>
                )}
                <span className="octo-tabular text-octo-brass" title="Total spend">
                  spent ${totals.costUsd.toFixed(2)}
                </span>
              </span>
              <button
                type="button"
                onClick={onCopy}
                title="Copy this Logbook as Markdown"
                aria-label="Copy this Logbook as Markdown"
                className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute transition-colors duration-[180ms] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              >
                <Copy size={12} aria-hidden />
                Copy
              </button>
            </>
          )}
          <RoomClose onClose={onClose} label="Close Logbook" />
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-8 pb-8">
        {!entitled ? (
          <Upsell onUpgrade={() => showUpgrade({ feature: LOGBOOK_FEATURE, used: 0, limit: 0 })} />
        ) : loading && !hasRows ? (
          <p className="mt-10 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-octo-mute octo-fade-in">
            Gathering the logbook…
          </p>
        ) : error ? (
          <p className="mt-10 text-center text-[13px] text-octo-sage octo-fade-in">{error}</p>
        ) : !hasRows ? (
          <div className="mt-16 flex flex-col items-center gap-2 octo-fade-in">
            <p className="font-serif text-[17px] text-octo-ivory">Nothing logged yet.</p>
            <p className="text-[12px] text-octo-mute">
              Work in this {effScope === "project" ? "project" : "workspace"} over the last{" "}
              {periodLabel.toLowerCase()} will collect here.
            </p>
          </div>
        ) : (
          <LogbookTable rows={sorted} />
        )}
      </div>
    </OverlayRoom>
  );
}

/** A small mono segmented control — brass ink marks the active option. */
function Segmented({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={active}
            className={`max-w-[160px] truncate rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors duration-[180ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
              active ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function LogbookTable({ rows }: { rows: LogbookMissionRow[] }) {
  return (
    <table className="mt-6 w-full border-collapse text-[13px]">
      <thead>
        <tr className="border-b border-octo-hairline text-left font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
          <th className="py-2 pr-4 font-normal">Mission</th>
          <th className="py-2 pr-4 text-right font-normal">Worked</th>
          <th className="py-2 pr-4 text-right font-normal">Spent</th>
          <th className="py-2 pr-4 text-right font-normal">Saved</th>
          <th className="py-2 pr-4 text-right font-normal">Runs</th>
          <th className="py-2 text-right font-normal">Messages</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const Icon = INTENT_ICON[r.intent] ?? INTENT_ICON.build;
          return (
            <tr
              key={r.missionId}
              className="octo-rise-in border-b border-octo-hairline/60"
              style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
            >
              <td className="max-w-[280px] py-2.5 pr-4">
                <span className="flex items-center gap-2">
                  <Icon size={13} className="shrink-0 text-octo-mute" aria-hidden />
                  <span className="truncate text-octo-ivory" title={r.title}>
                    {r.title}
                  </span>
                </span>
              </td>
              <td className="octo-tabular py-2.5 pr-4 text-right text-octo-sage">
                {fmtHours(r.hoursSecs)}
              </td>
              <td className="octo-tabular py-2.5 pr-4 text-right text-octo-brass">
                ${r.costUsd.toFixed(2)}
              </td>
              <td className="octo-tabular py-2.5 pr-4 text-right text-octo-verdigris">
                {r.savingsUsd > 0 ? `$${r.savingsUsd.toFixed(2)}` : "—"}
              </td>
              <td className="octo-tabular py-2.5 pr-4 text-right text-octo-mute">{r.runsCount}</td>
              <td className="octo-tabular py-2.5 text-right text-octo-mute">{r.messagesCount}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The Pro upsell shown to a free user who opens the room. */
function Upsell({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div className="mx-auto mt-16 flex max-w-[440px] flex-col items-center gap-4 text-center octo-fade-in">
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-octo-hairline text-octo-brass">
        <Lock size={18} aria-hidden />
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
        Logbook · reports
      </span>
      <h2 className="font-serif text-[19px] leading-snug text-octo-ivory">
        See where every mission's hours and dollars went.
      </h2>
      <p className="text-[13px] leading-relaxed text-octo-sage">
        Per-mission totals are always free. Upgrade to Pro for the cross-mission rollup — worked
        time, spend, and savings across a whole project or your entire studio, in one view, with
        export.
      </p>
      <button
        type="button"
        onClick={onUpgrade}
        className="mt-2 rounded-lg bg-octo-brass px-4 py-2 font-serif text-sm text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi"
      >
        Upgrade to Pro
      </button>
    </div>
  );
}
