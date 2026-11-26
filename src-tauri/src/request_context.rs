//! What every request carries (#959): the fixed context a project sends on
//! every Claude Code request, measured from its transcripts and split into
//! the files that make it up. Read-only: nothing here edits a file, starts
//! an MCP server or leaves the Mac.
//!
//! - **The total is measured.** A session's first main-thread request
//!   carries the fixed context (system prompt, tool schemas, the CLAUDE.md
//!   chain, skill and agent listings) plus the user's first message. The
//!   smallest such prompt — input + cache read + cache write — over the
//!   project's [`MAX_SESSIONS`] most recent sessions is the closest measured
//!   figure for the fixed part (an upper bound: it still holds one short
//!   message). Direct stages' own CLI sessions are left out: their appended
//!   role prompt and brief differ per stage.
//! - **The items are estimates.** No tokenizer and no `count_tokens` call:
//!   each file is bytes ÷ 4 ([`estimate_tokens`]), scaled down when the
//!   estimates exceed the measured total, and what's left of the total is
//!   "MCP and built-in tools, by difference" ([`apportion`]). MCP servers
//!   are never contacted for this view.
//! - **Priced at the project's usual model and cache rate.** The model of
//!   most first requests, and the input-side rate (input, cache reads,
//!   cache writes) that model's standard-speed requests in the sampled
//!   sessions actually paid per prompt token.

use crate::token_engine::{prices_for, request_cost_split, request_prices};
use crate::transcripts::{parse_transcript_line, project_dirs_for, read_new_entries, TranscriptUsage};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// How many of a project's most recent sessions are read.
pub const MAX_SESSIONS: usize = 20;
/// How deep `@path` imports are followed from a CLAUDE.md (Claude Code's own limit).
const MAX_IMPORT_DEPTH: usize = 5;

/// One thing the project's requests carry, ranked by [`RequestContext::items`].
/// Every item's `tokens` is an estimate (see the module docs).
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CarriedItem {
    /// `memory` (a file of the CLAUDE.md chain, or one it imports), `skills`
    /// (the name and description of every skill), `agents` (the same of
    /// every agent definition) or `by_difference` (the measured total minus
    /// every other item: MCP tool schemas, Claude Code's built-in tools and
    /// system prompt).
    pub kind: String,
    /// What the row says: a path as the user knows it (`CLAUDE.md`,
    /// `~/.claude/CLAUDE.md`), `Skills`, `Agents`, or
    /// `MCP and built-in tools, by difference`.
    pub label: String,
    /// The file's full path, for a `memory` item.
    pub path: Option<String>,
    /// Skills or agents counted; 1 for a file, 0 for `by_difference`.
    pub count: usize,
    /// Bytes read from disk; 0 for `by_difference`.
    pub bytes: u64,
    /// Estimated tokens, scaled to the measured total when there is one.
    pub tokens: u64,
}

/// What `get_request_context` answers for one project.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    /// The measured fixed context: the smallest first-request prompt of the
    /// sampled sessions. `None` with no transcript to read.
    pub measured_tokens: Option<u64>,
    /// Sessions whose first request was read.
    pub sessions_measured: usize,
    /// The project's usual model: the model of most first requests.
    pub model: Option<String>,
    /// The sampled sessions' share of prompt tokens read from the cache, 0–100.
    pub cache_hit_pct: Option<f64>,
    /// `measured_tokens` at the usual model's input price: one request that
    /// reads nothing from the cache. `None` when the model is unpriced.
    pub uncached_usd: Option<f64>,
    /// `measured_tokens` at the input-side rate the usual model's requests
    /// actually paid in the sampled sessions. `None` when unpriced.
    pub usual_usd: Option<f64>,
    /// Ranked, largest first; they add up to `measured_tokens` when it is known.
    pub items: Vec<CarriedItem>,
}

/// The token estimate of `bytes` of text: one token per 4 bytes, rounded up.
pub fn estimate_tokens(bytes: u64) -> u64 {
    bytes.div_ceil(4)
}

