/**
 * UpdateNotifier — silent auto-check + the brass "Update available" toast.
 *
 * State is read from `useUpdaterStore` so the manual "Check for updates"
 * button in Settings (and any future surface) shares the same state.
 *
 * Background behavior:
 *   - Triggers one check on mount (fresh app launch).
 *   - Re-checks every 6 hours.
 *   - Silent on failure for background checks.
 *
 * Toast shows only when `phase === "available"` and the user hasn't
 * dismissed the current version. "no-update" / "error" states from
 * background checks stay invisible — Settings is where the user
 * inspects those.
 */

import { useEffect } from "react";
import { Download, X, Loader2 } from "lucide-react";
import { useUpdaterStore } from "../stores/updaterStore";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function UpdateNotifier() {
  const phase = useUpdaterStore((s) => s.phase);
  const update = useUpdaterStore((s) => s.update);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);
  const dismissed = useUpdaterStore((s) => s.dismissed);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);
  const installAndRelaunch = useUpdaterStore((s) => s.installAndRelaunch);
  const dismiss = useUpdaterStore((s) => s.dismiss);

  useEffect(() => {
    checkForUpdates(false);
    const id = setInterval(() => checkForUpdates(false), CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [checkForUpdates]);

  const installing = phase === "downloading" || phase === "installing";
  const visible =
    (phase === "available" && !dismissed) || installing || phase === "error";

  if (!visible || !update) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-[340px] rounded-xl bg-octo-panel"
      style={{
        border: "1px solid var(--brass-dim)",
        boxShadow:
          "0 20px 50px -10px rgba(0,0,0,0.6), 0 0 0 6px rgba(212, 165, 116, 0.04)",
      }}
    >
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <Download
          size={14}
          className="mt-0.5 shrink-0 text-octo-brass"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
            Update available
          </div>
          <div className="mt-0.5 font-serif italic text-[14px] leading-tight text-octo-ivory">
            Octopush {update.version} is ready.
          </div>
          {update.body && (
            <div className="mt-1 line-clamp-3 text-[11px] leading-[1.5] text-octo-sage">
              {update.body}
            </div>
          )}
          {error && (
            <div className="mt-1.5 text-[11px] leading-[1.45] text-octo-rouge">
              Install failed: {error}
            </div>
          )}
        </div>
        {!installing && (
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-sage"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {phase === "downloading" && progress > 0 && progress < 100 && (
        <div className="px-4 pb-2">
          <div
            className="h-[3px] overflow-hidden rounded-sm"
            style={{ background: "var(--color-octo-hairline)" }}
          >
            <div
              className="h-full transition-all"
              style={{
                width: `${progress}%`,
                background: "var(--color-octo-brass)",
              }}
            />
          </div>
          <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
            Downloading · {progress}%
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-octo-hairline px-3 py-2">
        <button
          type="button"
          onClick={dismiss}
          disabled={installing}
          className="rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute transition-colors hover:text-octo-sage disabled:opacity-40"
        >
          Later
        </button>
        <button
          type="button"
          onClick={installAndRelaunch}
          disabled={installing}
          className="ml-auto flex items-center gap-1.5 rounded px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-brass transition-colors disabled:opacity-40"
          style={{
            background: "var(--brass-ghost)",
            border: "1px solid var(--brass-dim)",
          }}
        >
          {installing ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Download size={11} />
          )}
          {phase === "installing"
            ? "Installing…"
            : phase === "downloading"
              ? "Downloading…"
              : "Install & restart"}
        </button>
      </div>
    </div>
  );
}
