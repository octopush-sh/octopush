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

  const copy =
    info.feature === "runs.parallel"
      ? {
          eyebrow: "Direct · concurrency",
          title: "Run your crew in parallel with Pro.",
          body: (
            <>
              Free runs one Direct pipeline at a time. Upgrade to Pro to run{" "}
              <span className="text-octo-ivory">multiple workspaces concurrently</span> — and keep
              them going in the background.
            </>
          ),
        }
      : info.feature === "history.sync"
        ? {
            eyebrow: "Direct · history across machines",
            title: "Your runs, on every machine.",
            body: (
              <>
                Free keeps run history on the machine it ran on. Upgrade to Pro to{" "}
                <span className="text-octo-ivory">sync your Direct-run history across all your
                devices</span> — every run, its cost, and which machine it ran on.
              </>
            ),
          }
        : info.feature === "runs.detached"
        ? {
            eyebrow: "Direct · unattended crews",
            title: "Let your crews run while you're away.",
            body: (
              <>
                Free runs your crew only while Octopush is open. Upgrade to Pro to run them{" "}
                <span className="text-octo-ivory">unattended — detached, surviving app quit</span>,
                with a native ping when a crew needs you or finishes.
              </>
            ),
          }
        : info.feature === "logbook.reports"
        ? {
            eyebrow: "Logbook · reports",
            title: "Every mission's hours and dollars, in one view.",
            body: (
              <>
                Free shows each mission's own totals. Upgrade to Pro for the{" "}
                <span className="text-octo-ivory">cross-mission Logbook</span> — worked time,
                spend, and savings across a whole project or your entire studio, with export.
              </>
            ),
          }
        : {
            eyebrow: "Direct · monthly limit",
            title: "You've hit your monthly Direct-run limit.",
            body: (
              <>
                The Free plan includes {info.limit} Direct pipeline runs per month — you've used{" "}
                {info.used}. Upgrade to Pro for{" "}
                <span className="text-octo-ivory">unlimited Direct runs</span>, parallel and
                background runs, and full run history.
              </>
            ),
          };

  return (
    <ModalShell onClose={hide} ariaLabel="Upgrade to Pro" panelClassName="w-full max-w-[440px]">
      <div className="rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <span className="font-mono text-[11px] uppercase tracking-wide text-octo-brass">
          {copy.eyebrow}
        </span>
        <h2 className="mt-2 font-serif text-[18px] leading-tight text-octo-ivory">
          {copy.title}
        </h2>
        <p className="mt-3 text-[13px] leading-relaxed text-octo-sage">{copy.body}</p>
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
