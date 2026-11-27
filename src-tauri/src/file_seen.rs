//! What an agent last saw of each file its file tools read or wrote, so
//! `write_file` never overwrites a file blind (#1165): a file that already
//! exists must have been read first, and must not have changed on disk since
//! the agent last read or wrote it. A new file is written as before.
//!
//! Talk keeps one per thread (`ChatEngine`), a sub-agent or stage one per
//! loop (`orchestrator::agentic`). It lives in memory only.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// A file as the agent last saw it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Seen {
    modified: Option<SystemTime>,
    len: u64,
    hash: [u8; 32],
}

/// The files an agent has read or written, by canonical path.
#[derive(Default, Debug)]
pub struct FileSeen {
    files: HashMap<PathBuf, Seen>,
}

impl FileSeen {
    /// Why the tool call `name` with `input` in `workspace` must not run, or
    /// `None`. Only a `write_file` over an existing file is ever refused.
    pub fn refusal(&self, workspace: &Path, name: &str, input: &serde_json::Value) -> Option<String> {
        if name != "write_file" {
            return None;
        }
        let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
        let full = workspace.join(path);
        let meta = std::fs::metadata(&full).ok().filter(|m| m.is_file())?;
        match self.files.get(&key(&full)) {
            None => Some(format!(
                "Error: {path} already exists and you haven't read it yet. Read it with read_file first \
                 (or change it with edit_file), so the write keeps what is there."
            )),
            Some(seen) if changed(seen, &full, &meta) => Some(format!(
                "Error: {path} changed on disk since you last read it. Read it again with read_file \
                 and build on that version, so the write doesn't overwrite those changes."
            )),
            Some(_) => None,
        }
    }

    /// After the tool call `name` with `input` ran (`ok`): remember the file
    /// as it is now, when it was a successful read, write or edit.
    pub fn note(&mut self, workspace: &Path, name: &str, input: &serde_json::Value, ok: bool) {
        if !ok || !matches!(name, "read_file" | "write_file" | "edit_file") {
            return;
        }
        let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
        let full = workspace.join(path);
        match fingerprint(&full) {
            Some(seen) => {
                self.files.insert(key(&full), seen);
            }
            None => {
                self.files.remove(&key(&full));
            }
        }
    }
}

/// One file's key: its canonical path, so `a.rs` and `./a.rs` are the same.
fn key(full: &Path) -> PathBuf {
    std::fs::canonicalize(full).unwrap_or_else(|_| full.to_path_buf())
}

/// Whether the file at `full` (whose metadata is `meta`) differs from `seen`.
/// The same size and modification time mean unchanged without reading it;
/// otherwise its content decides, so a touch alone doesn't count.
fn changed(seen: &Seen, full: &Path, meta: &std::fs::Metadata) -> bool {
    let modified = meta.modified().ok();
    if seen.modified.is_some() && modified == seen.modified && meta.len() == seen.len {
        return false;
    }
    !matches!(hash_file(full), Ok(hash) if hash == seen.hash)
}

fn fingerprint(full: &Path) -> Option<Seen> {
    let meta = std::fs::metadata(full).ok().filter(|m| m.is_file())?;
    let hash = hash_file(full).ok()?;
    Some(Seen { modified: meta.modified().ok(), len: meta.len(), hash })
}

/// The SHA-256 of the file at `full`, streamed: a large file isn't held.
fn hash_file(full: &Path) -> std::io::Result<[u8; 32]> {
    use std::io::Read;
    let mut file = std::fs::File::open(full)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_engine::execute_tool;
    use serde_json::json;

    /// `name` with `input` through the guard, as Talk and the agentic loop run it.
    fn run(seen: &mut FileSeen, wp: &Path, name: &str, input: serde_json::Value) -> (String, bool) {
        if let Some(refusal) = seen.refusal(wp, name, &input) {
            return (refusal, false);
        }
        let (out, ok) = execute_tool(wp, name, &input, None);
        seen.note(wp, name, &input, ok);
        (out, ok)
    }

    #[test]
    fn write_over_unread_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        std::fs::write(wp.join("a.txt"), "the user's text").unwrap();
        let mut seen = FileSeen::default();
        let (msg, ok) = run(&mut seen, wp, "write_file", json!({ "path": "a.txt", "content": "new" }));
        assert!(!ok && msg.contains("haven't read it yet"), "{msg}");
        assert_eq!(std::fs::read_to_string(wp.join("a.txt")).unwrap(), "the user's text");
        // Once read, the write goes through; a second write builds on it.
        assert!(run(&mut seen, wp, "read_file", json!({ "path": "./a.txt" })).1);
        assert!(run(&mut seen, wp, "write_file", json!({ "path": "a.txt", "content": "new" })).1);
        assert!(run(&mut seen, wp, "write_file", json!({ "path": "a.txt", "content": "newer" })).1);
        assert_eq!(std::fs::read_to_string(wp.join("a.txt")).unwrap(), "newer");
        // An edit counts as seeing the file too.
        std::fs::write(wp.join("b.txt"), "one two").unwrap();
        assert!(run(&mut seen, wp, "edit_file", json!({ "path": "b.txt", "old_string": "two", "new_string": "three" })).1);
        assert!(run(&mut seen, wp, "write_file", json!({ "path": "b.txt", "content": "four" })).1);
        // A read that failed sees nothing.
        let mut fresh = FileSeen::default();
        assert!(!run(&mut fresh, wp, "read_file", json!({ "path": "a.txt/x" })).1);
        assert!(!run(&mut fresh, wp, "write_file", json!({ "path": "a.txt", "content": "x" })).1);
    }

    #[test]
    fn write_after_external_change_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        std::fs::write(wp.join("a.txt"), "v1").unwrap();
        let mut seen = FileSeen::default();
        assert!(run(&mut seen, wp, "read_file", json!({ "path": "a.txt" })).1);
        // The user edits the file while the turn runs.
        std::fs::write(wp.join("a.txt"), "the user's v2").unwrap();
        let (msg, ok) = run(&mut seen, wp, "write_file", json!({ "path": "a.txt", "content": "agent" }));
        assert!(!ok && msg.contains("changed on disk"), "{msg}");
        assert_eq!(std::fs::read_to_string(wp.join("a.txt")).unwrap(), "the user's v2");
        // Reading it again lets the write through.
        assert!(run(&mut seen, wp, "read_file", json!({ "path": "a.txt" })).1);
        assert!(run(&mut seen, wp, "write_file", json!({ "path": "a.txt", "content": "agent" })).1);
        // The same content rewritten (a touch, a formatter that changed nothing) isn't a change.
        std::fs::write(wp.join("a.txt"), "agent").unwrap();
        assert!(run(&mut seen, wp, "write_file", json!({ "path": "a.txt", "content": "agent 2" })).1);
    }

    #[test]
    fn write_new_file_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        let mut seen = FileSeen::default();
        let (msg, ok) = run(&mut seen, wp, "write_file", json!({ "path": "sub/new.txt", "content": "hi" }));
        assert!(ok, "{msg}");
        assert_eq!(std::fs::read_to_string(wp.join("sub/new.txt")).unwrap(), "hi");
        // The agent wrote it, so it may write it again.
        assert!(run(&mut seen, wp, "write_file", json!({ "path": "sub/new.txt", "content": "hi 2" })).1);
        // Other tools are never refused.
        assert_eq!(seen.refusal(wp, "edit_file", &json!({ "path": "sub/new.txt" })), None);
    }
}
