/**
 * UpdateAlert — the launch-time "Update available" dialog with the release
 * notes. Opened by `updaterStore.launchCheck()` (via `flushAlert`, which
 * waits until no other dialog is open). Actions: install and relaunch, later
 * (this launch only), skip this version (persisted).
 */
import { Download, Loader2 } from "lucide-react";
import { useUpdaterStore } from "../stores/updaterStore";
import { ModalShell } from "./ModalShell";
import { ReleaseNotes } from "./ReleaseNotes";

/** `2026-10-30T06:00:00Z` → `October 30, 2026` (null when unparseable). */
export function formatReleaseDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function UpdateAlert() {
  const open = useUpdaterStore((s) => s.alertOpen);
  const update = useUpdaterStore((s) => s.update);
  const phase = useUpdaterStore((s) => s.phase);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);
  const installAndRelaunch = useUpdaterStore((s) => s.installAndRelaunch);
  const dismissAlert = useUpdaterStore((s) => s.dismissAlert);
  const skipVersion = useUpdaterStore((s) => s.skipVersion);

  if (!open || !update) return null;

  const installing = phase === "downloading" || phase === "installing";
  const released = formatReleaseDate(update.date);
  const close = () => {
    if (!installing) dismissAlert();
  };

  return (
    <ModalShell onClose={close} closeOnBackdrop={false} ariaLabel="Update available" panelClassName="w-full max-w-[560px]">
      <div className="flex max-h-[80vh] flex-col rounded-xl border border-octo-hairline bg-octo-panel shadow-2xl">
        <div className="px-6 pt-6">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">Update available</div>
          <h2 className="mt-1.5 font-serif text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
            Octopush {update.version} is ready.
          </h2>
          <div className="octo-tabular mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">
            {[released, update.channel === "beta" ? "beta" : null, `you have v${update.currentVersion}`]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>

        <div className="octo-selectable mt-4 min-h-0 flex-1 overflow-y-auto border-y border-octo-hairline px-6 py-4">
          {update.body?.trim() ? (
            <ReleaseNotes markdown={update.body} />
          ) : (
            <p className="text-[13px] leading-[1.6] text-octo-sage">This release carries no notes.</p>
          )}
        </div>

        {phase === "downloading" && progress > 0 && progress < 100 && (
          <div className="px-6 pt-3 octo-fade-in">
            <div className="h-[3px] overflow-hidden rounded-sm bg-octo-hairline">
              <div className="h-full bg-octo-brass transition-[width]" style={{ width: `${progress}%` }} />
            </div>
            <div className="octo-tabular mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
              Downloading · {progress}%
            </div>
          </div>
        )}
        {phase === "error" && error && (
          <div className="px-6 pt-3 text-[12px] leading-[1.5] text-octo-rouge octo-fade-in">Install failed: {error}</div>
        )}

        <div className="flex items-center gap-2 px-6 py-4">
          <button
            type="button"
            onClick={() => void skipVersion()}
            disabled={installing}
            className="rounded-lg px-3 py-2 text-[12px] text-octo-mute transition-colors hover:text-octo-sage disabled:opacity-40"
          >
            Skip this version
          </button>
          <button
            type="button"
            onClick={close}
            disabled={installing}
            className="ml-auto rounded-lg border border-octo-hairline px-3 py-2 text-[12px] text-octo-sage transition-colors hover:text-octo-ivory disabled:opacity-40"
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => void installAndRelaunch()}
            disabled={installing}
            autoFocus
            className="flex items-center gap-2 rounded-lg px-4 py-2 font-serif text-[14px] text-octo-brass transition-colors hover:text-octo-brass-hi disabled:opacity-60"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {installing ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Download size={13} aria-hidden />}
            {phase === "installing" ? "Installing…" : phase === "downloading" ? "Downloading…" : "Install and relaunch"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
