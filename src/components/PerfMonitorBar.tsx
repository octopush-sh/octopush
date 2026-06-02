import { useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { usePerfStore } from "../stores/perfStore";
import { formatBytes } from "../lib/formatBytes";
import { ipc } from "../lib/ipc";
import type { ProcGroup, WorkspaceCacheSizes } from "../lib/types";

function PerfRow({ label, g }: { label: string; g: ProcGroup }) {
  return (
    <div className="flex items-center gap-3 whitespace-nowrap px-1 py-0.5">
      <span className="w-16 text-octo-sage">{label}</span>
      <span className="w-16 text-right text-octo-ivory">{formatBytes(g.rssBytes)}</span>
      <span className="w-10 text-right text-octo-ivory">{Math.round(g.cpuPct)}%</span>
      <span className="w-16 text-right text-octo-mute">{g.processCount} proc</span>
    </div>
  );
}

interface PerfMonitorBarProps {
  workspacePath?: string;
  /** Rail collapsed state — when provided, a toggle button appears on the
   *  left of the footer. The collapse icon was relocated here from the rail
   *  itself so the rail's own chrome stays clean. */
  isRailCollapsed?: boolean;
  onToggleRail?: () => void;
}

export function PerfMonitorBar({
  workspacePath,
  isRailCollapsed,
  onToggleRail,
}: PerfMonitorBarProps) {
  const stats = usePerfStore((s) => s.stats);
  const [open, setOpen] = useState(false);
  const [caches, setCaches] = useState<WorkspaceCacheSizes | null>(null);
  const [scanning, setScanning] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    if (!open || !workspacePath) return;
    let cancelled = false;
    setScanning(true);
    setCaches(null);
    setFetchError(false);
    ipc.getWorkspaceCacheSizes(workspacePath)
      .then((c) => { if (!cancelled) setCaches(c); })
      .catch(() => { if (!cancelled) { setCaches(null); setFetchError(true); } })
      .finally(() => { if (!cancelled) setScanning(false); });
    return () => { cancelled = true; };
  }, [open, workspacePath]);

  return (
    <div className="relative flex h-[28px] w-full flex-shrink-0 items-center justify-end border-t border-octo-hairline bg-octo-panel px-3 font-mono text-[11px] text-octo-mute">
      {onToggleRail && (
        <button
          type="button"
          onClick={onToggleRail}
          aria-label={`${isRailCollapsed ? "Expand" : "Collapse"} workspace rail`}
          aria-pressed={isRailCollapsed}
          title={`${isRailCollapsed ? "Expand" : "Collapse"} workspace rail`}
          className="mr-auto flex items-center justify-center rounded p-0.5 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
        >
          {isRailCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      )}
      {!stats ? (
        <span className="flex items-center gap-2">
          <span className="text-octo-brass">⌗</span>
          <span>measuring…</span>
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Performance details"
            aria-expanded={open}
            className="flex items-center gap-2 hover:text-octo-sage"
          >
            <span className="text-octo-brass">⌗</span>
            <span className="text-octo-brass">{formatBytes(stats.total.rssBytes)}</span>
            <span>·</span>
            <span>
              CPU{" "}
              <span className="text-octo-brass">{Math.round(stats.total.cpuPct)}%</span>
            </span>
            <span>·</span>
            <span className="text-octo-brass">{formatBytes(stats.disk.freeBytes)}</span>
            <span>free</span>
            <span className="text-octo-mute">{open ? "▾" : "▸"}</span>
          </button>
          {open && (
            <div className="absolute bottom-[32px] right-2 z-50 min-w-[220px] rounded-md border border-octo-hairline bg-octo-panel-2 p-2 shadow-lg">
              <PerfRow label="App" g={stats.app} />
              <PerfRow label="Daemon" g={stats.daemon} />
              {/* ── Workspace caches section ── */}
              <div className="mt-2 px-1">
                <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute mb-1">
                  Workspace Caches
                </div>
                {scanning && (
                  <div className="py-0.5 text-octo-mute">scanning…</div>
                )}
                {!scanning && !workspacePath && (
                  <div className="py-0.5 text-octo-mute">—</div>
                )}
                {!scanning && workspacePath && fetchError && (
                  <div className="py-0.5 text-octo-mute">couldn't read caches</div>
                )}
                {!scanning && workspacePath && !fetchError && caches && caches.entries.length === 0 && (
                  <div className="py-0.5 text-octo-mute">no build caches</div>
                )}
                {!scanning && caches && caches.entries.length > 0 && (
                  <>
                    {caches.entries.map((entry) => (
                      <div key={entry.name} className="flex items-center justify-between gap-3 whitespace-nowrap py-0.5">
                        <span className="text-octo-sage">{entry.name}</span>
                        <span className="font-mono text-octo-ivory">{formatBytes(entry.bytes)}</span>
                      </div>
                    ))}
                    <div className="mt-0.5 flex items-center justify-between gap-3 border-t border-octo-hairline pt-0.5">
                      <span className="text-octo-mute">total</span>
                      <span className="font-mono text-octo-ivory">{formatBytes(caches.totalBytes)}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
