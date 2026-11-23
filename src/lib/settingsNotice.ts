import { ipc } from "./ipc";
import { pushToast } from "../components/Toasts";

/** How long the notice stays up: long enough to read a path. */
export const SETTINGS_NOTICE_MS = 20_000;

export const SETTINGS_NOTICE_TITLE = "settings.json couldn't be read";

export function settingsNoticeBody(path: string): string {
  return `Octopush is showing default settings and won't save changes until ${path} is fixed. The file was left unchanged.`;
}

/** Once at launch: when `settings.json` exists but doesn't parse, say so and
 *  name the file, instead of quietly showing defaults (#642). Silent when the
 *  file is fine, missing, or the check itself fails. */
export async function noticeUnreadableSettings(): Promise<void> {
  let path: string | null = null;
  try {
    path = await ipc.unreadableSettingsPath();
  } catch {
    return;
  }
  if (!path) return;
  pushToast({
    level: "error",
    title: SETTINGS_NOTICE_TITLE,
    body: settingsNoticeBody(path),
    timeout: SETTINGS_NOTICE_MS,
  });
}
