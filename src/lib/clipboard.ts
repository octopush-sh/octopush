import { pushToast } from "../components/Toasts";

/**
 * The one way to copy text to the system clipboard.
 *
 * - With `successTitle`, success is announced via a success toast.
 * - Without it, success is silent — for callers with their own inline
 *   feedback (e.g. a transient "copied" label) or implicit copies
 *   (terminal Cmd-C bridging), where a toast would be noise.
 * - Failures always surface as an error toast, including environments
 *   where `navigator.clipboard` is unavailable.
 *
 * Returns true when the text reached the clipboard.
 */
export async function copyToClipboard(text: string, successTitle?: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    pushToast({ level: "error", title: "Copy failed", body: "Clipboard is unavailable" });
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    if (successTitle) pushToast({ level: "success", title: successTitle });
    return true;
  } catch (err) {
    pushToast({ level: "error", title: "Copy failed", body: String(err) });
    return false;
  }
}
