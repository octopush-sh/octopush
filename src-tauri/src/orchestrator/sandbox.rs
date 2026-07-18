//! macOS seatbelt sandboxing for agent CLI execution.
//!
//! When a mission's `exec_isolation = "sandbox"`, the CLI substrate's process is
//! wrapped in `sandbox-exec -f <profile> …` under a generated SBPL profile that
//! **confines writes** to the mission's workspace (plus the temp dirs and CLI
//! session dir a real agent needs) while leaving reads and network intact — the
//! agents need both. The core security property: a sandboxed agent cannot modify
//! files outside its own mission (other worktrees, `~/.ssh`, `~/Documents`,
//! system paths stay read-only).
//!
//! Enforcement lives at exactly one place — the spawn in `cli_runner.rs` — so it
//! covers in-process runs and the detached worker identically. There is **no
//! silent fallback**: if the sandbox can't be set up, the stage fails with a
//! readable error rather than running unconfined.

use crate::error::{AppError, AppResult};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// The system seatbelt driver. Absolute so it resolves regardless of the child's
/// PATH; it is a stable macOS system binary.
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Escape a path for an SBPL string literal (`"…"`). Backslash and quote are the
/// only characters the SBPL string grammar requires escaping.
fn sbpl_string(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Always-writable roots a real CLI process needs regardless of the mission —
/// the temp dirs, `/dev`, and the Claude CLI's own session/cache dirs. Kept
/// deliberately narrow: everything else under `$HOME` (`~/.ssh`, `~/.aws`,
/// documents, other projects) stays read-only. Pure over its inputs for testing.
fn system_write_roots(home: Option<&str>, tmpdir: Option<&str>) -> Vec<String> {
    let mut v = vec![
        "/dev".to_string(),
        // macOS temp: /tmp and $TMPDIR are symlinks into /private; seatbelt
        // matches the real path, so list both forms.
        "/tmp".to_string(),
        "/private/tmp".to_string(),
        "/var/folders".to_string(),
        "/private/var/folders".to_string(),
    ];
    if let Some(t) = tmpdir {
        v.push(t.to_string());
    }
    if let Some(h) = home {
        // The CLI's session/config/cache — needed for it to run at all.
        v.push(format!("{h}/.claude"));
        v.push(format!("{h}/.config"));
        v.push(format!("{h}/.cache"));
        v.push(format!("{h}/Library/Caches"));
    }
    v
}

/// Merge the mission's write roots with the system defaults, add canonical forms
/// (seatbelt matches realpaths, so a symlinked root must appear resolved too),
/// and de-duplicate. Pure over its inputs.
fn assemble_write_roots(mission_roots: &[String], home: Option<&str>, tmpdir: Option<&str>) -> Vec<String> {
    let mut roots: Vec<String> = mission_roots.to_vec();
    roots.extend(system_write_roots(home, tmpdir));
    // Add realpath forms where they differ (best-effort; skip non-existent).
    let mut canonical: Vec<String> = Vec::new();
    for r in &roots {
        if let Ok(c) = std::fs::canonicalize(r) {
            let cs = c.to_string_lossy().into_owned();
            if &cs != r {
                canonical.push(cs);
            }
        }
    }
    roots.extend(canonical);
    roots.sort();
    roots.dedup();
    roots
}

/// Render an SBPL profile that allows everything by default, denies all file
/// writes, then re-allows writes under `write_roots`. `(allow default)` keeps
/// reads and network working — confinement is on writes only. Pure.
fn render_profile(write_roots: &[String]) -> String {
    let mut p = String::new();
    p.push_str("(version 1)\n");
    p.push_str("(allow default)\n");
    p.push_str("(deny file-write*)\n");
    p.push_str("(allow file-write*\n");
    for root in write_roots {
        p.push_str("  (subpath ");
        p.push_str(&sbpl_string(root));
        p.push_str(")\n");
    }
    p.push_str(")\n");
    p
}

/// Build the seatbelt profile text for a mission's write roots, resolving the
/// system dirs from the environment.
pub fn build_seatbelt_profile(mission_write_roots: &[String]) -> String {
    let home = std::env::var("HOME").ok();
    let tmpdir = std::env::var("TMPDIR").ok();
    let roots = assemble_write_roots(mission_write_roots, home.as_deref(), tmpdir.as_deref());
    render_profile(&roots)
}

/// Wrap a program + args as a `sandbox-exec -f <profile> <program> <args…>` argv.
/// Pure — returns the new program and full arg vector.
fn sandbox_argv(program: &OsStr, args: &[String], profile_path: &Path) -> (OsString, Vec<OsString>) {
    let mut wrapped: Vec<OsString> = Vec::with_capacity(args.len() + 3);
    wrapped.push(OsString::from("-f"));
    wrapped.push(profile_path.as_os_str().to_os_string());
    wrapped.push(program.to_os_string());
    for a in args {
        wrapped.push(OsString::from(a));
    }
    (OsString::from(SANDBOX_EXEC), wrapped)
}

/// Removes the generated profile file when the stage's command finishes.
pub struct ProfileGuard {
    path: PathBuf,
}

impl Drop for ProfileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The wrapped command ready to spawn, plus the profile-cleanup guard (hold it
/// until after the child exits).
pub struct Prepared {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub guard: ProfileGuard,
}

/// Prepare a sandboxed launch: verify the platform + driver, write a per-stage
/// seatbelt profile, and return the wrapped argv. Errors (no silent fallback) if
/// sandboxing is unavailable or the profile can't be written.
pub fn prepare(
    run_id: &str,
    stage_id: &str,
    write_roots: &[String],
    program: &OsStr,
    args: &[String],
) -> AppResult<Prepared> {
    if !cfg!(target_os = "macos") {
        return Err(AppError::Other(
            "sandboxed execution is only available on macOS".into(),
        ));
    }
    if !Path::new(SANDBOX_EXEC).exists() {
        return Err(AppError::Other(format!(
            "the sandbox driver ({SANDBOX_EXEC}) was not found"
        )));
    }
    let profile = build_seatbelt_profile(write_roots);
    let path = std::env::temp_dir().join(format!("octopush-sandbox-{run_id}-{stage_id}.sb"));
    std::fs::write(&path, profile)
        .map_err(|e| AppError::Other(format!("could not write the sandbox profile: {e}")))?;
    let (prog, wrapped) = sandbox_argv(program, args, &path);
    Ok(Prepared {
        program: prog,
        args: wrapped,
        guard: ProfileGuard { path },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sbpl_string_escapes_quotes_and_backslashes() {
        assert_eq!(sbpl_string("/a/b"), "\"/a/b\"");
        assert_eq!(sbpl_string("/a \"x\""), "\"/a \\\"x\\\"\"");
        assert_eq!(sbpl_string("/a\\b"), "\"/a\\\\b\"");
    }

    #[test]
    fn render_profile_confines_writes_but_allows_default() {
        let p = render_profile(&["/ws".to_string(), "/tmp".to_string()]);
        assert!(p.contains("(version 1)"));
        assert!(p.contains("(allow default)"));
        assert!(p.contains("(deny file-write*)"));
        assert!(p.contains("(subpath \"/ws\")"));
        assert!(p.contains("(subpath \"/tmp\")"));
        // The deny must precede the write-allow so the re-allow wins.
        assert!(p.find("(deny file-write*)").unwrap() < p.find("(allow file-write*").unwrap());
    }

    #[test]
    fn assemble_write_roots_includes_mission_temp_and_claude_dirs() {
        let roots = assemble_write_roots(&["/ws".to_string()], Some("/home/u"), Some("/tmp/session"));
        assert!(roots.contains(&"/ws".to_string()));
        assert!(roots.contains(&"/home/u/.claude".to_string()));
        assert!(roots.contains(&"/tmp/session".to_string()));
        assert!(roots.contains(&"/dev".to_string()));
        // Sensitive home dirs are NOT writable.
        assert!(!roots.iter().any(|r| r == "/home/u/.ssh" || r == "/home/u"));
    }

    #[test]
    fn sandbox_argv_prepends_driver_flags_then_program() {
        let (prog, args) = sandbox_argv(
            OsStr::new("/usr/local/bin/claude"),
            &["-p".to_string(), "hi".to_string()],
            Path::new("/tmp/p.sb"),
        );
        assert_eq!(prog, OsString::from(SANDBOX_EXEC));
        assert_eq!(
            args,
            vec![
                OsString::from("-f"),
                OsString::from("/tmp/p.sb"),
                OsString::from("/usr/local/bin/claude"),
                OsString::from("-p"),
                OsString::from("hi"),
            ]
        );
    }
}
