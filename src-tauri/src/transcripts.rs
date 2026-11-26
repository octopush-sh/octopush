//! RUN-mode spend from Claude Code's own transcripts.
//!
//! A RUN session is a terminal running `claude`; Octopush only sees its
//! screen. PTY scraping (`token_engine::scan_pty_output`) catches the
//! `Total cost:` summary line — cost with no model and no cache split — so
//! RUN spend used to land in the ledger as `model = unknown`, `cache = 0`.
//!
//! Claude Code also writes every API turn to a JSONL transcript under
//! `~/.claude/projects/<cwd with every non-alphanumeric char → '-'>/<session>.jsonl`:
//! one `type: "assistant"` line per content block, each carrying the
//! message's `model` and its full `usage` (`input_tokens`,
//! `cache_read_input_tokens`, `cache_creation_input_tokens`,
//! `output_tokens`, and `cache_creation.ephemeral_1h_input_tokens` — the
//! 1-hour-TTL share of the writes, priced at the 1-hour rate) — plus
//! `speed: "fast"` on a fast-mode turn, priced at the fast rate
//! (`token_engine::fast_prices`). That is the same data an API provider returns, so the
//! ingestor reads it and records RUN spend with the real model and the real
//! cache split — one ledger row per API message.
//!
//! Mechanics:
//! - Only project directories that correspond to an Octopush RUN session's
//!   `project_root` or a workspace's worktree path are read; Claude Code use
//!   elsewhere on the machine is not Octopush spend. Claude Code caps a
//!   directory name at 200 characters and appends a hash; a long worktree
//!   path is resolved to that capped name too (`project_dirs_for`).
//! - Files are read incrementally: a per-file byte offset in `app_meta`
//!   (`cc_transcript:<path>`) advances past every complete line consumed, so
//!   a poll costs one `stat` per file when nothing changed.
//! - Every billed message is keyed `cc:<request id>` in the ledger's
//!   `idempotency_key` (request ids are globally unique, so a `--resume`d
//!   session that rewrites old turns into a new file adds nothing); several
//!   transcript lines for one message (one per content block) collapse to
//!   one row, a block that lands after the next poll updates that row, and
//!   a re-read (offset reset after a file was truncated) can't double-count.
//! - PTY scraping and transcripts never both count a run: the scanner skips
//!   any source whose cwd has a transcript directory, every session on the
//!   root and every terminal of the workspace is flagged
//!   (`transcript_seen:<id>`), and the first time a target's transcripts
//!   are read its already-scraped rows from that point on are removed.
//! - A Direct stage's `claude -p` session runs in a workspace worktree too,
//!   but its spend is already the stage's `direct` row: every session id a
//!   stage reports is kept in `direct_cli_sessions`, and its transcript —
//!   with any sub-agent files under `<session>/` — is never metered here.
//!   One read before the id was known is undone: its RUN rows are deleted
//!   by request key (#861) — by the drive itself, the moment the stage
//!   reports its session (`drop_direct_session`, #863). A pass whose
//!   snapshot of Direct sessions predates that report re-checks each file's
//!   session under the DB lock before it writes (#890), so it never puts
//!   back what the drop removed.
//! - Side effects that describe *now* (a session's live counters, the
//!   Logbook activity span) fire only for messages minutes old; historical
//!   rows are attributed to the mission that existed at their timestamp.

use crate::db::{Db, SpendEvent};
use crate::error::AppResult;
use crate::token_engine::{prices_at_speed, prices_for, ModelPrices};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Least time between two polls triggered by the Usage page.
const MIN_POLL_INTERVAL: Duration = Duration::from_secs(30);
/// How deep under a project directory to look for `.jsonl` files (the
/// session file sits at depth 1; sub-agent transcripts may nest one deeper).
const MAX_DEPTH: usize = 3;

/// A message counts as live (session counters, Logbook activity) within
/// this many seconds of its timestamp.
const LIVE_WINDOW_SECS: i64 = 10 * 60;

/// The directory Claude Code keeps transcripts in.
pub fn projects_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("projects")
}

/// Claude Code caps a project directory name at this many characters and
/// appends `-<6-char hash>` to one that would be longer — a worktree named
/// after a ticket summary gets there easily.
pub const DIR_NAME_CAP: usize = 200;

/// The names of the directories directly under `root` — one listing a
/// pass, for [`project_dirs_among`].
pub fn project_dir_listing(root: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    rd.flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect()
}

