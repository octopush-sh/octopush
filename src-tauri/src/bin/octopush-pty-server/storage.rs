//! Disk-backed log management for PTY scrollback.
//!
//! Each terminal gets a file at `~/.octopush/pty-state/<id>.log`.
//! The file stores raw PTY bytes — no framing — purely for scrollback replay.
//! We cap the file at `MAX_LOG_BYTES` (1 MiB) by rotating: when the file
//! exceeds the cap, we truncate the oldest half so the **most recent** bytes
//! are preserved.
//!
//! The daemon's own log goes to `~/.octopush/pty-server.log` (5 MiB cap).

use anyhow::Result;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tracing::{debug, warn};

pub const MAX_PTY_LOG_BYTES: u64 = 1024 * 1024; // 1 MiB
pub const MAX_DAEMON_LOG_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB

/// Returns `~/.octopush/pty-state/` and ensures it exists.
pub fn pty_state_dir() -> Result<PathBuf> {
    let base = octopush_dir()?;
    let dir = base.join("pty-state");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Returns `~/.octopush/` and ensures it exists (with 0700 perms).
pub fn octopush_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home directory"))?;
    let dir = home.join(".octopush");
    fs::create_dir_all(&dir)?;
    // Ensure 0700 on the directory.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Opens (or creates) the log file for a PTY session.
/// Opened with read+write+create (not append) so that rotate_log can seek.
pub fn open_pty_log(id: &str) -> Result<File> {
    let path = pty_log_path(id)?;
    let f = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&path)?;
    // Seek to end so subsequent writes append.
    let mut f = f;
    f.seek(SeekFrom::End(0))?;
    Ok(f)
}

/// Returns the path to the log file for a PTY session.
pub fn pty_log_path(id: &str) -> Result<PathBuf> {
    Ok(pty_state_dir()?.join(format!("{id}.log")))
}

/// Appends `data` to the PTY log file, rotating if the file exceeds `MAX_PTY_LOG_BYTES`.
pub fn append_pty_log(file: &mut File, data: &[u8]) -> Result<()> {
    file.write_all(data)?;
    file.flush()?;

    // Check size for rotation.
    let size = file.seek(SeekFrom::End(0))?;
    if size > MAX_PTY_LOG_BYTES {
        rotate_log(file, MAX_PTY_LOG_BYTES)?;
    }
    Ok(())
}

/// Reads the last `since_seq` portion of the log for scrollback replay.
/// Returns raw bytes stored on disk for the given terminal id.
pub fn read_pty_log(id: &str) -> Result<Vec<u8>> {
    let path = pty_log_path(id)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    Ok(fs::read(&path)?)
}

/// Deletes the on-disk log for a PTY session. Missing file is not an error.
pub fn delete_pty_log(id: &str) -> Result<()> {
    let path = pty_log_path(id)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// Removes all orphan log files (any `.log` in pty-state that has no corresponding
/// live PTY id). Called at daemon startup.
pub fn remove_orphan_logs(live_ids: &[String]) -> Result<()> {
    let dir = pty_state_dir()?;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().map(|e| e == "log").unwrap_or(false) {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if !live_ids.iter().any(|id| id == stem) {
                    debug!("removing orphan log: {}", path.display());
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    Ok(())
}

/// Truncates the oldest data from `file` so that only the newest `keep` bytes remain.
/// After truncation the file descriptor is seeked to the end.
fn rotate_log(file: &mut File, cap: u64) -> Result<()> {
    let keep = cap / 2;
    let size = file.seek(SeekFrom::End(0))?;
    if size <= keep {
        return Ok(());
    }
    let skip = size - keep;
    // Read the tail we want to keep.
    file.seek(SeekFrom::Start(skip))?;
    let mut tail = Vec::with_capacity(keep as usize);
    std::io::Read::read_to_end(file, &mut tail)?;
    // Rewrite from the beginning.
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&tail)?;
    let new_len = tail.len() as u64;
    file.set_len(new_len)?;
    file.seek(SeekFrom::End(0))?;
    debug!("rotated log: {size} → {new_len} bytes");
    Ok(())
}

/// Rotates the daemon's own log file if it exceeds MAX_DAEMON_LOG_BYTES.
pub fn maybe_rotate_daemon_log(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let size = fs::metadata(path)?.len();
    if size > MAX_DAEMON_LOG_BYTES {
        let keep = MAX_DAEMON_LOG_BYTES / 2;
        let mut file = OpenOptions::new().read(true).write(true).open(path)?;
        rotate_log(&mut file, keep * 2)?; // pass the cap so rotate keeps keep bytes
        warn!("daemon log rotated");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tempfile::NamedTempFile;

    #[test]
    fn rotate_log_keeps_tail() {
        let mut tmp = NamedTempFile::new().unwrap();
        // Write 10 bytes.
        tmp.write_all(b"0123456789").unwrap();
        // Rotate with cap=6 → keep newest 3 bytes.
        rotate_log(tmp.as_file_mut(), 6).unwrap();
        tmp.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        let mut out = Vec::new();
        tmp.as_file_mut().read_to_end(&mut out).unwrap();
        assert_eq!(out, b"789");
    }
}
