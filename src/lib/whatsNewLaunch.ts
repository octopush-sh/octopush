// When the What's new dialog opens by itself (after an update) and the
// user-driven ways to reopen it (command palette, Settings › About).
import { getVersion } from "@tauri-apps/api/app";
import { isModalOpen } from "../components/ModalShell";
import { pushToast } from "../components/Toasts";
import { useUpdaterStore, type UpdaterPhase } from "../stores/updaterStore";
import { useTourStore } from "../stores/tourStore";
import { useWhatsNewPrefs, useWhatsNewStore } from "../stores/whatsNewStore";
import { decideLaunch, tipsForVersion, type VersionTips } from "./whatsNew";
import { releasedTips, unreleasedTips } from "./whatsNewBundle";

/** Mirrors UpdateNotifier's visibility rule: the corner update alert is up. */
export function updateAlertVisible(s: { phase: UpdaterPhase; update: unknown; dismissed: boolean }): boolean {
  if (!s.update) return false;
  return (s.phase === "available" && !s.dismissed) || s.phase === "downloading" || s.phase === "installing" || s.phase === "error";
}

/** The dialog may open on its own only when nothing else holds the screen:
 *  no dialog, no update alert, no tour, not already open. */
export function canAutoOpen(): boolean {
  return (
    !isModalOpen() &&
    !updateAlertVisible(useUpdaterStore.getState()) &&
    !useTourStore.getState().active &&
    useWhatsNewStore.getState().phase === "closed"
  );
}

export interface LaunchDeps {
  version?: () => Promise<string>;
  tips?: () => VersionTips[];
  /** How often to re-check whether the screen is free (default 500ms). */
  pollMs?: number;
  /** Override the "screen is free" rule (tests). */
  canOpen?: () => boolean;
}

/** The launch check: compare the installed version with the last one seen and,
 *  after an upgrade, open the dialog with every newer version's tips once the
 *  screen is free. A fresh install (or an upgrade with nothing to show) only
 *  records the version. `lastSeenVersion` moves forward when the dialog
 *  actually opens, so quitting before then doesn't lose the tips. */
export async function runLaunchCheck(deps: LaunchDeps = {}): Promise<"opened" | "silent"> {
  let current: string;
  try {
    current = await (deps.version ?? getVersion)();
  } catch {
    return "silent";
  }
  const prefs = useWhatsNewPrefs.getState();
  const { tips, markSeen } = decideLaunch(prefs.lastSeenVersion, current, (deps.tips ?? releasedTips)());
  if (tips.length === 0) {
    if (markSeen) prefs.setLastSeenVersion(markSeen);
    return "silent";
  }
  const canOpen = deps.canOpen ?? canAutoOpen;
  const pollMs = deps.pollMs ?? 500;
  while (!canOpen()) await new Promise((r) => setTimeout(r, pollMs));
  useWhatsNewStore.getState().open(tips);
  if (markSeen) useWhatsNewPrefs.getState().setLastSeenVersion(markSeen);
  return "opened";
}

let launched = false;
/** Run the launch check once per app session (StrictMode mounts twice). */
export function launchOnce(): void {
  if (launched) return;
  launched = true;
  void runLaunchCheck();
}

async function installedVersion(): Promise<string | null> {
  try {
    return await getVersion();
  } catch {
    return useUpdaterStore.getState().currentVersion;
  }
}

/** Reopen the dialog for the installed version (palette, Settings › About). */
export async function openWhatsNewForCurrentVersion(): Promise<void> {
  const v = await installedVersion();
  const tips = v ? tipsForVersion(releasedTips(), v) : [];
  if (tips.length === 0) {
    pushToast({ level: "info", title: "Nothing new to show", body: v ? `v${v} brought no tips.` : undefined });
    return;
  }
  useWhatsNewStore.getState().open(tips);
}

/** Dev builds: preview the tips waiting in `whats-new/unreleased/`. */
export async function previewUnreleasedTips(): Promise<void> {
  const tips = await unreleasedTips();
  if (tips.length === 0) {
    pushToast({ level: "info", title: "No unreleased tips", body: "whats-new/unreleased/ has no app highlights." });
    return;
  }
  useWhatsNewStore.getState().open(tips);
}