/// The transcript directories Claude Code may have created for `cwd` under
/// `root`, by name: the exact sanitized name, and — when that name is over
/// the cap — a directory carrying its first [`DIR_NAME_CAP`] characters
/// plus a `-<hash>` suffix **whose transcripts were written from `cwd`**.
/// Two long paths can share their first 200 characters, and the hash is
/// Claude Code's to compute, so a capped candidate is claimed by what its
/// lines say, never by its name alone. Only directories that exist.
pub fn project_dirs_among(root: &Path, listing: &[String], cwd: &str) -> Vec<String> {
    let full = project_dir_name(cwd);
    let mut out = Vec::new();
    if listing.iter().any(|n| n == &full) {
        out.push(full.clone());
    }
    if full.chars().count() > DIR_NAME_CAP {
        let prefix: String = full.chars().take(DIR_NAME_CAP).collect();
        for name in listing {
            let Some(rest) = name.strip_prefix(&prefix) else { continue };
            if rest.len() > 1 && rest.starts_with('-') && name != &full && !out.contains(name) && transcripts_written_from(&root.join(name), cwd) {
                out.push(name.clone());
            }
        }
    }
    out
}

/// [`project_dirs_among`] over a fresh listing of `root`.
pub fn project_dirs_for(root: &Path, cwd: &str) -> Vec<String> {
    project_dirs_among(root, &project_dir_listing(root), cwd)
}

/// Whether the transcripts under `dir` were written from `cwd`: the first
/// line carrying a `cwd` field, in any of its first few files, says so.
/// A directory with no such line claims nothing (and has nothing to meter).
fn transcripts_written_from(dir: &Path, cwd: &str) -> bool {
    let mut files = Vec::new();
    jsonl_files(dir, 0, &mut files);
    files.sort();
    for file in files.iter().take(4) {
        let Ok(f) = std::fs::File::open(file) else { continue };
        let mut reader = BufReader::new(f);
        let mut buf: Vec<u8> = Vec::new();
        for _ in 0..50 {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if !buf.windows(5).any(|w| w == b"\"cwd\"") {
                continue;
            }
            let line = String::from_utf8_lossy(&buf);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                    return c == cwd;
                }
            }
        }
    }
    false
}

/// Whether Claude Code has a transcript directory for `cwd` (created the
/// moment `claude` first runs there). Checked by the PTY scanner before it
/// records a screen-scraped summary.
pub fn has_transcript_dir(cwd: &str) -> bool {
    let root = projects_root();
    !project_dirs_for(&root, cwd).is_empty()
        || std::fs::canonicalize(cwd)
            .ok()
            .map(|c| !project_dirs_for(&root, &c.to_string_lossy()).is_empty())
            .unwrap_or(false)
}

/// One ledger-ready message pulled from a transcript line.
#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptUsage {
    /// Claude Code's own session id (the file stem).
    pub session_id: String,
    /// The ledger idempotency key: `cc:<requestId>`, else `cc:msg:<message id>`
    /// — one per billed API call, unique across sessions and files.
    pub key: String,
    /// The provider's message id (`msg_…`), kept beside the key so a
    /// gateway's request log can be matched whichever id it recorded.
    pub message_id: Option<String>,
    /// RFC3339 UTC.
    pub ts_utc: String,
    pub cwd: Option<String>,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// The part of `cache_creation_tokens` written with a 1-hour TTL
    /// (`usage.cache_creation.ephemeral_1h_input_tokens`); `0` without the
    /// breakdown.
    pub cache_creation_1h_tokens: u64,
    /// `usage.speed` (`"fast"` in fast mode); `None` when not reported.
    pub speed: Option<String>,
}

/// What one ingestion pass did — for logs and tests.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct IngestSummary {
    pub files_scanned: usize,
    pub rows_inserted: usize,
    /// RUN rows removed because their transcript turned out to be a Direct
    /// stage's CLI session (#861).
    pub rows_removed: usize,
}

