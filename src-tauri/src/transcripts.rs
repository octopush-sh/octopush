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
//! - Every billed message is keyed `cc:<claude session>:<request id>` in the
//!   ledger's `idempotency_key`; several transcript lines for one message
//!   (one per content block) collapse to one row, and a re-read (offset
//!   reset after a file was truncated) can't double-count.
//! - Once a transcript has been seen for an Octopush session, that session's
//!   PTY scraping is switched off (`transcript_seen:<session>`), so the two
//!   paths never both count the same run.

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

/// One ledger-ready message pulled from a transcript line.
#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptUsage {
    /// Claude Code's own session id (the file stem).
    pub session_id: String,
    /// `requestId`, else the message id — one per billed API call.
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
    let key = v
        .get("requestId")
        .and_then(|r| r.as_str())
        .or_else(|| message.get("id").and_then(|i| i.as_str()))
        .filter(|k| !k.is_empty())?
        .to_string();
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
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        if !line.ends_with('\n') {
            break; // partial trailing line: not consumed
        }
        consumed += n as u64;
        if let Some(u) = parse_transcript_line(&line, &file_session) {
            let k = format!("{}:{}", u.session_id, u.key);
            match index.get(&k) {
                Some(&i) => order[i] = u,
                None => {
                    index.insert(k, order.len());
                    order.push(u);
                }
            }
        }
    }
    Ok((order, consumed))
}

/// Where a transcript's spend is attributed.
#[derive(Clone, Debug)]
struct Target {
    /// An Octopush RUN session with this cwd as its project root, if any.
    session_id: Option<String>,
    workspace_id: Option<String>,
    project_id: Option<String>,
}

fn jsonl_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
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
        let root = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".claude")
            .join("projects");
        Self::with_root(db, root)
    }

    pub fn with_root(db: Arc<Mutex<Db>>, root: PathBuf) -> Self {
        Self {
            db,
            root,
            last_run: Mutex::new(None),
        }
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

    /// One full pass over every transcript that belongs to an Octopush
    /// session or workspace.
    pub fn ingest(&self) -> AppResult<IngestSummary> {
        let mut summary = IngestSummary::default();
        if !self.root.is_dir() {
            return Ok(summary);
        }
        // Attribution map: Claude Code project dir → where the spend goes.
        let mut targets: HashMap<String, Target> = HashMap::new();
        {
            let db = self.db.lock();
            for (id, project_id, path) in db.list_workspace_paths()? {
                targets.insert(
                    project_dir_name(&path),
                    Target {
                        session_id: None,
                        workspace_id: Some(id),
                        project_id: Some(project_id),
                    },
                );
            }
            // Sessions are listed most-recently-active first; the first one
            // per root wins, so spend follows the session the user is in.
            for s in db.list_sessions()? {
                let key = project_dir_name(&s.project_root);
                let entry = targets.entry(key).or_insert(Target {
                    session_id: None,
                    workspace_id: None,
                    project_id: None,
                });
                if entry.session_id.is_none() {
                    entry.session_id = Some(s.id.clone());
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
        for (dir_name, target) in &targets {
            let dir = self.root.join(dir_name);
            if !dir.is_dir() {
                continue;
            }
            let mut files = Vec::new();
            jsonl_files(&dir, 0, &mut files);
            for file in files {
                summary.files_scanned += 1;
                summary.rows_inserted += self.ingest_file(&file, target)?;
            }
        }
        Ok(summary)
    }

    fn ingest_file(&self, path: &Path, target: &Target) -> AppResult<usize> {
        let meta_key = format!("cc_transcript:{}", path.display());
        let offset = self
            .db
            .lock()
            .meta_get(&meta_key)?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if len == offset {
            return Ok(0);
        }
        // Parse without the DB lock (a first pass over a long transcript is
        // the slow part); price each distinct model once (`prices_for`
        // reloads the catalog from disk).
        let (entries, consumed) = read_new_entries(path, offset)?;
        let mut prices: HashMap<String, Option<ModelPrices>> = HashMap::new();
        let mut inserted = 0usize;
        let db = self.db.lock();
        if let Some(sid) = &target.session_id {
            // From now on this session is metered from its transcript, not
            // from its screen — the PTY scanner checks this flag.
            db.meta_set(&format!("transcript_seen:{sid}"), "1")?;
        }
        // One transaction per file: thousands of historical rows would
        // otherwise each pay a journal sync. A savepoint nests safely.
        db.conn_ref().execute_batch("SAVEPOINT cc_ingest")?;
        let result = (|| -> AppResult<()> {
            for u in entries {
                let cost = prices
                    .entry(u.model.clone())
                    .or_insert_with(|| prices_for(&u.model))
                    .as_ref()
                    .map(|p| {
                        p.cost(
                            u.input_tokens,
                            u.output_tokens,
                            u.cache_read_tokens,
                            u.cache_creation_tokens,
                        )
                    })
                    .unwrap_or(0.0);
                let mission_id = match &target.workspace_id {
                    Some(ws) => db.active_mission_for_workspace(ws)?.map(|m| m.id),
                    None => None,
                };
                let source_id = target
                    .session_id
                    .clone()
                    .unwrap_or_else(|| format!("cc:{}", u.session_id));
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
                    idempotency_key: Some(format!("cc:{}:{}", u.session_id, u.key)),
                };
                if db.insert_spend_event_if_new(&ev)? {
                    inserted += 1;
                    if let Some(sid) = &target.session_id {
                        db.increment_session_tokens(sid, u.input_tokens, u.output_tokens)?;
                    }
                    if let Some(ws) = &target.workspace_id {
                        let _ = db.record_activity(ws, "run", "transcript");
                    }
                }
            }
            db.meta_set(&meta_key, &consumed.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                db.conn_ref().execute_batch("RELEASE cc_ingest")?;
                Ok(inserted)
            }
            Err(e) => {
                let _ = db
                    .conn_ref()
                    .execute_batch("ROLLBACK TO cc_ingest; RELEASE cc_ingest");
                Err(e)
            }
        }
    }
}
