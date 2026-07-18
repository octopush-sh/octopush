import type { LogbookMissionRow } from "./types";

/** Compact worked-time formatting: `45s` · `12m` · `3h 20m`. Shared by the
 *  Companion Logbook card and the Logbook Room. */
export function fmtHours(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export type PeriodKey = "7d" | "30d" | "all";

export interface Period {
  key: PeriodKey;
  label: string;
  /** Days back from `to`, or null for all-time. */
  days: number | null;
}

export const PERIODS: Period[] = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "all", label: "All time", days: null },
];

/** The far-past sentinel for the all-time window — matches the Companion card's
 *  mission-lifetime lower bound so both surfaces agree. */
const EPOCH_START = "2000-01-01T00:00:00+00:00";

/** Grammatical phrase for a period, for prose/export: `Last 7 days` · `Last 30
 *  days` · `All time` (the all-time case takes no "Last" prefix). */
export function periodPhrase(key: PeriodKey): string {
  const p = PERIODS.find((x) => x.key === key);
  if (!p) return "";
  return p.days === null ? p.label : `Last ${p.label}`;
}

/** Resolve a period preset to an ISO `[from, to]` window. Pure — takes `now` so
 *  it stays deterministic and testable. */
export function periodRange(key: PeriodKey, now: Date): { from: string; to: string } {
  const to = now.toISOString();
  const period = PERIODS.find((p) => p.key === key);
  if (!period || period.days === null) return { from: EPOCH_START, to };
  const from = new Date(now.getTime() - period.days * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

/** Aggregate totals across a scope's mission rows. Worked seconds sum cleanly —
 *  distinct missions are disjoint work; the union clamp only matters *within* a
 *  mission (handled server-side). */
export function logbookTotals(rows: LogbookMissionRow[]): {
  hoursSecs: number;
  costUsd: number;
  savingsUsd: number;
  missions: number;
} {
  return {
    hoursSecs: rows.reduce((a, r) => a + r.hoursSecs, 0),
    costUsd: rows.reduce((a, r) => a + r.costUsd, 0),
    savingsUsd: rows.reduce((a, r) => a + r.savingsUsd, 0),
    missions: rows.length,
  };
}

/** Serialize a Logbook scope to a Markdown report — the Room's "Copy as
 *  Markdown" export. Pure so it can be unit-tested without a clipboard. */
export function logbookToMarkdown(
  rows: LogbookMissionRow[],
  opts: { scopeLabel: string; periodLabel: string },
): string {
  const t = logbookTotals(rows);
  const lines: string[] = [];
  lines.push(`# Logbook — ${opts.scopeLabel}`);
  lines.push("");
  lines.push(`_${opts.periodLabel}_`);
  lines.push("");
  lines.push(
    `**Total:** ${fmtHours(t.hoursSecs)} worked · $${t.costUsd.toFixed(2)} spent · ` +
      `saved $${t.savingsUsd.toFixed(2)} across ${t.missions} mission${t.missions === 1 ? "" : "s"}`,
  );
  lines.push("");
  lines.push("| Mission | Intent | Worked | Spent | Saved | Runs | Messages |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const r of [...rows].sort((a, b) => b.costUsd - a.costUsd)) {
    // Guard the pipe so a mission title can't break the table.
    const title = r.title.replace(/\|/g, "\\|");
    lines.push(
      `| ${title} | ${r.intent} | ${fmtHours(r.hoursSecs)} | $${r.costUsd.toFixed(2)} | ` +
        `$${r.savingsUsd.toFixed(2)} | ${r.runsCount} | ${r.messagesCount} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
