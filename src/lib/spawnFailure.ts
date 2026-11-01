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

/** One sentence on why the session didn't start. */
export function describeSpawnFailure(detail: string): string {
  const d = detail.toLowerCase();
  if (/sandbox|not permitted|permission denied|eperm|eacces|denied/.test(d)) {
    return "macOS or the sandbox denied permission to start the shell.";
  }
  if (/daemon|socket|connection refused|econnrefused|broken pipe|unavailable/.test(d)) {
    return "The background terminal service isn't responding.";
  }
  if (/no such file|enoent|not found|cannot find|does not exist/.test(d)) {
    return "The shell or the workspace folder couldn't be found.";
  }
  return "The terminal couldn't start a shell for this workspace.";
}