/// Give every item its estimate and fit them to the `measured` total: when
/// the estimates exceed it they are scaled down to add up to it exactly;
/// otherwise what's left is one `by_difference` item. With no measured
/// total the raw estimates stand. Items of 0 tokens are dropped; the rest
/// are ranked largest first (ties by label).
pub fn apportion(mut items: Vec<CarriedItem>, measured: Option<u64>) -> Vec<CarriedItem> {
    for item in &mut items {
        item.tokens = estimate_tokens(item.bytes);
    }
    if let Some(total) = measured {
        let estimated: u64 = items.iter().map(|i| i.tokens).sum();
        if estimated > total {
            let mut assigned = 0u64;
            for item in &mut items {
                item.tokens = (item.tokens as u128 * total as u128 / estimated as u128) as u64;
                assigned += item.tokens;
            }
            // Flooring leaves less than one token per item: the largest takes it.
            if let Some(largest) = items.iter_mut().max_by_key(|i| i.tokens) {
                largest.tokens += total - assigned;
            }
        } else {
            items.push(CarriedItem {
                kind: "by_difference".into(),
                label: "MCP and built-in tools, by difference".into(),
                path: None,
                count: 0,
                bytes: 0,
                tokens: total - estimated,
            });
        }
    }
    items.retain(|i| i.tokens > 0);
    items.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.label.cmp(&b.label)));
    items
}

// ─── The files ────────────────────────────────────────────────────

/// `path` as the user knows it: relative to the project, `~/…` under home,
/// else in full.
fn display_path(path: &Path, project: &Path, home: Option<&Path>) -> String {
    if let Ok(rel) = path.strip_prefix(project) {
        return rel.display().to_string();
    }
    if let Some(rest) = home.and_then(|h| path.strip_prefix(h).ok()) {
        return format!("~/{}", rest.display());
    }
    path.display().to_string()
}

/// The `@path` imports of a CLAUDE.md, outside fenced code blocks, in order.
/// Trailing punctuation is not part of the path.
pub fn memory_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        for word in line.split_whitespace() {
            let Some(p) = word.strip_prefix('@') else { continue };
            let p = p.trim_end_matches(['.', ',', ';', ':', ')']);
            if !p.is_empty() && !out.iter().any(|o| o == p) {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// Where an import points: `~/…` under home, an absolute path, else
/// relative to the importing file's directory.
fn resolve_import(spec: &str, base: &Path, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(rest) = spec.strip_prefix("~/") {
        return home.map(|h| h.join(rest));
    }
    let p = Path::new(spec);
    Some(if p.is_absolute() { p.to_path_buf() } else { base.join(p) })
}

/// Add the memory file at `path` (when it is a file not yet counted) and,
/// up to [`MAX_IMPORT_DEPTH`], the files it imports.
fn add_memory(
    path: &Path,
    project: &Path,
    home: Option<&Path>,
    depth: usize,
    seen: &mut HashSet<PathBuf>,
    out: &mut Vec<CarriedItem>,
) {
    if !path.is_file() {
        return;
    }
    let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !seen.insert(key) {
        return;
    }
    let Ok(raw) = std::fs::read(path) else { return };
    out.push(CarriedItem {
        kind: "memory".into(),
        label: display_path(path, project, home),
        path: Some(path.display().to_string()),
        count: 1,
        bytes: raw.len() as u64,
        tokens: 0,
    });
    if depth >= MAX_IMPORT_DEPTH {
        return;
    }
    let base = path.parent().unwrap_or(project).to_path_buf();
    for spec in memory_imports(&String::from_utf8_lossy(&raw)) {
        if let Some(target) = resolve_import(&spec, &base, home) {
            add_memory(&target, project, home, depth + 1, seen, out);
        }
    }
}

/// The CLAUDE.md chain Claude Code loads in `project`: the user's
/// `~/.claude/CLAUDE.md`, then from the top directory down to `project`
/// each one's `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`, each
/// followed by what it imports. An `AGENTS.md` counts only when imported
/// (Claude Code doesn't read it on its own).
pub fn memory_files(project: &Path, home: Option<&Path>) -> Vec<CarriedItem> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    if let Some(h) = home {
        add_memory(&h.join(".claude").join("CLAUDE.md"), project, home, 0, &mut seen, &mut out);
    }
    // Every ancestor but the filesystem root, top down.
    let mut dirs: Vec<&Path> = project.ancestors().filter(|d| d.parent().is_some()).collect();
    dirs.reverse();
    for dir in dirs {
        for name in ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"] {
            add_memory(&dir.join(name), project, home, 0, &mut seen, &mut out);
        }
    }
    out
}

