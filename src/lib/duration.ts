/**
 * Compact elapsed/duration formatter from milliseconds.
 *
 * Sub-minute values read as `1.2s` (one decimal — snappy for fast tool calls);
 * a minute or more reads as `m:ss`. Stable, tabular-friendly width. Distinct
 * from `useElapsed` (which is `mm:ss`, 1s granularity) because live tool cards
 * want sub-second feedback. Negative inputs clamp to 0.
 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}:${String(rem).padStart(2, "0")}`;
}
