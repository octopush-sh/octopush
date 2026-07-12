// Settings → About — installed version and the in-app updater flow.
import { useEffect } from "react";
import { Download, RefreshCw, CheckCircle, Loader2 } from "lucide-react";
import { useUpdaterStore } from "../../stores/updaterStore";
import { PaneHeader, formatRelative } from "./shared";
import { OctoMark } from "../icons/OctoMark";

export function AboutPane() {
  const phase = useUpdaterStore((s) => s.phase);
  const update = useUpdaterStore((s) => s.update);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);
  const currentVersion = useUpdaterStore((s) => s.currentVersion);
  const lastCheckedAt = useUpdaterStore((s) => s.lastCheckedAt);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);
  const installAndRelaunch = useUpdaterStore((s) => s.installAndRelaunch);

  const checking = phase === "checking";
  const installing = phase === "downloading" || phase === "installing";

  // Resolve the version once on mount via the updater store helper.
  useEffect(() => {
    if (!currentVersion) {
      // Triggering a check side-effect populates currentVersion.
      checkForUpdates(false);
    }
    // We only want to do this once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastChecked = lastCheckedAt ? formatRelative(lastCheckedAt) : "never";

  return (
    <>
      <div className="mb-4"><OctoMark size={48} /></div>
      <PaneHeader
        eyebrow="About"
        title="Octopush."
        subtitle="The IDE for agentic developers — eight arms, zero wasted tokens."
      />

      <div className="max-w-[640px] space-y-6">
        {/* Version row */}
        <div
          className="flex items-baseline justify-between rounded-lg px-4 py-3"
          style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
        >
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
              Installed version
            </div>
            <div className="octo-tabular mt-0.5 font-serif text-[18px] leading-tight text-octo-ivory">
              {currentVersion ? `v${currentVersion}` : "—"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => checkForUpdates(true)}
            disabled={checking || installing}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-brass transition-colors disabled:opacity-40"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {checking ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            {checking ? "Checking…" : "Check for updates"}
          </button>
        </div>

        {/* State feedback */}
        {(phase === "available" || phase === "downloading" || phase === "installing") && update && (
          <div
            className="rounded-lg p-4"
            style={{ border: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }}
          >
            <div className="flex items-start gap-3">
              <Download size={14} className="mt-0.5 shrink-0 text-octo-brass" />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
                  New version
                </div>
                <div className="mt-0.5 font-serif text-[16px] leading-tight text-octo-ivory">
                  Octopush {update.version} is ready.
                </div>
                {update.body && (
                  <div className="mt-1.5 whitespace-pre-line text-[12px] leading-[1.55] text-octo-sage">
                    {update.body}
                  </div>
                )}
              </div>
            </div>

            {phase === "downloading" && progress > 0 && progress < 100 && (
              <div className="mt-3">
                <div className="h-[3px] overflow-hidden rounded-sm" style={{ background: "var(--color-octo-hairline)" }}>
                  <div
                    className="h-full transition-[width]"
                    style={{ width: `${progress}%`, background: "var(--color-octo-brass)" }}
                  />
                </div>
                <div className="octo-tabular mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                  Downloading · {progress}%
                </div>
              </div>
            )}

            <div className="mt-3 flex">
              <button
                type="button"
                onClick={installAndRelaunch}
                disabled={installing}
                className="ml-auto flex items-center gap-1.5 rounded px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-brass transition-colors disabled:opacity-40"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {installing ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                Install & restart
              </button>
            </div>
          </div>
        )}

        {phase === "no-update" && (
          <div className="flex items-center gap-2 text-[12px] text-octo-sage">
            <CheckCircle size={13} className="text-octo-verdigris" />
            <span className="font-serif">You're on the latest version.</span>
            <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
              Checked {lastChecked}
            </span>
          </div>
        )}

        {phase === "error" && error && (
          <div className="text-[12px] leading-[1.55] text-octo-rouge">
            Could not check for updates: {error}
          </div>
        )}

        {/* Reference info */}
        <ul className="space-y-1.5 text-[12px] leading-[1.55] text-octo-sage">
          <li>
            ·{" "}
            <a
              href="https://github.com/johnatan-velez/octopush"
              target="_blank"
              rel="noopener"
              className="text-octo-brass underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass"
            >
              github.com/johnatan-velez/octopush
            </a>
          </li>
          <li>· Last checked for updates: <span className="font-mono text-octo-ivory">{lastChecked}</span></li>
          <li>· Updates are verified with an Ed25519 signature before install.</li>
        </ul>
      </div>
    </>
  );
}
