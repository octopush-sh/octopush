//! Reading a file a user or a repo names without hanging on one that isn't a
//! file (#1190). A `.env` served by a secrets manager can be a named pipe that
//! nothing writes to, and a plain read of it blocks forever. The path is
//! stat'ed first (following symlinks, which never blocks), then opened with
//! `O_NONBLOCK` and checked again by the open handle, so a pipe swapped in
//! between the two is refused too. Reads are capped in size.

use std::fs::{File, FileType, Metadata};
use std::io::Read;
use std::path::Path;

use crate::error::{AppError, AppResult};

/// Why `path` isn't read, in words; `None` for a regular file.
pub fn refusal(path: &Path, t: &FileType) -> Option<String> {
    if t.is_file() {
        return None;
    }
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    if t.is_dir() {
        return Some(format!("{name} is a folder, not a file."));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if t.is_fifo() {
            return Some(format!(
                "{name} is a named pipe, not a file (a secrets manager may serve it). Octopush doesn't read it."
            ));
        }
        if t.is_socket() {
            return Some(format!("{name} is a socket, not a file. Octopush doesn't read it."));
        }
        if t.is_block_device() || t.is_char_device() {
            return Some(format!("{name} is a device, not a file. Octopush doesn't read it."));
        }
    }
    Some(format!("{name} isn't a regular file. Octopush doesn't read it."))
}

fn io_error(path: &Path, e: std::io::Error) -> AppError {
    AppError::Other(format!("{}: {e}", path.display()))
}

/// `path` opened for reading, when it is (or links to) a regular file.
pub fn open_regular(path: &Path) -> AppResult<(File, Metadata)> {
    let refuse = |meta: &Metadata| refusal(path, &meta.file_type()).map(AppError::Other);
    let meta = std::fs::metadata(path).map_err(|e| io_error(path, e))?;
    if let Some(e) = refuse(&meta) {
        return Err(e);
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK);
    }
    let file = opts.open(path).map_err(|e| io_error(path, e))?;
    let meta = file.metadata().map_err(|e| io_error(path, e))?;
    if let Some(e) = refuse(&meta) {
        return Err(e);
    }
    Ok((file, meta))
}

/// What [`read_regular`] read.
#[derive(Debug)]
pub enum Capped {
    Read { bytes: Vec<u8>, meta: Metadata },
    /// Past `max_bytes` (`size` is at least `max_bytes + 1`); nothing kept.
    TooLarge { size: u64 },
}

/// A regular file's bytes, at most `max_bytes` of them. At most one byte
/// more is read, to catch a file that grew after it was stat'ed.
pub fn read_regular(path: &Path, max_bytes: u64) -> AppResult<Capped> {
    let (file, meta) = open_regular(path)?;
    if meta.len() > max_bytes {
        return Ok(Capped::TooLarge { size: meta.len() });
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(max_bytes.saturating_add(1)).read_to_end(&mut bytes).map_err(|e| io_error(path, e))?;
    if bytes.len() as u64 > max_bytes {
        return Ok(Capped::TooLarge { size: bytes.len() as u64 });
    }
    Ok(Capped::Read { bytes, meta })
}

/// A regular file's text, refused when it is past `max_bytes` or isn't UTF-8.
pub fn read_regular_text(path: &Path, max_bytes: u64) -> AppResult<String> {
    let name = || path.display().to_string();
    match read_regular(path, max_bytes)? {
        Capped::TooLarge { .. } => Err(AppError::Other(format!("{} is larger than {max_bytes} bytes, so it wasn't read.", name()))),
        Capped::Read { bytes, .. } => {
            String::from_utf8(bytes).map_err(|_| AppError::Other(format!("{} isn't UTF-8 text.", name())))
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    pub(crate) fn mkfifo(path: &Path) {
        let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    }

    /// `f`'s answer, failing the test if it takes a second or more (a
    /// blocked read would otherwise hang the test run).
    pub(crate) fn within_a_second<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(Duration::from_secs(1)).expect("the read blocked")
    }

    fn fifo_env() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let env = dir.path().join(".env");
        mkfifo(&env);
        (dir, env)
    }

    #[test]
    fn a_named_pipe_is_refused_at_once() {
        let (_dir, env) = fifo_env();
        let err = within_a_second(move || read_regular_text(&env, 1024)).unwrap_err().to_string();
        assert_eq!(
            err,
            "other: .env is a named pipe, not a file (a secrets manager may serve it). Octopush doesn't read it."
        );
    }

    #[test]
    fn a_link_to_a_named_pipe_is_refused_too() {
        let (dir, env) = fifo_env();
        let link = dir.path().join("secrets");
        std::os::unix::fs::symlink(&env, &link).unwrap();
        let err = within_a_second(move || read_regular(&link, 1024)).unwrap_err().to_string();
        assert!(err.contains("secrets is a named pipe, not a file"), "{err}");
    }

    #[test]
    fn folders_and_devices_are_refused_by_name() {
        let dir = tempfile::TempDir::new().unwrap();
        let err = read_regular_text(dir.path(), 1024).unwrap_err().to_string();
        assert!(err.ends_with("is a folder, not a file."), "{err}");
        let err = within_a_second(|| read_regular_text(Path::new("/dev/null"), 1024)).unwrap_err().to_string();
        assert_eq!(err, "other: null is a device, not a file. Octopush doesn't read it.");
    }

    #[test]
    fn a_regular_file_and_a_link_to_one_read_unchanged() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join(".env");
        std::fs::write(&file, "KEY=value\n").unwrap();
        assert_eq!(read_regular_text(&file, 1024).unwrap(), "KEY=value\n");
        let link = dir.path().join("linked");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert_eq!(read_regular_text(&link, 1024).unwrap(), "KEY=value\n");
    }

    #[test]
    fn a_file_past_the_cap_is_not_read() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("big.log");
        std::fs::write(&file, "0123456789").unwrap();
        assert!(matches!(read_regular(&file, 4).unwrap(), Capped::TooLarge { size: 10 }));
        assert!(matches!(read_regular(&file, 10).unwrap(), Capped::Read { ref bytes, .. } if bytes.len() == 10));
        assert!(read_regular_text(&file, 4).unwrap_err().to_string().contains("is larger than 4 bytes"));
        std::fs::write(&file, [0xff, 0xfe]).unwrap();
        assert!(read_regular_text(&file, 4).unwrap_err().to_string().ends_with("isn't UTF-8 text."));
    }
}
