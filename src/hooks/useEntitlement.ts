import { useEffect } from "react";
import { useEntitlementStore } from "../stores/entitlementStore";

/** Read the current entitlement (premium scaffolding). Loads once on first use.
 *
 *  P0: everyone is Free with everything granted, so `hasFeature` is always true
 *  and `usage.limit` is null. The meaningful gates live in the Rust core — this
 *  hook only drives UX (meters, upgrade nudges). */
export function useEntitlement() {
  const entitlement = useEntitlementStore((s) => s.entitlement);
  const usage = useEntitlementStore((s) => s.usage);
  const loaded = useEntitlementStore((s) => s.loaded);
  const load = useEntitlementStore((s) => s.load);
  const hasFeature = useEntitlementStore((s) => s.hasFeature);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return {
    plan: entitlement.plan,
    features: entitlement.features,
    hasFeature,
    usage,
    loaded,
    reload: load,
  };
}
