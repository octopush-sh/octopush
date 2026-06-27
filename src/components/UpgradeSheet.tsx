import { useUpgradeStore } from "../stores/upgradeStore";
import { ipc } from "../lib/ipc";
import { awaitProAfterCheckout } from "../lib/awaitPro";
import { pushToast } from "./Toasts";
import { ModalShell } from "./ModalShell";

/** Shown when a Free user hits the monthly Direct-run cap (P2). The plan + the
 *  Dodo checkout link come from the Rust core; checkout opens in the browser. */
export function UpgradeSheet() {
  const info = useUpgradeStore((s) => s.info);
  const hide = useUpgradeStore((s) => s.hide);
  if (!info) return null;

  const upgrade = async () => {
    try {
      const url = await ipc.billingCheckoutUrl();
      await ipc.openFileInSystem(url);
      hide();
      awaitProAfterCheckout();
    } catch (e) {
      console.error("Failed to open checkout:", e);
      pushToast({ level: "error", title: "Couldn't open checkout" });
    }
  };

  return (
    <ModalShell onClose={hide} ariaLabel="Upgrade to Pro" panelClassName="w-full max-w-[440px]">
      <div className="rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <span className="font-mono text-[11px] uppercase tracking-wide text-octo-brass">
          Direct · monthly limit
        </span>
        <h2 className="mt-2 font-serif text-[18px] leading-tight text-octo-ivory">
          You've hit your monthly Direct-run limit.
        </h2>
        <p className="mt-3 text-[13px] leading-relaxed text-octo-sage">
          The Free plan includes {info.limit} Direct pipeline runs per month — you've used{" "}
          {info.used}. Upgrade to Pro for <span className="text-octo-ivory">unlimited Direct runs</span>,
          parallel and background runs, and full run history.
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={hide}
            className="rounded-md px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage"
          >
            Maybe later
          </button>
          <button
            type="button"
            onClick={() => void upgrade()}
            className="rounded-lg bg-octo-brass px-4 py-2 font-serif text-sm text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi"
          >
            Upgrade to Pro
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
