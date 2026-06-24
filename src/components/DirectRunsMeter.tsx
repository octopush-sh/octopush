import { useEntitlement } from "../hooks/useEntitlement";

/** A quiet "Direct runs · this month" meter for the launcher ledger.
 *
 *  P0: informational only — `limit` is null (uncapped), so it shows just the
 *  count. Once a Free monthly cap is enforced (P2) it renders "N of M" and the
 *  count tints toward rouge as it fills. Consistent with how Octopush already
 *  surfaces spend honestly. */
/** Tint for the run count: sage while comfortable, amber past 80% of a cap,
 *  rouge once the cap is reached. Uncapped (P0) stays sage. */
function countTone(used: number, limit: number | null): string {
  if (limit == null || limit <= 0) return "text-octo-sage";
  const ratio = used / limit;
  if (ratio >= 1) return "text-octo-rouge";
  if (ratio >= 0.8) return "text-octo-warning";
  return "text-octo-sage";
}

export function DirectRunsMeter() {
  const { usage } = useEntitlement();
  if (!usage) return null;

  const { used, limit } = usage;

  return (
    <div className="min-w-0">
      <div className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
        direct runs · this month
      </div>
      <div className="octo-tabular font-mono text-xs text-octo-mute">
        <span className={countTone(used, limit)}>{used}</span>
        {limit != null ? (
          <span className="text-octo-mute"> of {limit}</span>
        ) : (
          <span className="text-octo-mute"> run{used === 1 ? "" : "s"}</span>
        )}
      </div>
    </div>
  );
}
