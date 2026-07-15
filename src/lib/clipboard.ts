import { writeText as tauriWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { pushToast } from "../components/Toasts";

/** True inside the Tauri WebView (both dev and bundled), false in a plain browser. */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The one way to copy text to the system clipboard.
 *
 * - Inside the app we write through the **native** Tauri clipboard plugin, NOT
 *   the browser `navigator.clipboard`. WKWebView on macOS rejects the Web
 *   Clipboard API with `NotAllowedError` whenever the write runs after an
 *   `await` (which spends the WebView's transient user activation) — so
 *   copying a PR body, a path, or a Markdown export would fail intermittently.
 *   The native path goes through Rust and never hits that gate.
 * - In a plain browser (dev server, tests) we fall back to `navigator.clipboard`.
 * - With `successTitle`, success is announced via a success toast; without it,
 *   success is silent (for callers with their own inline feedback).
 * - Failures always surface as an error toast.
 *
 * Returns true when the text reached the clipboard.
 */
export async function copyToClipboard(text: string, successTitle?: string): Promise<boolean> {
  try {
    if (inTauri()) {
      await tauriWriteText(text);
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("Clipboard is unavailable");
    }
    if (successTitle) pushToast({ level: "success", title: successTitle });
    return true;
  } catch (err) {
    pushToast({ level: "error", title: "Copy failed", body: String(err) });
    return false;
  }
}
