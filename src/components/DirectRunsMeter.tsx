import { useEntitlement } from "../hooks/useEntitlement";

/** A quiet "Direct runs · this month" meter for the launcher ledger.
 *
 *  P0: informational only — `limit` is null (uncapped), so it shows just the
 *  count. Once a Free monthly cap is enforced (P2) it renders "N of M" and the
 *  count tints toward rouge as it fills. Consistent with how Octopush already
 *  surfaces spend honestly. */
export function DirectRunsMeter() {
  const { usage } = useEntitlement();
  if (!usage) return null;

  const { used, limit } = usage;
  const ratio = limit && limit > 0 ? used / limit : 0;
  const countTone =
    limit == null ? "text-octo-sage" : ratio >= 1 ? "text-octo-rouge" : ratio >= 0.8 ? "text-octo-warning" : "text-octo-sage";

  return (
    <div className="min-w-0">
      <div className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
        direct runs · this month
      </div>
      <div className="octo-tabular font-mono text-xs text-octo-mute">
        <span className={countTone}>{used}</span>
        {limit != null ? (
          <span className="text-octo-mute"> of {limit}</span>
        ) : (
          <span className="text-octo-mute"> run{used === 1 ? "" : "s"}</span>
        )}
      </div>
    </div>
  );
}
