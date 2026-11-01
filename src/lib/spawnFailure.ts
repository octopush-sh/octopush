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

/** `pty_client.rs` wraps every error the daemon itself returns in this
 *  prefix: the service answered, so the rest names the real cause. */
const DAEMON_REPORTED = "daemon error:";

/** `pty_daemon.rs` couldn't find or launch the daemon binary. */
const SERVICE_NOT_STARTED =
  /octopush-pty-server binary not found|pty daemon failed to start|failed to spawn daemon/;

/** The app couldn't reach the daemon (`pty_client.rs`), or the socket failed. */
const SERVICE_UNREACHABLE =
  /daemon unavailable|write to daemon|daemon response timeout|(re)?connect to daemon|daemon connection (is broken|closed)|connection refused|econnrefused|broken pipe/;

/** One sentence on why the session didn't start. */
export function describeSpawnFailure(detail: string): string {
  const d = detail.toLowerCase().trim();
  if (d.startsWith(DAEMON_REPORTED)) {
    const cause = d.slice(DAEMON_REPORTED.length).trim();
    // The app's reader synthesises this one when the socket hits EOF.
    if (/^daemon connection closed/.test(cause)) return serviceUnreachable();
    return describeShellCause(cause);
  }
  if (SERVICE_NOT_STARTED.test(d)) {
    return "The background terminal service couldn't be started.";
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