/// The directory name Claude Code derives from a working directory: every
/// character outside `[A-Za-z0-9]` becomes `-` (`/home/u/repo` →
/// `-home-u-repo`).
pub fn project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Parse one transcript line. `None` for anything but an assistant message
/// with usage (user turns, summaries, tool results, malformed lines).
pub fn parse_transcript_line(line: &str, file_session_id: &str) -> Option<TranscriptUsage> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return None;
    }
    let message = v.get("message")?;
    let usage = message.get("usage")?;
    let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let input_tokens = g("input_tokens");
    let output_tokens = g("output_tokens");
    let cache_read_tokens = g("cache_read_input_tokens");
    let cache_creation_tokens = g("cache_creation_input_tokens");
    let cache_creation_1h_tokens = crate::token_engine::one_hour_cache_writes(usage);
    if input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens == 0 {
        return None;
    }
    let model = message
        .get("model")
        .and_then(|m| m.as_str())
        .filter(|m| !m.is_empty())
        .unwrap_or("unknown")
        .to_string();
    // Synthetic rows (`<synthetic>` model on an interrupted turn) bill nothing.
    if model.starts_with('<') {
        return None;
    }
    let message_id = message.get("id").and_then(|i| i.as_str()).filter(|k| !k.is_empty()).map(str::to_string);
    let key = match v.get("requestId").and_then(|r| r.as_str()).filter(|k| !k.is_empty()) {
        Some(req) => format!("cc:{req}"),
        None => format!("cc:msg:{}", message_id.as_deref()?),
    };
    let session_id = v
        .get("sessionId")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(file_session_id)
        .to_string();
    let ts_raw = v.get("timestamp").and_then(|t| t.as_str())?;
    let ts_utc = chrono::DateTime::parse_from_rfc3339(ts_raw)
        .map(|d| d.with_timezone(&chrono::Utc).to_rfc3339())
        .unwrap_or_else(|_| ts_raw.to_string());
    let cwd = v.get("cwd").and_then(|c| c.as_str()).map(str::to_string);
    Some(TranscriptUsage {
        session_id,
        key,
        message_id,
        ts_utc,
        cwd,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cache_creation_1h_tokens,
        speed: crate::token_engine::usage_speed(usage),
    })
}

/// Read the complete lines of `path` from byte `offset`, folding the
/// per-block lines of one message into one entry (the LAST line's usage
/// wins — every block of a message carries the same final usage). Returns
/// the entries in first-seen order and the offset just past the last
/// complete line (a trailing partial line — the CLI mid-write — is left
/// for the next pass).
pub fn read_new_entries(path: &Path, offset: u64) -> std::io::Result<(Vec<TranscriptUsage>, u64)> {
    let file_session = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = if offset > len { 0 } else { offset };
    file.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::new(file);
    let mut consumed = start;
    let mut order: Vec<TranscriptUsage> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        if buf.last() != Some(&b'\n') {
            break; // partial trailing line: not consumed
        }
        consumed += n as u64;
        // Cheap pre-filter: user turns (which can carry multi-MB images)
        // and summaries never mention an assistant.
        if !buf.windows(11).any(|w| w == b"\"assistant\"") {
            continue;
        }
        let line = String::from_utf8_lossy(&buf);
        if let Some(u) = parse_transcript_line(&line, &file_session) {
            match index.get(&u.key) {
                Some(&i) => order[i] = u,
                None => {
                    index.insert(u.key.clone(), order.len());
                    order.push(u);
                }
            }
        }
    }
    Ok((order, consumed))
}

// ─── One session, read for the Run Companion ──────────────────────

/// The newest main-thread prompt of one Claude Code session, from its
/// transcript: what the Run Companion's context meter shows.
#[derive(Clone, Debug, PartialEq)]
pub struct LastPrompt {
    /// Input + cache read + cache write of the session's last API message:
    /// the whole prompt, which is how full the context window is.
    pub tokens: u64,
    pub model: String,
    /// RFC3339 UTC.
    pub ts_utc: String,
}

/// How far back from the end of a transcript [`last_prompt`] looks: a first
/// short read, then one long enough to step over a pasted image.
const TAIL_READS: [u64; 2] = [256 * 1024, 8 * 1024 * 1024];

