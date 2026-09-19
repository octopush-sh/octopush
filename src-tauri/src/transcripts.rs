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
//! `output_tokens`). That is the same data an API provider returns, so the
//! ingestor reads it and records RUN spend with the real model and the real
//! cache split — one ledger row per API message.
//!
//! Mechanics:
//! - Only project directories that correspond to an Octopush RUN session's
//!   `project_root` or a workspace's worktree path are read; Claude Code use
//!   elsewhere on the machine is not Octopush spend.
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
//! - Side effects that describe *now* (a session's live counters, the
//!   Logbook activity span) fire only for messages minutes old; historical
//!   rows are attributed to the mission that existed at their timestamp.

use crate::db::{Db, SpendEvent};
use crate::error::AppResult;
use crate::token_engine::{prices_for, ModelPrices};
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

/// Whether Claude Code has a transcript directory for `cwd` (created the
/// moment `claude` first runs there). Checked by the PTY scanner before it
/// records a screen-scraped summary.
pub fn has_transcript_dir(cwd: &str) -> bool {
    let root = projects_root();
    root.join(project_dir_name(cwd)).is_dir()
        || std::fs::canonicalize(cwd)
            .ok()
            .map(|c| root.join(project_dir_name(&c.to_string_lossy())).is_dir())
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
    /// RFC3339 UTC.
    pub ts_utc: String,
    pub cwd: Option<String>,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

/// What one ingestion pass did — for logs and tests.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct IngestSummary {
    pub files_scanned: usize,
    pub rows_inserted: usize,
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
    let key = match v.get("requestId").and_then(|r| r.as_str()).filter(|k| !k.is_empty()) {
        Some(req) => format!("cc:{req}"),
        None => format!("cc:msg:{}", message.get("id").and_then(|i| i.as_str()).filter(|k| !k.is_empty())?),
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
        ts_utc,
        cwd,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
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
    /// the physical cwd, so a symlinked root would otherwise never match).
    fn targets(&self) -> AppResult<HashMap<String, Target>> {
        let mut targets: HashMap<String, Target> = HashMap::new();
        let keys_for = |path: &str| -> Vec<String> {
            let mut keys = vec![project_dir_name(path)];
            if let Ok(c) = std::fs::canonicalize(path) {
                let k = project_dir_name(&c.to_string_lossy());
                if !keys.contains(&k) {
                    keys.push(k);
                }
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
                match self.ingest_file(&file, &target) {
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
    fn ingest_file(&self, path: &Path, target: &Target) -> AppResult<(usize, Option<String>)> {
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
        let mut prices: HashMap<String, Option<ModelPrices>> = HashMap::new();
        let mut inserted = 0usize;
        let now = chrono::Utc::now();
        let db = self.db.lock();
        // One transaction per file: thousands of historical rows would
        // otherwise each pay a journal sync. A savepoint nests safely.
        db.conn_ref().execute_batch("SAVEPOINT cc_ingest")?;
        let result = (|| -> AppResult<()> {
            for u in entries {
                let cost = prices
                    .entry(u.model.clone())
                    .or_insert_with(|| prices_for(&u.model))
                    .as_ref()
                    .map(|p| p.cost(u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens))
                    .unwrap_or(0.0);
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
                    cost_basis: "computed".into(),
                    idempotency_key: Some(u.key.clone()),
                };
                if db.upsert_spend_event_by_key(&ev)? {
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
                db.conn_ref().execute_batch("RELEASE cc_ingest")?;
                Ok((inserted, earliest))
            }
            Err(e) => {
                let _ = db.conn_ref().execute_batch("ROLLBACK TO cc_ingest; RELEASE cc_ingest");
                Err(e)
            }
        }
    }
}