/// The project's skills then the user's (a project skill shadows a user
/// skill of the same name): Claude Code lists each one's name and
/// description in context, never its body. `None` when there is none.
pub fn skills_item(project: &Path, home: Option<&Path>) -> Option<CarriedItem> {
    let mut roots = vec![project.join(".claude").join("skills")];
    roots.extend(home.map(|h| h.join(".claude").join("skills")));
    let mut names: Vec<String> = Vec::new();
    let mut bytes = 0u64;
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let Ok(content) = std::fs::read_to_string(dir.join("SKILL.md")) else { continue };
            let Some(skill) = crate::skills::parse_skill(&content, "") else { continue };
            if names.contains(&skill.name) {
                continue;
            }
            bytes += (skill.name.len() + skill.description.len()) as u64;
            names.push(skill.name);
        }
    }
    (!names.is_empty()).then(|| CarriedItem {
        kind: "skills".into(),
        label: "Skills".into(),
        path: None,
        count: names.len(),
        bytes,
        tokens: 0,
    })
}

/// The project's agent definitions then the user's (project shadows user):
/// Claude Code lists each one's name and description in its Task tool.
/// `None` when there is none.
pub fn agents_item(project: &Path, home: Option<&Path>) -> Option<CarriedItem> {
    let mut roots = vec![project.join(".claude").join("agents")];
    roots.extend(home.map(|h| h.join(".claude").join("agents")));
    let mut names: Vec<String> = Vec::new();
    let mut bytes = 0u64;
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "md").unwrap_or(false))
            .collect();
        files.sort();
        for file in files {
            let Ok(content) = std::fs::read_to_string(&file) else { continue };
            let Some(def) = crate::skills::agents::parse_agent_definition(&content, "") else { continue };
            if names.contains(&def.name) {
                continue;
            }
            bytes += (def.name.len() + def.description.len()) as u64;
            names.push(def.name);
        }
    }
    (!names.is_empty()).then(|| CarriedItem {
        kind: "agents".into(),
        label: "Agents".into(),
        path: None,
        count: names.len(),
        bytes,
        tokens: 0,
    })
}

// ─── The transcripts ──────────────────────────────────────────────

