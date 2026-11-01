//! Workspace setup scripts — the commands the new-mission wizard saves to run
//! when a workspace's worktree is created.
//!
//! Interactive creation runs the script in a visible Run terminal labelled
//! `setup`, through the PTY daemon like every other session (output survives an
//! app restart). The daemon starts a "shell" with `-l`; for the setup terminal
//! that shell is [`RUNNER`], a small POSIX script the app writes to its data
//! directory. It runs the script (passed in [`SCRIPT_ENV`], never interpolated)
//! with the user's login shell, prints the exit status, reports it to the app
//! with a private OSC sequence ([`EXIT_OSC`], read by the Run pane), then stays
//! open as an ordinary login shell so the user can inspect or re-run.
//!
//! Only a freshly created worktree runs the script: a reused, restored or
//! adopted workspace is somebody's existing checkout. `octopush-mcp` stores the
//! script but never runs it (its contract is that it never executes on its own).

use std::path::{Path, PathBuf};

use crate::workspace::CreateOutcome;

/// The label of the Run terminal a setup script runs in.
pub const TERMINAL_LABEL: &str = "setup";

/// Env var the runner reads the script from (unset before the script runs).
pub const SCRIPT_ENV: &str = "OCTOPUSH_SETUP_SCRIPT";

/// Private OSC number the runner reports the exit status with:
/// `ESC ] 6973 ; exit=<code> BEL`. Mirrored by `src/lib/setupRun.ts`.
pub const EXIT_OSC: u16 = 6973;

/// The runner the setup terminal's PTY starts instead of a bare login shell.
/// `$1` is the daemon's `-l`, ignored. `trap : INT` keeps the runner alive
/// through a Ctrl-C (a handled signal resets to default in the child, so the
/// script itself still stops) so the status is still reported.
pub const RUNNER: &str = r#"#!/bin/sh
# Octopush setup runner — written by the app; safe to delete (it is rewritten).
shell="${SHELL:-/bin/zsh}"
script="$OCTOPUSH_SETUP_SCRIPT"
unset OCTOPUSH_SETUP_SCRIPT
trap : INT
printf '\033[2m· setup · %s\033[0m\n' "$PWD"
"$shell" -l -c "$script"
code=$?
if [ "$code" -eq 0 ]; then
  printf '\n\033[2m· setup finished · exit 0\033[0m\n'
else
  printf '\n\033[31m· setup failed · exit %d\033[0m\n' "$code"
fi
printf '\033]6973;exit=%d\007' "$code"
trap - INT
exec "$shell" -l
"#;

/// Whether a `workspace::create` outcome should run `script`: only a freshly
/// created worktree, and only a script with something in it.
pub fn should_run(outcome: CreateOutcome, script: &str) -> bool {
    outcome == CreateOutcome::Created && !script.trim().is_empty()
}

/// Where the runner lives: the app's data directory.
pub fn runner_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("octopush")
}

/// Write the runner into `dir` (when missing or out of date) as an executable
/// file, and return its path.
pub fn ensure_runner(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("setup-runner.sh");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(RUNNER) {
        std::fs::write(&path, RUNNER)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_created_worktree_with_a_script_runs_it() {
        assert!(should_run(CreateOutcome::Created, "npm install"));
        assert!(!should_run(CreateOutcome::Created, "  \n "));
        assert!(!should_run(CreateOutcome::Existed, "npm install"));
        assert!(!should_run(CreateOutcome::Restored, "npm install"));
        assert!(!should_run(CreateOutcome::Adopted, "npm install"));
    }

    #[test]
    fn runner_osc_matches_the_constant() {
        assert!(RUNNER.contains(&format!("\\033]{EXIT_OSC};exit=%d\\007")));
        assert!(RUNNER.contains(SCRIPT_ENV));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_runner_writes_an_executable_file_once() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::TempDir::new().unwrap();
        let path = ensure_runner(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), RUNNER);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);
        // A stale copy is replaced.
        std::fs::write(&path, "old").unwrap();
        ensure_runner(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), RUNNER);
    }

    /// The runner runs the script in the worktree, reports its exit status
    /// with the OSC marker, and never shows the script the variable it came in.
    #[cfg(unix)]
    #[test]
    fn runner_runs_the_script_and_reports_its_exit() {
        let dir = tempfile::TempDir::new().unwrap();
        let runner = ensure_runner(dir.path()).unwrap();
        let cwd = tempfile::TempDir::new().unwrap();
        let out = std::process::Command::new(&runner)
            .arg("-l")
            .current_dir(cwd.path())
            .env("SHELL", "/bin/sh")
            .env(SCRIPT_ENV, "touch made-here; echo \"[${OCTOPUSH_SETUP_SCRIPT:-unset}]\"; exit 3")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("[unset]"), "{stdout}");
        assert!(stdout.contains("setup failed · exit 3"), "{stdout}");
        assert!(stdout.contains("\x1b]6973;exit=3\x07"), "{stdout}");
        assert!(cwd.path().join("made-here").exists());
    }
}
