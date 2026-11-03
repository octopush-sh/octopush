/**
 * Render-error reporting for the app's error boundaries
 * (`components/ErrorBoundary.tsx`).
 *
 * Errors go to the WebView console, which is where every other frontend
 * failure is logged. There is no network reporting path, and this module never
 * adds one. The details stay local: they are never put into a chat or a run
 * prompt, so no agent sees them. They reach the clipboard only when the user
 * presses "Copy error details".
 */

/** Normalise whatever was thrown into an Error, because `throw "x"` is legal. */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  return new Error(typeof thrown === "string" ? thrown : String(thrown));
}

/** Log a caught render error, tagged with the surface it came from. */
export function reportRenderError(surface: string, thrown: unknown, componentStack?: string | null): void {
  const error = toError(thrown);
  console.error(`[octopush] ${surface} hit a render error:`, error, componentStack ?? "");
}

/** "Reload Octopush": reload the WebView. The backend, the PTY daemon and
 *  running crews are unaffected, and terminals reattach on the next mount. */
export function reloadWindow(): void {
  window.location.reload();
}

/** The plain-text report behind "Copy error details". */
export function formatErrorDetails(
  surface: string,
  thrown: unknown,
  componentStack?: string | null,
  now: Date = new Date(),
): string {
  const error = toError(thrown);
  const lines = [
    `Surface: ${surface}`,
    `Time: ${now.toISOString()}`,
    `Error: ${error.name}: ${error.message}`,
  ];
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    lines.push(`User agent: ${navigator.userAgent}`);
  }
  if (error.stack) lines.push("", "Stack:", error.stack);
  const components = componentStack?.trim();
  if (components) lines.push("", "Component stack:", components);
  return lines.join("\n");
}
