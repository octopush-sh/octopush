//! Turns a rejected `spawnOrAttachTerminal` into the one plain sentence the
//! Run canvas shows above the technical detail. The raw error stays available
//! behind a disclosure; this only names the likely cause.

/** The raw error text as the backend (or IPC layer) reported it. */
export function spawnErrorDetail(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** Every error on the spawn path is an `AppError::Other`, which reaches JS as
 *  its `Display` string, `other: <message>` (`error.rs`). */
const APP_ERROR_PREFIX = /^other:\s*/;

/** `pty_client.rs` wraps every error the daemon itself returns as
 *  `daemon error: <msg>`, so JS receives `other: daemon error: spawn: …`.
 *  The service answered, so the rest names the real cause. */
const DAEMON_REPORTED = /^daemon error:\s*/;

/** The app couldn't reach the daemon (`pty_client.rs`), or the socket failed.
 *  A daemon that fails to start is only logged; JS then sees one of these. */
const SERVICE_UNREACHABLE =
  /daemon unavailable|write to daemon|daemon response timeout|(re)?connect to daemon|daemon connection (is broken|closed)|connection refused|econnrefused|broken pipe/;

/** One sentence on why the session didn't start. */
export function describeSpawnFailure(detail: string): string {
  const d = detail.toLowerCase().trim().replace(APP_ERROR_PREFIX, "");
  if (DAEMON_REPORTED.test(d)) {
    const cause = d.replace(DAEMON_REPORTED, "");
    // The app's reader synthesises this one when the socket hits EOF.
    if (/^daemon connection closed/.test(cause)) return serviceUnreachable();
    return describeShellCause(cause);
  }
  if (SERVICE_UNREACHABLE.test(d)) return serviceUnreachable();
  return describeShellCause(d);
}

function serviceUnreachable(): string {
  return "The background terminal service isn't responding.";
}

function describeShellCause(d: string): string {
  if (/sandbox|not permitted|permission denied|eperm|eacces|denied/.test(d)) {
    return "macOS or the sandbox denied permission to start the shell.";
  }
  if (/no such file|enoent|not found|cannot find|does not exist/.test(d)) {
    return "The shell or the workspace folder couldn't be found.";
  }
  return "The terminal couldn't start a shell for this workspace.";
}
