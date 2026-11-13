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
/// 3. every ancestor directory of the test executable. Before Cargo 1.100 the
///    test binary lived in `target/debug/deps/`, so the parent's parent was
///    `target/debug/`. Since 1.100 (the stabilized build-dir layout) it lives in
///    `target/debug/build/<pkg>/<hash>/out/`, three levels further down;
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
    if let Ok(exe) = std::env::current_exe() {
        for dir in exe.ancestors().skip(1) {
            candidates.push(dir.join(PTY_SERVER));
        }
    }
    if let Some(dir) = std::env::var_os("CARGO_TARGET_DIR") {
        candidates.push(PathBuf::from(dir).join("debug").join(PTY_SERVER));
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
    panic!(
        "{PTY_SERVER} not found; run `cargo build --bin {PTY_SERVER}` first. \
         Looked next to {:?} and its ancestors and in target/debug. Rejected: [{}]",
        std::env::current_exe().ok(),
        rejected.join(", ")
    );
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
    use super::why_unusable;
    use std::fs;

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
