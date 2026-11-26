//! Helpers shared by unit tests across modules.

use std::path::{Path, PathBuf};

const PTY_SERVER: &str = "octopush-pty-server";

/// Locate the real `octopush-pty-server` binary for tests that spawn the daemon.
///
/// Unit tests can't use `env!("CARGO_BIN_EXE_…")` (Cargo only sets it for
/// integration tests), so the binary is looked up at run time, in order:
///
/// 1. `OCTOPUSH_PTY_SERVER_BIN`, an explicit override;
/// 2. `CARGO_BIN_EXE_octopush-pty-server`, which newer Cargo sets when it runs tests;
/// 3. every ancestor directory of the test executable, up to and including the
///    first one named `target` (or `CARGO_TARGET_DIR`), so a stray binary in the
///    repo root or `$HOME` is never picked up. Before Cargo 1.100 the test
///    binary lived in `target/debug/deps/`, so the parent's parent was
///    `target/debug/`. Since 1.100 (the new build-dir layout is now the
///    default) it lives in `target/debug/build/<pkg>/<hash>/out/`, three levels
///    further down. Cargo calls that layout "not a stable interface";
/// 4. `target/debug/` under the crate (`CARGO_TARGET_DIR` first, if set).
///
/// Only a non-empty, executable regular file counts, so neither a directory nor
/// the empty placeholder `build.rs` stages for Tauri's `externalBin` is ever
/// returned. Requires `cargo build --bin octopush-pty-server` first (CI does).
pub(crate) fn pty_server_bin() -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for var in [
        "OCTOPUSH_PTY_SERVER_BIN",
        "CARGO_BIN_EXE_octopush-pty-server",
    ] {
        if let Some(p) = std::env::var_os(var) {
            candidates.push(PathBuf::from(p));
        }
    }
    let target_dir = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from);
    let exe = std::env::current_exe().ok();
    if let Some(exe) = &exe {
        for dir in exe.ancestors().skip(1) {
            candidates.push(dir.join(PTY_SERVER));
            if is_target_root(dir, target_dir.as_deref()) {
                break;
            }
        }
    }
    if let Some(dir) = &target_dir {
        candidates.push(dir.join("debug").join(PTY_SERVER));
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
            .join(PTY_SERVER),
    );

    let mut rejected = Vec::new();
    for c in &candidates {
        match why_unusable(c) {
            None => return c.clone(),
            Some(reason) if reason != "missing" => {
                rejected.push(format!("{} ({reason})", c.display()))
            }
            Some(_) => {}
        }
    }
    let exe_desc = exe.as_deref().map_or_else(
        || "<unknown test executable>".into(),
        |p| p.display().to_string(),
    );
    let target_desc = target_dir.as_deref().map_or_else(
        || "CARGO_TARGET_DIR unset".into(),
        |p| format!("{}/debug", p.display()),
    );
    panic!(
        "{PTY_SERVER} not found; run `cargo build --bin {PTY_SERVER}` first. \
         Looked next to {exe_desc} and its ancestors up to the first `target` dir, \
         in $CARGO_TARGET_DIR ({target_desc}) and in {}/target/debug. Rejected: [{}]",
        env!("CARGO_MANIFEST_DIR"),
        rejected.join(", ")
    );
}

/// Whether `dir` is the Cargo target root, where the ancestor walk stops: the
/// first directory named `target`, or `CARGO_TARGET_DIR` when it has another name.
fn is_target_root(dir: &Path, target_dir: Option<&Path>) -> bool {
    dir.file_name().is_some_and(|n| n == "target") || target_dir.is_some_and(|t| t == dir)
}

/// `None` when `p` is a spawnable binary; otherwise why it isn't.
fn why_unusable(p: &Path) -> Option<String> {
    let meta = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(_) => return Some("missing".into()),
    };
    if !meta.is_file() {
        return Some("not a regular file".into());
    }
    if meta.len() == 0 {
        return Some("empty placeholder".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        if mode & 0o111 == 0 {
            return Some(format!("not executable, mode {mode:o}"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{is_target_root, why_unusable};
    use std::fs;
    use std::path::Path;

    #[test]
    fn ancestor_walk_stops_at_the_target_root() {
        assert!(is_target_root(Path::new("/repo/src-tauri/target"), None));
        assert!(!is_target_root(Path::new("/repo/src-tauri"), None));
        assert!(!is_target_root(
            Path::new("/repo/src-tauri/target/debug"),
            None
        ));
        let custom = Path::new("/tmp/cargo-out");
        assert!(is_target_root(custom, Some(custom)));
        assert!(!is_target_root(Path::new("/tmp"), Some(custom)));
    }

    #[test]
    fn rejects_missing_dirs_placeholders_and_non_executables() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert_eq!(
            why_unusable(&tmp.path().join("nope")).as_deref(),
            Some("missing")
        );
        assert_eq!(
            why_unusable(tmp.path()).as_deref(),
            Some("not a regular file")
        );

        let placeholder = tmp.path().join("placeholder");
        fs::write(&placeholder, b"").unwrap();
        assert_eq!(
            why_unusable(&placeholder).as_deref(),
            Some("empty placeholder")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let bin = tmp.path().join("bin");
            fs::write(&bin, b"#!/bin/sh\n").unwrap();
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(why_unusable(&bin).unwrap().starts_with("not executable"));
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(why_unusable(&bin), None);
        }
    }
}