/// The session's transcript under `root` for a session started in `cwd`
/// (as written or canonicalized, and under Claude Code's capped directory
/// name for a long path). A session id that could leave its directory
/// names no file.
fn session_file(root: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.starts_with('.') {
        return None;
    }
    let mut dirs = project_dirs_for(root, cwd);
    if let Ok(c) = std::fs::canonicalize(cwd) {
        for d in project_dirs_for(root, &c.to_string_lossy()) {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    dirs.into_iter()
        .map(|d| root.join(d).join(format!("{session_id}.jsonl")))
        .find(|f| f.is_file())
}

/// [`LastPrompt`] of the Claude Code session `session_id` started in `cwd`:
/// the last `assistant` line of its own transcript that carries usage and is
/// not a sub-agent's (`isSidechain`; a sub-agent's prompt is its own
/// context, not the session's). Read from the end of the file, never the
/// whole of it. `None` when there is no transcript, no such line within
/// [`TAIL_READS`], or the conversation was compacted after that line (the
/// next message will say how large the compacted context is; until then it
/// is not known).
pub fn last_prompt(root: &Path, cwd: &str, session_id: &str) -> Option<LastPrompt> {
    use std::io::Read;
    let path = session_file(root, cwd, session_id)?;
    let mut file = std::fs::File::open(&path).ok()?;
    let len = file.metadata().ok()?.len();
    for reach in TAIL_READS {
        let start = len.saturating_sub(reach);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::new();
        file.by_ref().take(len - start).read_to_end(&mut buf).ok()?;
        let mut lines: Vec<&[u8]> = buf.split(|b| *b == b'\n').collect();
        if start > 0 {
            // The read began mid-line.
            lines.remove(0);
        }
        for line in lines.into_iter().rev() {
            if line.windows(18).any(|w| w == b"\"compact_boundary\"") {
                let text = String::from_utf8_lossy(line);
                let v: Option<serde_json::Value> = serde_json::from_str(text.trim()).ok();
                if v.is_some_and(|v| v.get("subtype").and_then(|s| s.as_str()) == Some("compact_boundary")) {
                    return None;
                }
            }
            if !line.windows(11).any(|w| w == b"\"assistant\"") {
                continue;
            }
            let text = String::from_utf8_lossy(line);
            let Some(u) = parse_transcript_line(&text, session_id) else { continue };
            let sidechain = serde_json::from_str::<serde_json::Value>(text.trim())
                .ok()
                .and_then(|v| v.get("isSidechain").and_then(|s| s.as_bool()))
                .unwrap_or(false);
            if sidechain {
                continue;
            }
            return Some(LastPrompt {
                tokens: u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens,
                model: u.model,
                ts_utc: u.ts_utc,
            });
        }
        if start == 0 {
            break;
        }
    }
    None
}

/// What the Run Companion's Context section shows for one terminal's Claude
/// Code session (`get_session_usage`).
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    /// The session's last prompt ([`LastPrompt::tokens`]); `None` when the
    /// transcript can't say (see [`last_prompt`]).
    pub context_tokens: Option<u64>,
    /// The model's context window from the provider catalog; `None` for a
    /// model the catalog doesn't list.
    pub max_context: Option<u64>,
    /// The session's priced spend in the ledger.
    pub spent_usd: f64,
    /// Ledger rows (billed API calls) of the session.
    pub calls: i64,
    /// Those of `calls` on a model without a price, left out of `spent_usd`.
    pub unpriced_calls: i64,
    /// The share of the session's prompt tokens read from the cache, 0–100.
    pub cache_hit_pct: Option<f64>,
    /// The model of the last prompt, else of the newest ledger row.
    pub model: String,
    /// When that last message was written (RFC3339 UTC).
    pub as_of: String,
}

/// [`SessionUsage`] of the Claude Code session the Run terminal
/// `terminal_id` runs now (`Db::terminal_claude_session`, kept by the hook
/// poller). `None` when it runs none: a shell, another agent CLI, a session
/// that ended. See [`session_usage`] for when a current session's figures
/// are withheld.
pub fn terminal_usage(db: &Mutex<Db>, root: &Path, terminal_id: &str) -> AppResult<Option<SessionUsage>> {
    let Some((session, linked_at)) = db.lock().terminal_claude_session(terminal_id)? else { return Ok(None) };
    session_usage(db, root, terminal_id, &session, &linked_at)
}

/// [`SessionUsage`] of the Claude Code session `session_id`, the current
/// session of the Run terminal `terminal_id` since a hook said so at
/// `linked_at`. Spend and cache share
/// come from the ledger rows the ingestor keyed `cc:<session id>`; the
/// context size from the session's own transcript under `root`. Read-only.
///
/// `None`, so that nothing is shown rather than zeroes or figures that may
/// be another session's, when:
/// - the ledger has no row for the session (nothing metered yet; or its
///   rows are keyed by a legacy RUN session on the same root and can't be
///   told from another conversation's);
/// - the session has a rival (`Db::run_session_has_rival`): another Claude
///   Code session was metered in the workspace after both the hook that
///   named this pair and this session's last message, and it is neither
///   over nor another terminal's. With `SessionStart` and `SessionEnd`
///   hooks every session in a terminal is one or the other, so this only
///   catches what those can't: a session whose hooks predate them, where
///   `/clear`, a resume or a restart is silent until its next `Stop`, and a
///   session started outside Octopush's terminals.
pub fn session_usage(
    db: &Mutex<Db>,
    root: &Path,
    terminal_id: &str,
    session_id: &str,
    linked_at: &str,
) -> AppResult<Option<SessionUsage>> {
    let (ledger, cwd) = {
        let db = db.lock();
        let source = format!("cc:{session_id}");
        let Some(ledger) = db.run_session_ledger(&source)? else { return Ok(None) };
        let Some(workspace) = db.terminal_workspace(terminal_id)? else { return Ok(None) };
        let since = linked_at.max(ledger.last_ts.as_str());
        if db.run_session_has_rival(&workspace, terminal_id, &source, since)? {
            return Ok(None);
        }
        (ledger, db.run_cwd_for_source(terminal_id)?)
    };
    // The transcript is read without the DB lock.
    let prompt = cwd.and_then(|cwd| last_prompt(root, &cwd, session_id));
    let (model, as_of) = match &prompt {
        Some(p) => (p.model.clone(), p.ts_utc.clone()),
        None => (ledger.last_model.clone(), ledger.last_ts.clone()),
    };
    let max_context = crate::token_engine::catalog()
        .and_then(|c| c.find_model(&model).map(|(_, m)| m.max_context))
        .filter(|w| *w > 0);
    Ok(Some(SessionUsage {
        context_tokens: prompt.map(|p| p.tokens),
        max_context,
        spent_usd: ledger.spent_usd,
        calls: ledger.calls,
        unpriced_calls: ledger.unpriced_calls,
        cache_hit_pct: ledger.cache_hit_pct,
        model,
        as_of,
    }))
}

/// Where a transcript's spend is attributed.
#[derive(Clone, Debug, Default)]
struct Target {
    /// The cwd this target's transcripts were written from.
    cwd: String,
    /// Octopush RUN sessions opened on this cwd, most recently active first.
    /// The first one receives the spend's `source_id` and live counters.
    session_ids: Vec<String>,
    workspace_id: Option<String>,
    project_id: Option<String>,
}

fn jsonl_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if depth + 1 < MAX_DEPTH {
                jsonl_files(&p, depth + 1, out);
            }
        } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(p);
        }
    }
}

