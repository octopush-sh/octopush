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
    // NB: we do NOT add the global package-manager dirs (~/.cargo, ~/.gradle, …)
    // to the write roots — several are config/executable dirs, and a sandboxed
    // agent could plant a `~/.cargo/config.toml` rustc-wrapper or a
    // `~/.gradle/init.d/*.gradle` that runs OUTSIDE the sandbox on the user's
    // next build (a full confinement escape). Instead, a sandboxed BUILD is made
    // to write its caches into the already-allowed temp via env redirection —
    // see `sandbox_cache_env`.
    v
}

/// A short, stable hex scope key for a string (e.g. a workspace path) — used to
/// give each mission its OWN cache subtree so one sandboxed mission can't poison
/// the cache another later compiles.
fn scope_key(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Env vars that redirect common build toolchains' WRITE caches into a confined
/// **per-mission** subtree of `$TMPDIR` (already an allowed write root), so a
/// sandboxed `npm install`/`cargo build` works WITHOUT exposing the user's real
/// `~/.cargo` etc. AND without two sandboxed missions sharing (and poisoning)
/// one cache — `scope` (the workspace path) keys the subtree. Read-only global
/// installs (toolchains, tool binaries on PATH) still work — reads are open;
/// only writes are redirected. Applied by the CLI substrate and TALK's sandboxed
/// `run_command`. Pure over its inputs.
pub fn sandbox_cache_env(tmpdir: &str, scope: &str) -> Vec<(String, String)> {
    let base = format!(
        "{}/octopush-build-cache/{}",
        tmpdir.trim_end_matches('/'),
        scope_key(scope)
    );
    vec![
        ("CARGO_HOME".into(), format!("{base}/cargo")), // rust: registry/git/config/bin (fresh, confined)
        ("npm_config_cache".into(), format!("{base}/npm")),
        ("YARN_CACHE_FOLDER".into(), format!("{base}/yarn")),
        ("npm_config_store_dir".into(), format!("{base}/pnpm")), // pnpm store
        ("GOPATH".into(), format!("{base}/go")),
        ("GOCACHE".into(), format!("{base}/go-build")),
        ("GOMODCACHE".into(), format!("{base}/go/pkg/mod")),
        ("GRADLE_USER_HOME".into(), format!("{base}/gradle")),
        ("DENO_DIR".into(), format!("{base}/deno")),
        ("PIP_CACHE_DIR".into(), format!("{base}/pip")),
    ]
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

/// Resolve the effective sandbox write-roots for a mission's execution, unifying
/// the two isolation axes into one confinement decision:
///
/// - **`git_isolation = "readonly"`** (review/probe missions) is *read-only by
///   construction*: the sandbox is forced ON with **no workspace in the write
///   roots** (temp-only writes), so the agent can read the checkout but never
///   modify it — regardless of the mission's own `exec_isolation`.
/// - else **`exec_isolation = "sandbox"`** → confine writes to the workspace.
/// - else → `None` (unconfined; a `none`/unimplemented tier is handled by the
///   caller / `cli_runner`'s fail-closed match).
///
/// `Some(vec![])` means "sandboxed, temp-only"; `Some(vec![ws])` means
/// "sandboxed, workspace-writable"; `None` means "not sandboxed". Pure.
pub fn sandbox_write_roots(
    git_isolation: &str,
    exec_isolation: &str,
    workspace_path: &str,
) -> Option<Vec<String>> {
    if git_isolation == "readonly" {
        Some(Vec::new())
    } else if exec_isolation == "sandbox" {
        Some(vec![workspace_path.to_string()])
    } else {
        None
    }
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
        // No GLOBAL package-manager dirs are writable — several are config/exec
        // dirs (a sandboxed agent must not plant a ~/.cargo/config.toml
        // rustc-wrapper or ~/.gradle/init.d/*.gradle that runs outside the
        // sandbox). Builds get a CONFINED cache via env redirect, not these.
        assert!(!roots.iter().any(|r| {
            r == "/home/u/.ssh"
                || r == "/home/u/.aws"
                || r == "/home/u/.config"
                || r == "/home/u/Library/Caches"
                || r == "/home/u/.cargo"
                || r == "/home/u/.gradle"
                || r == "/home/u/.rustup"
                || r == "/home/u/go"
                || r == "/home/u"
                || r == "/var/folders"
                || r == "/private/var/folders"
        }));
    }

    #[test]
    fn readonly_missions_get_no_write_roots_beyond_temp() {
        // A readonly (review/probe) mission is `Some(vec![])` → temp-only. It must
        // NOT gain the workspace OR any package-manager dir. (The gap that let
        // the first cut of B3 accidentally grant readonly missions write access
        // to ~/.cargo etc.)
        let roots = assemble_write_roots(&[], Some("/home/u"), Some("/tmp/session"));
        assert!(!roots.iter().any(|r| r.starts_with("/home/u/.cargo") || r == "/home/u/go"));
        assert!(!roots.contains(&"/ws".to_string()));
        // Temp + the CLI's own dirs are still there (a shell needs them).
        assert!(roots.contains(&"/tmp/session".to_string()));
        assert!(roots.contains(&"/home/u/.claude".to_string()));
    }

    #[test]
    fn sandbox_cache_env_redirects_into_the_confined_temp() {
        let env: std::collections::HashMap<String, String> =
            sandbox_cache_env("/tmp/session", "/ws-a").into_iter().collect();
        // Every redirect points under the confined temp, never at ~.
        for (k, v) in &env {
            assert!(v.starts_with("/tmp/session/octopush-build-cache/"), "{k}={v} escaped temp");
        }
        assert!(env.get("CARGO_HOME").unwrap().ends_with("/cargo"));
        assert!(env.contains_key("npm_config_cache"));
        assert!(env.contains_key("GOPATH"));
        assert!(env.contains_key("GRADLE_USER_HOME"));
        // Per-mission isolation: a DIFFERENT workspace gets a DIFFERENT cache
        // subtree, so one sandboxed mission can't poison another's build cache.
        let other: std::collections::HashMap<String, String> =
            sandbox_cache_env("/tmp/session", "/ws-b").into_iter().collect();
        assert_ne!(env.get("CARGO_HOME"), other.get("CARGO_HOME"));
    }

    #[test]
    fn system_write_files_covers_the_claude_state_file() {
        assert_eq!(system_write_files(Some("/home/u")), vec!["/home/u/.claude.json".to_string()]);
        assert!(system_write_files(None).is_empty());
    }

    #[test]
    fn sandbox_write_roots_makes_readonly_temp_only_and_sandbox_workspace_writable() {
        // readonly forces the sandbox on with NO workspace root (temp-only), even
        // if the mission's exec_isolation says "none".
        assert_eq!(sandbox_write_roots("readonly", "none", "/ws"), Some(vec![]));
        assert_eq!(sandbox_write_roots("readonly", "sandbox", "/ws"), Some(vec![]));
        // a normal sandboxed mission may write its workspace.
        assert_eq!(sandbox_write_roots("worktree", "sandbox", "/ws"), Some(vec!["/ws".to_string()]));
        // an unsandboxed writer mission is not confined.
        assert_eq!(sandbox_write_roots("worktree", "none", "/ws"), None);
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
