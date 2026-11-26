import { create } from "zustand";
import { ipc, type Entitlement, type DirectRunUsage } from "../lib/ipc";

/** Premium scaffolding (P0). The entitlement is fetched from the Rust core,
 *  which today returns a Free plan that grants everything (so nothing is gated
 *  yet). The frontend mirrors it for UX; the real gates live in the backend.
 *  See docs/premium/accounts-and-subscriptions-implementation-plan.md. */

const FREE: Entitlement = { plan: "free", features: [], directRunsPerMonth: null };

interface EntitlementState {
  entitlement: Entitlement;
  usage: DirectRunUsage | null;
  loaded: boolean;
  load: () => Promise<void>;
  hasFeature: (key: string) => boolean;
}

/** Subscribe once (on the first load) to Rust's `entitlement-changed` event:
 *  a background token refresh that changed the plan reloads the store, so the
 *  UI follows the gates without a relaunch. */
let watching = false;
function watchEntitlementChanges() {
  if (watching) return;
  watching = true;
  try {
    ipc
      .onEntitlementChanged(() => void useEntitlementStore.getState().load())
      .catch(() => {
        watching = false; // not in a Tauri window (tests, preview): retry next load
      });
  } catch {
    watching = false;
  }
}

/** Test-only: forget the subscription so each test starts fresh. */
export function __resetEntitlementWatchForTests() {
  watching = false;
}

export const useEntitlementStore = create<EntitlementState>((set, get) => ({
  entitlement: FREE,
  usage: null,
  loaded: false,

  load: async () => {
    watchEntitlementChanges();
    try {
      const [entitlement, usage] = await Promise.all([
        ipc.getEntitlement(),
        ipc.directRunUsage(),
      ]);
      set({ entitlement, usage, loaded: true });
    } catch {
      // Entitlement is non-critical to the local experience — default to Free
      // and mark loaded so the UI doesn't spin. (Offline grace lives in the
      // backend in later phases.)
      set({ loaded: true });
    }
  },

  hasFeature: (key) => get().entitlement.features.includes(key),
}));
