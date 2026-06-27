import { ipc } from "./ipc";
import { pushToast } from "../components/Toasts";
import { useEntitlementStore } from "../stores/entitlementStore";

let active = false;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** After the user opens the Dodo checkout, detect the flip to Pro so the badge +
 *  gates update on their own — no manual sign-out / sign-in. The plan rides on
 *  the OAuth session, so two complementary triggers cover it without spamming
 *  Keychain access on an unsigned build:
 *
 *   • a lightweight **poll** (re-fetches userinfo via `auth_refresh`, no token
 *     rotation, persists only when the plan actually changes) — picks up the new
 *     plan as soon as Clerk reflects it; and
 *   • a single **forced token refresh** when the window regains focus (the user
 *     coming back from the browser) — a freshly-minted access token carries the
 *     latest `public_metadata` even if userinfo lagged behind the old token.
 *
 *  Bounded (~2 min) and single-flighted across overlapping checkouts. */
export function awaitProAfterCheckout(): void {
  if (active) return;
  active = true;
  let done = false;
  let forcedOnce = false;

  const stop = () => {
    done = true;
    active = false;
    window.removeEventListener("focus", onFocus);
  };

  const succeed = async () => {
    if (done) return;
    stop();
    await useEntitlementStore.getState().load();
    pushToast({ level: "success", title: "You're on Pro — premium unlocked." });
  };

  const planIsPro = async () => (await ipc.getEntitlement()).plan === "pro";

  // Trigger A — lightweight poll (no token rotation; userinfo persists on change).
  void (async () => {
    for (let i = 0; i < 30 && !done; i++) {
      await delay(4000);
      if (done) break;
      try {
        await ipc.authRefresh();
        if (await planIsPro()) {
          await succeed();
          return;
        }
      } catch {
        // transient (offline, etc.) — keep polling
      }
    }
    // Only release the guard if THIS watch is still the active one — a watch that
    // already finished (via the focus path) must not clobber a newer checkout's watch.
    if (!done) stop();
  })();

  // Trigger B — one forced token refresh when the user returns from checkout.
  const onFocus = async () => {
    if (done || forcedOnce) return;
    forcedOnce = true;
    try {
      if ((await ipc.authSyncPlan()) === "pro") await succeed();
    } catch {
      // ignore — the poll is still running as a backstop
    }
  };
  window.addEventListener("focus", onFocus);
}
