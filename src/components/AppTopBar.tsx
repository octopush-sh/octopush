import { Settings, NotebookPen } from "lucide-react";

/** A thin chrome bar at the very top of the app. Mirrors the bottom
 *  `PerfMonitorBar` in structure (full width, hairline border, panel bg)
 *  but sits above the main canvas + companion + rail.
 *
 *  The Tauri window already runs with `titleBarStyle: "Overlay"` +
 *  `hiddenTitle: true`, so the macOS traffic lights are drawn over our
 *  content at a fixed top-left position. The 78px left padding reserves
 *  room for them; the rest of the bar is a `data-tauri-drag-region` so
 *  the user can drag the window from any empty area.
 *
 *  Right-aligned controls (Settings, Scratchpad) sit inside the bar but
 *  carry their own click handlers — drag-region elements stop dragging
 *  the window when the user actually clicks an interactive child. */
interface Props {
  onOpenSettings: () => void;
  onToggleScratchpad: () => void;
}

export function AppTopBar({ onOpenSettings, onToggleScratchpad }: Props) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-[28px] w-full flex-shrink-0 items-center border-b border-octo-hairline bg-octo-panel pl-[78px] pr-3"
    >
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleScratchpad}
          aria-label="Toggle scratchpad"
          title="Toggle scratchpad"
          className="flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
        >
          <NotebookPen size={12} className="shrink-0" />
          Scratchpad
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Open settings"
          className="flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
        >
          <Settings size={12} className="shrink-0" />
          Settings
        </button>
      </div>
    </div>
  );
}