/// The Direct-stage session `file` belongs to, if any: its own stem (the
/// session file, `<session>.jsonl`) or a directory between the project
/// directory and it (a sub-agent transcript under `<session>/…`).
fn direct_session_of(project_dir: &Path, file: &Path, direct: &std::collections::HashSet<String>) -> Option<String> {
    if direct.is_empty() {
        return None;
    }
    session_candidates(project_dir, file).into_iter().find(|c| direct.contains(c))
}

/// Every session id `file` could belong to, in [`direct_session_of`]'s
/// order: its own stem, then each directory between the project directory
/// and it.
fn session_candidates(project_dir: &Path, file: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(stem) = file.file_stem().and_then(|s| s.to_str()) {
        out.push(stem.to_string());
    }
    if let Some(parent) = file.strip_prefix(project_dir).ok().and_then(Path::parent) {
        out.extend(parent.components().filter_map(|c| c.as_os_str().to_str()).map(str::to_string));
    }
    out
}

/// A transcript of a Direct stage's CLI session: never metered as RUN
/// spend (#861). If an earlier pass already read it — before the stage
/// reported its session id, or before this rule existed — the RUN rows it
/// produced are found by re-reading the file (the ledger keys each one
/// `cc:<request id>`) and deleted, and the file's offset is dropped, so
/// every later pass skips it with no read. Returns the rows removed.
fn drop_direct_file(db: &Arc<Mutex<Db>>, path: &Path) -> AppResult<usize> {
    let meta_key = format!("cc_transcript:{}", path.display());
    let offset = db
        .lock()
        .meta_get(&meta_key)?
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    if offset == 0 {
        return Ok(0);
    }
    let (entries, _) = read_new_entries(path, 0)?;
    let keys: Vec<String> = entries.into_iter().map(|u| u.key).collect();
    let db = db.lock();
    let removed = db.delete_run_spend_by_keys(&keys)?;
    db.meta_delete(&meta_key)?;
    if removed > 0 {
        tracing::info!(file = %path.display(), removed, "removed RUN rows double-counting a Direct stage session");
    }
    Ok(removed)
}

