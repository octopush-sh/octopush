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
use std::path::{Component, Path, PathBuf};

/// The system seatbelt driver. Absolute so it resolves regardless of the child's
/// PATH; it is a stable macOS system binary.
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Escape a path for an SBPL string literal (`"…"`). Backslash and quote are the
/// only characters the SBPL string grammar requires escaping.
fn sbpl_string(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// The writable directory *subtrees* a real CLI process needs regardless of the
/// mission — the temp dir, `/dev`, and the Claude CLI's own session/cache dirs.
/// Kept deliberately narrow: `~/.ssh`, `~/.aws`, `~/.config` (credentials),
/// documents, and every other project stay read-only. Pure over its inputs.
///
/// Seatbelt matches the kernel-resolved (realpath) path, so only the `/private`
/// forms are live rules — `/tmp`→`/private/tmp`, `$TMPDIR`→`/private/var/…`. We
/// list the real form here; the exact `$TMPDIR` subtree's canonical form is added
/// by `assemble_write_roots`, so we don't blanket-allow all of `/var/folders`.
fn system_write_roots(home: Option<&str>, tmpdir: Option<&str>) -> Vec<String> {
    let mut v = vec!["/dev".to_string(), "/private/tmp".to_string()];
    if let Some(t) = tmpdir {
        v.push(t.to_string());
    }
    if let Some(h) = home {
        // The CLI's own session + generic tool caches — needed for it to run.
        v.push(format!("{h}/.claude"));
        v.push(format!("{h}/.cache"));
    }
    v
}

/// Writable individual *files* (as opposed to subtrees). Seatbelt's `subpath`
/// won't cover a bare file sibling of an allowed dir, so the CLI's top-level
/// `~/.claude.json` state file needs its own `literal` rule.
fn system_write_files(home: Option<&str>) -> Vec<String> {
    match home {
        Some(h) => vec![format!("{h}/.claude.json")],
        None => Vec::new(),
    }
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
/// writes, then re-allows writes under `subpaths` (directory subtrees) and to
/// `literals` (individual files). `(allow default)` keeps reads and network
/// working — confinement is on writes only. Pure.
fn render_profile(subpaths: &[String], literals: &[String]) -> String {
    let mut p = String::new();
    p.push_str("(version 1)\n");
    p.push_str("(allow default)\n");
    p.push_str("(deny file-write*)\n");
    p.push_str("(allow file-write*\n");
    for root in subpaths {
        p.push_str("  (subpath ");
        p.push_str(&sbpl_string(root));
        p.push_str(")\n");
    }
    for file in literals {
        p.push_str("  (literal ");
        p.push_str(&sbpl_string(file));
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
    let subpaths = assemble_write_roots(mission_write_roots, home.as_deref(), tmpdir.as_deref());
    let literals = system_write_files(home.as_deref());
    render_profile(&subpaths, &literals)
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

/// Prepare a sandboxed launch: verify the platform + driver, write a fresh
/// seatbelt profile, and return the wrapped argv. Errors (no silent fallback) if
/// sandboxing is unavailable or the profile can't be written. Shared by the CLI
/// substrate (wrapping `claude`) and in-process `run_command` (wrapping `bash`).
pub fn prepare(write_roots: &[String], program: &OsStr, args: &[String]) -> AppResult<Prepared> {
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
    let path = std::env::temp_dir().join(format!("octopush-sandbox-{}.sb", uuid::Uuid::new_v4()));
    std::fs::write(&path, profile)
        .map_err(|e| AppError::Other(format!("could not write the sandbox profile: {e}")))?;
    let (prog, wrapped) = sandbox_argv(program, args, &path);
    Ok(Prepared {
        program: prog,
        args: wrapped,
        guard: ProfileGuard { path },
    })
}

/// Collapse `.`/`..` components lexically (no filesystem access, so it works for
/// paths that don't exist yet — e.g. a `write_file` target). Absolute inputs
/// stay absolute; `..` can't climb above root.
fn normalize_lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether an in-process `write_file` target is permitted for a sandboxed
/// mission: the lexically-normalized absolute path must sit under one of the
/// mission's write roots. Catches absolute-path and `..` escapes; a symlink
/// escape would first need `run_command`, which is itself sandboxed.
pub fn is_write_allowed(target: &Path, write_roots: &[String]) -> bool {
    let normalized = normalize_lexical(target);
    write_roots.iter().any(|r| {
        let root = normalize_lexical(Path::new(r));
        normalized.starts_with(&root)
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
        let p = render_profile(&["/ws".to_string(), "/tmp".to_string()], &["/home/u/.claude.json".to_string()]);
        assert!(p.contains("(version 1)"));
        assert!(p.contains("(allow default)"));
        assert!(p.contains("(deny file-write*)"));
        assert!(p.contains("(subpath \"/ws\")"));
        assert!(p.contains("(subpath \"/tmp\")"));
        // Individual files use `literal`, not `subpath`.
        assert!(p.contains("(literal \"/home/u/.claude.json\")"));
        // The deny must precede the write-allow so the re-allow wins.
        assert!(p.find("(deny file-write*)").unwrap() < p.find("(allow file-write*").unwrap());
    }

    #[test]
    fn assemble_write_roots_is_narrow() {
        let roots = assemble_write_roots(&["/ws".to_string()], Some("/home/u"), Some("/tmp/session"));
        assert!(roots.contains(&"/ws".to_string()));
        assert!(roots.contains(&"/home/u/.claude".to_string()));
        assert!(roots.contains(&"/tmp/session".to_string()));
        assert!(roots.contains(&"/dev".to_string()));
        // Sensitive/credential home dirs and the home root itself stay read-only,
        // and we no longer blanket-allow every app's temp under /var/folders.
        assert!(!roots.iter().any(|r| {
            r == "/home/u/.ssh"
                || r == "/home/u/.config"
                || r == "/home/u"
                || r == "/var/folders"
                || r == "/private/var/folders"
        }));
    }

    #[test]
    fn system_write_files_covers_the_claude_state_file() {
        assert_eq!(system_write_files(Some("/home/u")), vec!["/home/u/.claude.json".to_string()]);
        assert!(system_write_files(None).is_empty());
    }

    #[test]
    fn is_write_allowed_confines_to_roots_and_blocks_escapes() {
        let roots = vec!["/ws".to_string(), "/private/tmp".to_string()];
        assert!(is_write_allowed(Path::new("/ws/src/main.rs"), &roots));
        assert!(is_write_allowed(Path::new("/private/tmp/x"), &roots));
        // Absolute escape (Path::join discards the base for an absolute arg).
        assert!(!is_write_allowed(Path::new("/etc/passwd"), &roots));
        // `..` escape out of the workspace.
        assert!(!is_write_allowed(Path::new("/ws/../etc/passwd"), &roots));
        // A sibling dir that merely shares a prefix is NOT under the root.
        assert!(!is_write_allowed(Path::new("/ws-other/x"), &roots));
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
