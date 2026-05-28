import { useState } from "react";
import { usePerfStore } from "../stores/perfStore";
import { formatBytes } from "../lib/formatBytes";
import type { ProcGroup } from "../lib/types";

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

export function PerfMonitorBar() {
  const stats = usePerfStore((s) => s.stats);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative flex h-[22px] w-full flex-shrink-0 items-center border-t border-octo-hairline bg-octo-panel px-3 font-mono text-[11px] text-octo-mute">
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
            <span className="text-octo-mute">{open ? "▾" : "▸"}</span>
          </button>
          {open && (
            <div className="absolute bottom-[26px] left-2 z-50 rounded-md border border-octo-hairline bg-octo-panel-2 p-2 shadow-lg">
              <PerfRow label="App" g={stats.app} />
              <PerfRow label="Daemon" g={stats.daemon} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