/// Undo, right now, whatever the ingestor already metered from a Direct
/// stage's CLI session `session_id` — its `<session>.jsonl` and any
/// sub-agent files under `<session>/`, in every project directory under
/// `root` (#863). The drive calls this as soon as the stage reports its
/// session, so the budget gates never see the stage counted twice (its
/// `direct` row plus the RUN rows of a mid-run ingest pass) while waiting
/// for the next pass to clean up. Same cleanup as the pass itself
/// ([`drop_direct_file`]); a file never read costs one `stat`. Returns the
/// rows removed.
pub fn drop_direct_session(db: &Arc<Mutex<Db>>, root: &Path, session_id: &str) -> AppResult<usize> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.starts_with('.') {
        return Ok(0);
    }
    let mut files = Vec::new();
    for dir_name in project_dir_listing(root) {
        let dir = root.join(&dir_name);
        let main = dir.join(format!("{session_id}.jsonl"));
        if main.is_file() {
            files.push(main);
        }
        let sub = dir.join(session_id);
        if sub.is_dir() {
            jsonl_files(&sub, 1, &mut files);
        }
    }
    let mut removed = 0usize;
    for file in files {
        match drop_direct_file(db, &file) {
            Ok(n) => removed += n,
            Err(e) => tracing::warn!(file = %file.display(), session = %session_id, error = %e, "direct-session transcript cleanup failed"),
        }
    }
    Ok(removed)
}

pub struct TranscriptIngestor {
    db: Arc<Mutex<Db>>,
    root: PathBuf,
    last_run: Mutex<Option<Instant>>,
}

impl TranscriptIngestor {
    /// Reads `~/.claude/projects`.
    pub fn new(db: Arc<Mutex<Db>>) -> Self {
        Self::with_root(db, projects_root())
    }

    pub fn with_root(db: Arc<Mutex<Db>>, root: PathBuf) -> Self {
        Self { db, root, last_run: Mutex::new(None) }
    }

    /// Ingest unless a pass ran within the last [`MIN_POLL_INTERVAL`].
    pub fn maybe_ingest(&self) -> Option<IngestSummary> {
        {
            let mut last = self.last_run.lock();
            if matches!(*last, Some(t) if t.elapsed() < MIN_POLL_INTERVAL) {
                return None;
            }
            *last = Some(Instant::now());
        }
        match self.ingest() {
            Ok(s) => Some(s),
            Err(e) => {
                tracing::warn!(error = %e, "claude transcript ingestion failed");
                None
            }
        }
    }

    /// Attribution map: Claude Code project dir name → where the spend goes.
    /// A path is keyed both as written and canonicalized (Claude Code records
    /// the physical cwd, so a symlinked root would otherwise never match),
    /// and by the capped `<200 chars>-<hash>` name Claude Code uses for a
    /// long path, when such a directory exists.
    fn targets(&self) -> AppResult<HashMap<String, Target>> {
        let mut targets: HashMap<String, Target> = HashMap::new();
        let listing = project_dir_listing(&self.root);
        let keys_for = |path: &str| -> Vec<String> {
            let mut keys: Vec<String> = Vec::new();
            let mut push = |k: String| {
                if !keys.contains(&k) {
                    keys.push(k);
                }
            };
            push(project_dir_name(path));
            project_dirs_among(&self.root, &listing, path).into_iter().for_each(&mut push);
            if let Ok(c) = std::fs::canonicalize(path) {
                let c = c.to_string_lossy().to_string();
                push(project_dir_name(&c));
                project_dirs_among(&self.root, &listing, &c).into_iter().for_each(&mut push);
            }
            keys
        };
        let db = self.db.lock();
        for (id, project_id, path) in db.list_workspace_paths()? {
            for key in keys_for(&path) {
                targets.entry(key).or_insert_with(|| Target {
                    cwd: path.clone(),
                    session_ids: Vec::new(),
                    workspace_id: Some(id.clone()),
                    project_id: Some(project_id.clone()),
                });
            }
        }
        // Sessions are listed most-recently-active first.
        for s in db.list_sessions()? {
            for key in keys_for(&s.project_root) {
                let entry = targets.entry(key).or_insert_with(|| Target {
                    cwd: s.project_root.clone(),
                    ..Target::default()
                });
                if !entry.session_ids.contains(&s.id) {
                    entry.session_ids.push(s.id.clone());
                }
                if entry.workspace_id.is_none() {
                    // A session opened on a workspace's worktree: attribute to it.
                    if let Some((ws, pid)) = db.workspace_by_path(&s.project_root)? {
                        entry.workspace_id = Some(ws);
                        entry.project_id = Some(pid);
                    }
                }
            }
        }
        Ok(targets)
    }