/// The session transcripts (`<session>.jsonl` directly in a project
/// directory, never a sub-agent's) written from any of `cwds` under
/// `root`, newest first, at most [`MAX_SESSIONS`]. Sessions in `direct`
/// (Direct stages' CLI sessions) are left out.
pub fn session_files(root: &Path, cwds: &[String], direct: &HashSet<String>) -> Vec<PathBuf> {
    let mut dirs: Vec<String> = Vec::new();
    for cwd in cwds {
        let mut names = project_dirs_for(root, cwd);
        if let Ok(c) = std::fs::canonicalize(cwd) {
            names.extend(project_dirs_for(root, &c.to_string_lossy()));
        }
        for n in names {
            if !dirs.contains(&n) {
                dirs.push(n);
            }
        }
    }
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for d in dirs {
        let Ok(entries) = std::fs::read_dir(root.join(&d)) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() || p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if p.file_stem().and_then(|s| s.to_str()).is_some_and(|s| direct.contains(s)) {
                continue;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            files.push((modified, p));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    files.into_iter().take(MAX_SESSIONS).map(|(_, p)| p).collect()
}

/// The first main-thread request of a transcript: its first `assistant`
/// line with usage that isn't a sub-agent's (`isSidechain`) and has a
/// prompt. Reads only as far as that line.
pub fn first_request(path: &Path) -> Option<TranscriptUsage> {
    let stem = path.file_stem()?.to_str()?.to_string();
    let mut reader = BufReader::new(std::fs::File::open(path).ok()?);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        if !buf.windows(11).any(|w| w == b"\"assistant\"") {
            continue;
        }
        let text = String::from_utf8_lossy(&buf);
        let Some(u) = parse_transcript_line(&text, &stem) else { continue };
        let sidechain = serde_json::from_str::<serde_json::Value>(text.trim())
            .ok()
            .and_then(|v| v.get("isSidechain").and_then(|s| s.as_bool()))
            .unwrap_or(false);
        if sidechain || prompt_tokens(&u) == 0 {
            continue;
        }
        return Some(u);
    }
}

fn prompt_tokens(u: &TranscriptUsage) -> u64 {
    u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens
}

/// The model of most `firsts`; on a tie, the one of the newest request.
fn usual_model(firsts: &[TranscriptUsage]) -> Option<String> {
    let mut counts: HashMap<&str, (usize, &str)> = HashMap::new();
    for u in firsts {
        let e = counts.entry(u.model.as_str()).or_insert((0, u.ts_utc.as_str()));
        e.0 += 1;
        if u.ts_utc.as_str() > e.1 {
            e.1 = u.ts_utc.as_str();
        }
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1 .0.cmp(&b.1 .0).then_with(|| a.1 .1.cmp(b.1 .1)))
        .map(|(m, _)| m.to_string())
}

/// [`RequestContext`] of the project at `project`, whose sessions ran in
/// `cwds` (its root and its workspaces' worktrees), from the transcripts
/// under `root` and the files under `project` and `home`.
pub fn request_context(
    root: &Path,
    home: Option<&Path>,
    project: &Path,
    cwds: &[String],
    direct: &HashSet<String>,
) -> RequestContext {
    let files = session_files(root, cwds, direct);
    let firsts: Vec<TranscriptUsage> = files.iter().filter_map(|f| first_request(f)).collect();
    let measured_tokens = firsts.iter().map(prompt_tokens).min();
    let model = usual_model(&firsts);

    // The cache share of every request in the sampled sessions, and the
    // input-side cost per prompt token of the usual model's.
    let (mut input, mut cache_read, mut cache_write) = (0i64, 0i64, 0i64);
    let (mut paid, mut paid_tokens) = (0f64, 0u64);
    let base = model.as_deref().and_then(prices_for);
    for f in &files {
        let Ok((entries, _)) = read_new_entries(f, 0) else { continue };
        for u in entries {
            input += u.input_tokens as i64;
            cache_read += u.cache_read_tokens as i64;
            cache_write += u.cache_creation_tokens as i64;
            if let (Some(m), Some(p)) = (model.as_deref(), base) {
                if u.model == m && u.speed.as_deref() != Some("fast") {
                    paid += request_cost_split(m, p, u.input_tokens, 0, u.cache_read_tokens, u.cache_creation_tokens, u.cache_creation_1h_tokens);
                    paid_tokens += prompt_tokens(&u);
                }
            }
        }
    }
    let (cache_hit_pct, _) = crate::db::cache_hit_pct(input, cache_read, cache_write);

    let (uncached_usd, usual_usd) = match (measured_tokens, model.as_deref(), base) {
        (Some(t), Some(m), Some(p)) => {
            let uncached = request_prices(m, p, t).input_per_m * t as f64 / 1_000_000.0;
            let usual = (paid_tokens > 0).then(|| paid / paid_tokens as f64 * t as f64);
            (Some(uncached), usual)
        }
        _ => (None, None),
    };

    let mut items = memory_files(project, home);
    items.extend(skills_item(project, home));
    items.extend(agents_item(project, home));
    RequestContext {
        measured_tokens,
        sessions_measured: firsts.len(),
        model,
        cache_hit_pct,
        uncached_usd,
        usual_usd,
        items: apportion(items, measured_tokens),
    }
}
