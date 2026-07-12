import { Settings, NotebookPen, History } from "lucide-react";
import { RunsTray } from "./RunsTray";
import { OctoMark } from "./icons/OctoMark";
import { useHistoryStore } from "../stores/historyStore";
import { useUpgradeStore } from "../stores/upgradeStore";
import { useEntitlement } from "../hooks/useEntitlement";
import { useMascotState } from "../hooks/useMascotState";

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
  /** Open the Mission Control room (the fleet cockpit). */
  onOpenMissionControl: () => void;
}

export function AppTopBar({ onOpenSettings, onToggleScratchpad, onOpenMissionControl }: Props) {
  const openHistory = useHistoryStore((s) => s.openSheet);
  const showUpgrade = useUpgradeStore((s) => s.show);
  const { hasFeature } = useEntitlement();
  const mascot = useMascotState();

  const onHistoryClick = () => {
    if (hasFeature("history.sync")) {
      void openHistory();
    } else {
      showUpgrade({ feature: "history.sync", used: 0, limit: 0 });
    }
  };

  return (
    <div
      data-tauri-drag-region
      className="flex h-[28px] w-full flex-shrink-0 items-center border-b border-octo-hairline bg-octo-panel pl-[78px] pr-3"
    >
      {/* Center logo + wordmark */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
        {/* The live mascot — body language mirrors app state (spec §4.4):
            needs-you → blocked (frozen, eyes half-mast), agents busy →
            working (paddling, eyes scanning), otherwise idle. */}
        <span
          role="img"
          aria-label={mascot.label}
          title={mascot.label}
          className="flex shrink-0 items-center [--octo-eye:var(--color-octo-panel)]"
        >
          <OctoMark size={20} state={mascot.state} />
        </span>
        <span className="brand-wordmark text-[13px] text-octo-brass">
          Octopush
        </span>
      </div>
      <RunsTray onOpen={onOpenMissionControl} />
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onHistoryClick}
          aria-label="Run history across your machines"
          title="Run history across your machines"
          className="flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
        >
          <History size={12} className="shrink-0" />
          History
        </button>
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
