//! Talk's image attachments, kept with the conversation (#1159).
//!
//! An ask's images are saved as content-addressed files (`<sha256>.<ext>`)
//! in [`dir`], one `chat_attachments` row each, so a later turn sends them
//! again on the ask that carried them (`attach`): a follow-up can refer to an
//! image sent earlier, and the images stay byte-stable inside the cached
//! prefix. When the history gets close to the model's window, earlier images
//! go first, oldest first, each replaced by [`OMITTED`] ([`earlier_kept`]).
//! The ask being answered always keeps its own. A file is deleted once no row
//! names it ([`remove`]), so the same picture sent twice is one file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::chat_engine::Attachment;
use crate::context::budget::IMAGE_TOKENS;
use crate::providers::{LlmBlock, LlmContent, LlmMessage, LlmRole};

/// What an earlier image becomes once the budget has no room for it.
pub const OMITTED: &str = "[image omitted]";
/// Most images one request carries.
pub const MAX_IMAGES: usize = 20;
/// Most base64 bytes of images one request carries, well under the request
/// size providers accept (32 MB on Anthropic).
pub const MAX_IMAGE_BYTES: usize = 20_000_000;

/// Where the files live: beside the database, in the app data dir.
pub fn dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("octopush").join("chat-attachments")
}

fn extension(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// A name [`save`] gives: a SHA-256 hex digest and a known extension, so a
/// row can never point a read or a delete outside [`dir`].
fn is_ours(name: &str) -> bool {
    name.split_once('.').is_some_and(|(hash, ext)| {
        hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && ["png", "jpg", "gif", "webp"].contains(&ext)
    })
}

/// Save `attachment` in `dir` and return its file name. The same bytes make
/// the same name, written once.
pub fn save(dir: &Path, attachment: &Attachment) -> std::io::Result<String> {
    let invalid = |what: &str| std::io::Error::new(std::io::ErrorKind::InvalidInput, what.to_string());
    let ext = extension(&attachment.media_type).ok_or_else(|| invalid("not a supported image type"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(attachment.data.as_bytes())
        .map_err(|_| invalid("not base64"))?;
    let hash: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let name = format!("{hash}.{ext}");
    let path = dir.join(&name);
    if !path.exists() {
        std::fs::create_dir_all(dir)?;
        // Written beside it, then renamed: a crash never leaves a partial
        // file under the digest.
        let tmp = dir.join(format!(".{name}.tmp"));
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(name)
}

/// Delete the files `names` from [`dir`]: those no row names any more
/// (`Db::delete_chat_thread`, `Db::truncate_chat_after`).
pub fn remove(names: &[String]) {
    remove_in(&dir(), names)
}

pub fn remove_in(dir: &Path, names: &[String]) {
    for name in names.iter().filter(|n| is_ours(n)) {
        match std::fs::remove_file(dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                tracing::warn!(error = %e, file = %name, "failed to delete a Talk attachment");
            }
            _ => {}
        }
    }
}

/// A stored file's size as base64, `None` when it is gone.
fn base64_len(dir: &Path, name: &str) -> Option<usize> {
    let len = std::fs::metadata(dir.join(name)).ok()?.len() as usize;
    Some(len.div_ceil(3) * 4)
}

fn load(dir: &Path, name: &str, media_type: &str) -> Option<LlmBlock> {
    if !is_ours(name) {
        return None;
    }
    let bytes = std::fs::read(dir.join(name)).ok()?;
    Some(LlmBlock::Image { media_type: media_type.to_string(), data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// How many of the earlier asks' images (their base64 sizes, oldest first)
/// a request keeps: the newest, while the history (`base` tokens), the
/// current ask's images (`current`) and the kept ones stay within `limit`
/// tokens, [`MAX_IMAGES`] and [`MAX_IMAGE_BYTES`]. Each image counts
/// [`IMAGE_TOKENS`], as the context guard counts it. Pure.
pub fn earlier_kept(base: u64, limit: u64, current: &[usize], earlier: &[usize]) -> usize {
    let mut tokens = base + current.len() as u64 * IMAGE_TOKENS;
    let mut bytes: usize = current.iter().sum();
    let mut count = current.len();
    let mut kept = 0;
    for &size in earlier.iter().rev() {
        tokens += IMAGE_TOKENS;
        bytes += size;
        count += 1;
        if tokens > limit || bytes > MAX_IMAGE_BYTES || count > MAX_IMAGES {
            break;
        }
        kept += 1;
    }
    kept
}

/// The asks a thread's history puts images on: those with stored rows, and
/// the ask being answered when it sends `fresh` ones.
pub fn asks_with_images(stored: &[(i64, String, String)], current: Option<i64>, fresh: &[Attachment]) -> HashSet<i64> {
    let mut asks: HashSet<i64> = stored.iter().map(|(id, _, _)| *id).collect();
    if let Some(id) = current.filter(|_| !fresh.is_empty()) {
        asks.insert(id);
    }
    asks
}

/// Each ask's blocks in a request whose history is `base` tokens: the ask
/// being answered (`current`) carries `fresh` when this send has images,
/// else its stored ones, always; an earlier ask's images are loaded from
/// `dir` while [`earlier_kept`] keeps them, and are [`OMITTED`] otherwise
/// (a file that is gone too).
pub fn for_history(
    dir: &Path,
    stored: &[(i64, String, String)],
    current: Option<i64>,
    fresh: &[Attachment],
    base: u64,
    limit: u64,
) -> HashMap<i64, Vec<LlmBlock>> {
    let mut out: HashMap<i64, Vec<LlmBlock>> = HashMap::new();
    let is_current = |id: i64| Some(id) == current;
    if let Some(id) = current.filter(|_| !fresh.is_empty()) {
        let blocks = fresh.iter().map(|a| LlmBlock::Image { media_type: a.media_type.clone(), data: a.data.clone() });
        out.insert(id, blocks.collect());
    } else {
        for (id, name, media_type) in stored.iter().filter(|(id, _, _)| is_current(*id)) {
            out.entry(*id).or_default().push(load(dir, name, media_type).unwrap_or_else(|| LlmBlock::Text(OMITTED.into())));
        }
    }
    let current_sizes: Vec<usize> = out.values().flatten().map(|b| match b {
        LlmBlock::Image { data, .. } => data.len(),
        LlmBlock::Text(_) => 0,
    }).collect();
    let earlier: Vec<(i64, &str, &str, Option<usize>)> = stored
        .iter()
        .filter(|(id, _, _)| !is_current(*id))
        .map(|(id, name, media_type)| (*id, name.as_str(), media_type.as_str(), base64_len(dir, name)))
        .collect();
    let present: Vec<usize> = earlier.iter().filter_map(|e| e.3).collect();
    let mut dropped = present.len() - earlier_kept(base, limit, &current_sizes, &present);
    for (id, name, media_type, size) in earlier {
        let block = match size {
            Some(_) if dropped > 0 => {
                dropped -= 1;
                None
            }
            Some(_) => load(dir, name, media_type),
            None => None,
        };
        out.entry(id).or_default().push(block.unwrap_or_else(|| LlmBlock::Text(OMITTED.into())));
    }
    out
}

/// Put each ask's `blocks` back on the user message it landed in
/// (`landing[i]`: the asks message `i` holds, from `build_history_landing`
/// or `transcript::build_landing`), after its text. A message left with no
/// image stays text, its notes appended.
pub fn attach(messages: &mut [LlmMessage], landing: &[Vec<i64>], blocks: &HashMap<i64, Vec<LlmBlock>>) {
    for (message, asks) in messages.iter_mut().zip(landing) {
        let added: Vec<LlmBlock> = asks.iter().filter_map(|id| blocks.get(id)).flatten().cloned().collect();
        if added.is_empty() || message.role != LlmRole::User {
            continue;
        }
        let LlmContent::Text(text) = &message.content else { continue };
        let mut all: Vec<LlmBlock> = Vec::with_capacity(added.len() + 1);
        if !text.trim().is_empty() {
            all.push(LlmBlock::Text(text.clone()));
        }
        all.extend(added);
        message.content = if all.iter().all(|b| matches!(b, LlmBlock::Text(_))) {
            let parts: Vec<&str> = all.iter().filter_map(|b| match b {
                LlmBlock::Text(t) => Some(t.as_str()),
                LlmBlock::Image { .. } => None,
            }).collect();
            LlmContent::Text(parts.join("\n\n"))
        } else {
            LlmContent::Multimodal(all)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_history::{build_history, build_history_landing, HistoryRole, HistoryRow};
    use crate::db::Db;

    fn png(seed: u8) -> Attachment {
        let bytes: Vec<u8> = [0x89, b'P', b'N', b'G', seed].repeat(30);
        Attachment { media_type: "image/png".into(), data: base64::engine::general_purpose::STANDARD.encode(bytes) }
    }

    fn thread(db: &Db) -> String {
        db.insert_project("p", "P", "/tmp/p").unwrap();
        db.insert_workspace("ws", "p", "ws", "", "main", None, "", None).unwrap();
        db.create_chat_thread("ws", "T").unwrap().id
    }

    /// A thread's history as `send_agentic` builds it on the legacy engine.
    fn history(db: &Db, thread: &str, dir: &Path, fresh: &[Attachment], base_limit: (u64, u64)) -> Vec<LlmMessage> {
        let rows = db.list_chat_messages(thread).unwrap();
        let stored = db.list_chat_attachments(thread).unwrap();
        let current = rows.iter().rev().find(|m| m.role == "user").map(|m| m.id);
        let asks = asks_with_images(&stored, current, fresh);
        let rows: Vec<HistoryRow> =
            rows.iter().map(|m| HistoryRow { id: m.id, role: &m.role, content: &m.content, context: None }).collect();
        let (turns, landing) = build_history_landing(&rows, &asks);
        let mut messages: Vec<LlmMessage> = turns
            .into_iter()
            .map(|t| LlmMessage { role: if t.role == HistoryRole::User { LlmRole::User } else { LlmRole::Assistant }, content: LlmContent::Text(t.text) })
            .collect();
        let shown = for_history(dir, &stored, current, fresh, base_limit.0, base_limit.1);
        attach(&mut messages, &landing, &shown);
        messages
    }

    fn images(m: &LlmMessage) -> Vec<String> {
        match &m.content {
            LlmContent::Multimodal(blocks) => blocks
                .iter()
                .filter_map(|b| match b {
                    LlmBlock::Image { data, .. } => Some(data.clone()),
                    LlmBlock::Text(_) => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    fn send(db: &Db, thread: &str, dir: &Path, text: &str, attachments: &[Attachment]) -> i64 {
        let id = db.insert_chat_message("ws", thread, "user", text, None, None, None, None).unwrap();
        for a in attachments {
            db.add_chat_attachment(id, &save(dir, a).unwrap(), &a.media_type).unwrap();
        }
        id
    }

    #[test]
    fn images_replayed_on_next_turn() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let t = thread(&db);
        let shot = png(1);
        send(&db, &t, dir.path(), "what's wrong with this header?", std::slice::from_ref(&shot));
        db.insert_chat_message("ws", &t, "assistant", "The logo overlaps the title.", None, None, None, None).unwrap();
        send(&db, &t, dir.path(), "and the button at the bottom?", &[]);

        let messages = history(&db, &t, dir.path(), &[], (0, 100_000));
        assert_eq!(messages.len(), 3);
        // The earlier ask carries its image again, after its text; the
        // follow-up is text.
        assert_eq!(images(&messages[0]), [shot.data.clone()]);
        let LlmContent::Multimodal(blocks) = &messages[0].content else { panic!("{messages:?}") };
        assert!(matches!(&blocks[0], LlmBlock::Text(t) if t == "what's wrong with this header?"));
        assert!(matches!(&messages[2].content, LlmContent::Text(t) if t == "and the button at the bottom?"));
        // The same bytes on every later turn: inside the cached prefix.
        let again = history(&db, &t, dir.path(), &[], (0, 100_000));
        assert_eq!(serde_json::to_string(&again[0]).unwrap(), serde_json::to_string(&messages[0]).unwrap());

        // An image sent alone keeps its place (here merged into the ask before
        // it, which had no answer), and the ask being sent carries this send's
        // images whether or not they were saved.
        send(&db, &t, dir.path(), "", &[png(2)]);
        let messages = history(&db, &t, dir.path(), &[], (0, 100_000));
        assert_eq!(images(messages.last().unwrap()), [png(2).data]);
        let id = send(&db, &t, dir.path(), "and this one?", &[]);
        let fresh = history(&db, &t, dir.path(), &[png(3)], (0, 100_000));
        assert_eq!(images(fresh.last().unwrap()), [png(2).data, png(3).data]);
        assert!(db.list_chat_attachments(&t).unwrap().iter().all(|(m, _, _)| *m != id));

        // The v2 transcript puts it on the same ask.
        let rows = db.list_chat_messages(&t).unwrap();
        let stored = db.list_chat_attachments(&t).unwrap();
        let asks = asks_with_images(&stored, Some(id), &[]);
        let (mut v2, landing) = crate::context::transcript::build_landing(&crate::context::transcript::rows(&rows), "m", &asks);
        attach(&mut v2, &landing, &for_history(dir.path(), &stored, Some(id), &[], 0, 100_000));
        assert_eq!(images(&v2[0]), [shot.data]);
    }

    #[test]
    fn images_dropped_first_under_budget() {
        // Room for two images past the history: the newest two are kept.
        let limit = 10_000 + 2 * IMAGE_TOKENS;
        assert_eq!(earlier_kept(10_000, limit, &[], &[100, 100, 100]), 2);
        // The current ask's images are counted first and always sent.
        assert_eq!(earlier_kept(10_000, limit, &[100], &[100, 100, 100]), 1);
        assert_eq!(earlier_kept(10_000, limit, &[100, 100, 100], &[100]), 0);
        // The image caps hold whatever the window.
        assert_eq!(earlier_kept(0, u64::MAX, &[], &[MAX_IMAGE_BYTES / 2; 3]), 2);
        assert_eq!(earlier_kept(0, u64::MAX, &[], &[1; 50]), MAX_IMAGES);

        let tmp = tempfile::NamedTempFile::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let t = thread(&db);
        for k in 1..=3 {
            send(&db, &t, dir.path(), &format!("shot {k}"), &[png(k)]);
            db.insert_chat_message("ws", &t, "assistant", "seen", None, None, None, None).unwrap();
        }
        send(&db, &t, dir.path(), "compare them", &[png(4)]);
        // Oldest first, each replaced by a note; the ask being answered
        // keeps its image.
        let messages = history(&db, &t, dir.path(), &[], (10_000, 10_000 + 2 * IMAGE_TOKENS));
        assert!(matches!(&messages[0].content, LlmContent::Text(t) if t == &format!("shot 1\n\n{OMITTED}")), "{:?}", messages[0]);
        assert!(matches!(&messages[2].content, LlmContent::Text(t) if t.ends_with(OMITTED)));
        assert_eq!(images(&messages[4]), [png(3).data]);
        assert_eq!(images(&messages[6]), [png(4).data]);
        // Plenty of room: every image goes.
        let roomy = history(&db, &t, dir.path(), &[], (10_000, 1_000_000));
        assert_eq!(roomy.iter().map(|m| images(m).len()).sum::<usize>(), 4);
    }

    #[test]
    fn images_deleted_with_thread() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let t = thread(&db);
        let file = |a: &Attachment| dir.path().join(save(dir.path(), a).unwrap());
        // The same picture sent in two threads is one file.
        send(&db, &t, dir.path(), "one", &[png(1)]);
        let second = send(&db, &t, dir.path(), "two", &[png(2)]);
        let other = db.create_chat_thread("ws", "U").unwrap().id;
        send(&db, &other, dir.path(), "same", &[png(1)]);
        assert!(file(&png(1)).exists() && file(&png(2)).exists());

        // A truncate removes the files of the rows it removes.
        remove_in(dir.path(), &db.truncate_chat_after(&t, second).unwrap());
        assert!(!dir.path().join(save_name(&png(2))).exists());
        // Deleting the thread keeps a file another thread's row names...
        remove_in(dir.path(), &db.delete_chat_thread(&t).unwrap());
        assert!(dir.path().join(save_name(&png(1))).exists());
        assert!(db.list_chat_attachments(&t).unwrap().is_empty());
        // ...and the last thread that names it takes it.
        remove_in(dir.path(), &db.delete_chat_thread(&other).unwrap());
        assert!(!dir.path().join(save_name(&png(1))).exists());
        // A name that isn't one we wrote is never deleted.
        std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
        remove_in(dir.path(), &["notes.txt".to_string(), "../notes.txt".to_string()]);
        assert!(dir.path().join("notes.txt").exists());
    }

    /// The name [`save`] gives `a`, without writing it.
    fn save_name(a: &Attachment) -> String {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&a.data).unwrap();
        let hash: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        format!("{hash}.png")
    }

    #[test]
    fn old_threads_without_attachments_unchanged() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let t = thread(&db);
        // An old thread: an image-only ask (whose images were never kept), a
        // failed turn, and asks in a row.
        send(&db, &t, dir.path(), "", &[]);
        db.insert_chat_message("ws", &t, "assistant", "I can't see an image.", None, None, None, None).unwrap();
        send(&db, &t, dir.path(), "first", &[]);
        db.insert_chat_message("ws", &t, "error", "boom", None, None, None, None).unwrap();
        send(&db, &t, dir.path(), "second", &[]);
        let rows = db.list_chat_messages(&t).unwrap();
        let rows: Vec<HistoryRow> =
            rows.iter().map(|m| HistoryRow { id: m.id, role: &m.role, content: &m.content, context: None }).collect();
        let before: Vec<String> = build_history(&rows).into_iter().map(|t| t.text).collect();
        let messages = history(&db, &t, dir.path(), &[], (0, 100_000));
        let after: Vec<String> = messages
            .iter()
            .map(|m| match &m.content {
                LlmContent::Text(t) => t.clone(),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(after, before);
        assert_eq!(after, ["I can't see an image.", "first\n\nsecond"]);
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none(), "nothing written");
    }
}
