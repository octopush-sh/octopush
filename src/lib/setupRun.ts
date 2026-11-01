//! The setup terminal — where a new workspace's setup script runs.
//!
//! The backend starts it in a `setup` Run terminal (src-tauri/src/workspace_setup.rs).
//! Its runner reports the script's exit status with a private OSC sequence,
//! `ESC ] 6973 ; exit=<code> BEL`, which the Run pane hands to `parseSetupExit`.

/** The OSC number the setup runner reports with (`workspace_setup::EXIT_OSC`). */
export const SETUP_EXIT_OSC = 6973;

export type SetupStatus = "running" | "ok" | "failed";

export interface SetupRun {
  workspaceId: string;
  status: SetupStatus;
  /** Null while running. */
  exitCode: number | null;
}

/** The exit code in an OSC 6973 body (`exit=<code>`), or null for anything else. */
export function parseSetupExit(data: string): number | null {
  const m = /^exit=(\d{1,3})$/.exec(data.trim());
  return m ? Number(m[1]) : null;
}

/** One mono line for a setup run: `setup · running`, `setup failed · exit 1`. */
export function describeSetup(run: SetupRun): string {
  if (run.status === "running") return "setup · running";
  if (run.status === "ok") return "setup · exit 0";
  return `setup failed · exit ${run.exitCode ?? "?"}`;
}