    /// One full pass over every transcript that belongs to an Octopush
    /// session or workspace. A file that cannot be read is logged and
    /// skipped; it never stops the other targets from being metered.
    pub fn ingest(&self) -> AppResult<IngestSummary> {
        if !self.root.is_dir() {
            return Ok(IngestSummary::default());
        }
        let direct_sessions = self.db.lock().direct_cli_session_ids()?;
        self.ingest_with_direct_snapshot(direct_sessions)
    }

    /// [`Self::ingest`] with the Direct-session snapshot taken by the caller.
    /// The snapshot only spares a known Direct file a read: `ingest_file`
    /// re-checks membership under the DB lock, so a session recorded after
    /// the snapshot is still never metered (#890).
    pub(crate) fn ingest_with_direct_snapshot(
        &self,
        direct_sessions: std::collections::HashSet<String>,
    ) -> AppResult<IngestSummary> {
        let mut summary = IngestSummary::default();
        if !self.root.is_dir() {
            return Ok(summary);
        }
        for (dir_name, target) in self.targets()? {
            let dir = self.root.join(&dir_name);
            if !dir.is_dir() {
                continue;
            }
            let mut files = Vec::new();
            jsonl_files(&dir, 0, &mut files);
            if files.is_empty() {
                continue;
            }
            // Every source that could scrape this cwd is now transcript-metered.
            let scrape_sources = {
                let db = self.db.lock();
                let mut ids = target.session_ids.clone();
                if let Some(ws) = &target.workspace_id {
                    ids.extend(db.terminal_ids_for_workspace(ws)?);
                }
                for id in &ids {
                    db.meta_set(&format!("transcript_seen:{id}"), "1")?;
                }
                ids
            };
            let first_pass = self
                .db
                .lock()
                .meta_get(&format!("transcript_target_seen:{dir_name}"))?
                .is_none();
            let mut earliest: Option<String> = None;
            for file in files {
                summary.files_scanned += 1;
                // A Direct stage's own `claude -p` session (or one of its
                // sub-agents) is already metered as the stage's `direct` row.
                if let Some(sid) = direct_session_of(&dir, &file, &direct_sessions) {
                    match drop_direct_file(&self.db, &file) {
                        Ok(removed) => summary.rows_removed += removed,
                        Err(e) => tracing::warn!(file = %file.display(), session = %sid, error = %e, "direct-session transcript cleanup failed"),
                    }
                    continue;
                }
                match self.ingest_file(&dir, &file, &target) {
                    Ok((inserted, first_ts)) => {
                        summary.rows_inserted += inserted;
                        if let Some(ts) = first_ts {
                            if earliest.as_deref().is_none_or(|e| ts.as_str() < e) {
                                earliest = Some(ts);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(file = %file.display(), error = %e, "skipping claude transcript");
                    }
                }
            }
            // First time this cwd's transcripts are read: the runs they cover
            // were scraped from the screen until now — those rows are
            // superseded by the exact ones just recorded.
            if first_pass {
                let db = self.db.lock();
                if let Some(since) = &earliest {
                    let removed = db.delete_scraped_run_spend(&scrape_sources, since)?;
                    if removed > 0 {
                        tracing::info!(cwd = %target.cwd, removed, "replaced scraped RUN spend with transcript rows");
                    }
                }
                db.meta_set(&format!("transcript_target_seen:{dir_name}"), "1")?;
            }
        }
        Ok(summary)
    }

    /// Ingest one file: `(rows inserted, earliest timestamp seen)`.
    fn ingest_file(&self, project_dir: &Path, path: &Path, target: &Target) -> AppResult<(usize, Option<String>)> {
        let meta_key = format!("cc_transcript:{}", path.display());
        let offset = self
            .db
            .lock()
            .meta_get(&meta_key)?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if len == offset {
            return Ok((0, None));
        }
        // Parse without the DB lock (a first pass over a long transcript is
        // the slow part); price each distinct model once (`prices_for`
        // reloads the catalog from disk).
        let (entries, consumed) = read_new_entries(path, offset)?;
        let earliest = entries.iter().map(|u| u.ts_utc.clone()).min();
        // Resolve each distinct model's price before taking the DB lock.
        let mut prices: HashMap<String, Option<ModelPrices>> = HashMap::new();
        for u in &entries {
            if !prices.contains_key(&u.model) {
                prices.insert(u.model.clone(), prices_for(&u.model));
            }
        }
        let mut inserted = 0usize;
        let now = chrono::Utc::now();
        let db = self.db.lock();
        // One transaction per file: thousands of historical rows would
        // otherwise each pay a journal sync. A savepoint nests safely.
        db.execute_batch("SAVEPOINT cc_ingest")?;
        let candidates = session_candidates(project_dir, path);
        let mut direct = false;
        let result = (|| -> AppResult<()> {
            // The pass's snapshot of Direct sessions may predate this file's
            // stage reporting its session, and the drive's drop of what was
            // already metered (#863) may have run since. Re-check under this
            // lock: the drive records the session before it drops, so either
            // this sees it and writes nothing (not even the offset), or these
            // rows and the offset land first and the drop removes them (#890).
            if db.any_direct_cli_session(&candidates)? {
                direct = true;
                return Ok(());
            }
            for u in entries {
                let base = *prices.entry(u.model.clone()).or_insert_with(|| prices_for(&u.model));
                // A fast-mode turn costs the fast rate, or is unpriced on a
                // model fast mode doesn't support — never the standard rate.
                let priced = prices_at_speed(&u.model, base, u.speed.as_deref())
                    // One transcript line = one API request: per-request tiers.
                    .map(|p| {
                        crate::token_engine::request_cost_split(
                            &u.model,
                            p,
                            u.input_tokens,
                            u.output_tokens,
                            u.cache_read_tokens,
                            u.cache_creation_tokens,
                            u.cache_creation_1h_tokens,
                        )
                    });
                let cost = priced.unwrap_or(0.0);
                // An unknown model is unpriced, not free.
                let tokens = u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens;
                let cost_basis = if priced.is_none() && tokens > 0 { "unpriced" } else { "computed" };
                let live = chrono::DateTime::parse_from_rfc3339(&u.ts_utc)
                    .map(|t| (now - t.with_timezone(&chrono::Utc)).num_seconds().abs() <= LIVE_WINDOW_SECS)
                    .unwrap_or(false);
                let mission_id = match &target.workspace_id {
                    Some(ws) => db.mission_for_workspace_at(ws, &u.ts_utc)?,
                    None => None,
                };
                let session_id = target.session_ids.first().cloned();
                let source_id = session_id.clone().unwrap_or_else(|| format!("cc:{}", u.session_id));
                let ev = SpendEvent {
                    ts_utc: u.ts_utc.clone(),
                    surface: "run".into(),
                    project_id: target.project_id.clone(),
                    workspace_id: target.workspace_id.clone(),
                    mission_id,
                    source_id: Some(source_id),
                    attempt: 1,
                    model_raw: u.model.clone(),
                    model: u.model.clone(),
                    input_tokens: u.input_tokens as i64,
                    output_tokens: u.output_tokens as i64,
                    cache_read_tokens: u.cache_read_tokens as i64,
                    cache_creation_tokens: u.cache_creation_tokens as i64,
                    provider_cost_usd: None,
                    computed_cost_usd: Some(cost),
                    cost_usd: cost,
                    cost_basis: cost_basis.into(),
                    idempotency_key: Some(u.key.clone()),
                    thread_id: None,
                    origin: None,
                    speed: u.speed.clone(),
                };
                let new_row = db.upsert_spend_event_by_key(&ev)?;
                if let Some(msg) = &u.message_id {
                    db.set_spend_provider_msg_id(&u.key, msg)?;
                }
                if new_row {
                    inserted += 1;
                    // Only a message from the last few minutes says anything
                    // about the session or the mission *now*.
                    if live {
                        if let Some(sid) = &session_id {
                            db.increment_session_tokens(sid, u.input_tokens, u.output_tokens)?;
                        }
                        if let Some(ws) = &target.workspace_id {
                            let _ = db.record_activity(ws, "run", "transcript");
                        }
                    }
                }
            }
            db.meta_set(&meta_key, &consumed.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                db.execute_batch("RELEASE cc_ingest")?;
                Ok(if direct { (0, None) } else { (inserted, earliest) })
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK TO cc_ingest; RELEASE cc_ingest");
                Err(e)
            }
        }
    }
}
