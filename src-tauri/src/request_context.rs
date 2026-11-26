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
    /// Memory files the chain named but never read (a project file pointing
    /// outside the project, a file over 4 MiB), at most [`MAX_LISTED_SKIPS`].
    pub skipped: Vec<SkippedFile>,
    /// Skipped files past those, counted.
    pub more_skipped: usize,
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
/// else in full. Callers pass resolved paths, so the label says where the
/// file really is. A project path that itself begins with `~` (a repo folder
/// named `~`) is written `./~/…`, so it can't pass for a file under home.
fn display_path(path: &Path, project: &Path, home: Option<&Path>) -> String {
    if let Ok(rel) = path.strip_prefix(project) {
        let rel = rel.display().to_string();
        return if rel.starts_with('~') { format!("./{rel}") } else { rel };
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
/// relative to the importing file's directory. Where it is *allowed* to
/// point is [`read_memory_file`]'s call.
fn resolve_import(spec: &str, base: &Path, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(rest) = spec.strip_prefix("~/") {
        return home.map(|h| h.join(rest));
    }
    let p = Path::new(spec);
    Some(if p.is_absolute() { p.to_path_buf() } else { base.join(p) })
}

/// A memory file larger than this is skipped, never read.
pub const MAX_MEMORY_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Why a memory file was named but not read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemorySkip {
    /// A project file (or what it imports, or a symlink's target) resolves
    /// outside the project.
    OutsideProject,
    /// Over [`MAX_MEMORY_FILE_BYTES`].
    TooLarge,
}

impl MemorySkip {
    /// What the Companion says after "skipped:".
    pub fn as_str(&self) -> &'static str {
        match self {
            MemorySkip::OutsideProject => "outside the project",
            MemorySkip::TooLarge => "over 4 MiB",
        }
    }
}

/// Read one memory file the way every caller must. The path is resolved,
/// symlinks included; with `root` (a canonical, untrusted dir) a target
/// outside it is refused, so a repo's `CLAUDE.md` can't pull in `~/…`,
/// `../…` or an absolute path, or be a symlink to one. The resolved path is
/// opened first, non-blocking and without following a link swapped in since,
/// and the open handle must be a regular file (`fstat`), so a FIFO or device
/// put there can't hang the turn. Never more than [`MAX_MEMORY_FILE_BYTES`]
/// is read. `Ok(None)` when there is no regular file there.
pub fn read_memory_file(path: &Path, root: Option<&Path>) -> Result<Option<(PathBuf, Vec<u8>)>, MemorySkip> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let Ok(real) = std::fs::canonicalize(path) else { return Ok(None) };
    if root.is_some_and(|r| !real.starts_with(r)) {
        return Err(MemorySkip::OutsideProject);
    }
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(&real)
    else {
        return Ok(None);
    };
    let Ok(meta) = file.metadata() else { return Ok(None) };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_MEMORY_FILE_BYTES {
        return Err(MemorySkip::TooLarge);
    }
    let mut raw = Vec::new();
    if file.take(MAX_MEMORY_FILE_BYTES + 1).read_to_end(&mut raw).is_err() {
        return Ok(None);
    }
    if raw.len() as u64 > MAX_MEMORY_FILE_BYTES {
        return Err(MemorySkip::TooLarge);
    }
    Ok(Some((real, raw)))
}

/// One file of the chain, read once: [`memory_files`] counts it and
/// `project_instructions` sends its text.
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryFile {
    /// The path as the user knows it ([`display_path`]).
    pub label: String,
    /// The path as the chain named it.
    pub path: PathBuf,
    /// Where it resolved (symlinks followed); `None` when skipped.
    pub real: Option<PathBuf>,
    /// The file's text (lossy UTF-8); empty when skipped.
    pub text: String,
    /// Bytes read; 0 when skipped.
    pub bytes: u64,
    /// Named but not read, and why.
    pub skipped: Option<MemorySkip>,
}

/// Whose file it is, which decides where it may point. The repository is
/// the untrusted part: every directory from the project up to the outermost
/// git work tree that encloses it, and every file that resolves inside that
/// tree, is the project's, and may point only inside it. The user's files
/// (`~/.claude/CLAUDE.md`, the files of the directories above every
/// enclosing work tree, and what they import) may point anywhere.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Trust {
    User,
    Project,
}

/// How many skipped files a chain lists by name; the rest are counted.
pub const MAX_LISTED_SKIPS: usize = 20;

/// The chain [`memory_chain`] walked: its files, each read once, and how
/// many skipped files weren't listed past [`MAX_LISTED_SKIPS`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MemoryChain {
    pub files: Vec<MemoryFile>,
    pub more_skipped: usize,
}

/// The untrusted root of a project: the outermost directory at or above its
/// resolved root that holds a `.git` entry (a repo, a worktree, a submodule
/// or the repo enclosing a subfolder), else the project itself.
pub fn untrusted_root(root: &Path) -> PathBuf {
    root.ancestors()
        .filter(|d| d.join(".git").symlink_metadata().is_ok())
        .last()
        .unwrap_or(root)
        .to_path_buf()
}

/// Walks the chain: the paths reached, so a file reached twice is read once.
struct ChainWalk {
    /// The project dir, resolved; labels are relative to it.
    root: Option<PathBuf>,
    /// [`untrusted_root`] of `root`: where the project's files may point.
    untrusted: Option<PathBuf>,
    /// The user's home as given (for `~/` imports) and resolved (for labels).
    home: Option<PathBuf>,
    home_real: Option<PathBuf>,
    seen: HashSet<PathBuf>,
    chain: MemoryChain,
}

impl ChainWalk {
    fn label(&self, path: &Path) -> String {
        let shown = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        match &self.root {
            Some(root) => display_path(&shown, root, self.home_real.as_deref()),
            None => shown.display().to_string(),
        }
    }

    /// Add the memory file at `path` (when it is one not yet reached) and,
    /// up to [`MAX_IMPORT_DEPTH`], the files it imports.
    fn add(&mut self, path: &Path, trust: Trust, depth: usize) {
        // Already read by another route (an import of an ancestor's file, say).
        if std::fs::canonicalize(path).is_ok_and(|r| self.seen.contains(&r)) {
            return;
        }
        let limit = match trust {
            Trust::User => None,
            Trust::Project => match &self.untrusted {
                Some(r) => Some(r.clone()),
                None => return,
            },
        };
        let (real, raw) = match read_memory_file(path, limit.as_deref()) {
            Ok(Some(found)) => found,
            Ok(None) => return,
            Err(skip) => {
                if self.seen.insert(path.to_path_buf()) {
                    if self.chain.files.iter().filter(|f| f.skipped.is_some()).count() < MAX_LISTED_SKIPS {
                        let label = self.label(path);
                        self.chain.files.push(MemoryFile { label, path: path.to_path_buf(), real: None, text: String::new(), bytes: 0, skipped: Some(skip) });
                    } else {
                        self.chain.more_skipped += 1;
                    }
                }
                return;
            }
        };
        if !self.seen.insert(real.clone()) {
            return;
        }
        // A file inside the untrusted tree is the project's, whoever imported
        // it or linked to it: an ancestor's file that resolves into the
        // project can't let a project file's imports out.
        let trust = if self.untrusted.as_deref().is_some_and(|r| real.starts_with(r)) { Trust::Project } else { trust };
        let text = String::from_utf8_lossy(&raw).into_owned();
        let imports = if depth < MAX_IMPORT_DEPTH { memory_imports(&text) } else { Vec::new() };
        let label = self.label(&real);
        self.chain.files.push(MemoryFile { label, path: path.to_path_buf(), real: Some(real), bytes: raw.len() as u64, text, skipped: None });
        let base = path.parent().map(Path::to_path_buf).unwrap_or_default();
        for spec in imports {
            if let Some(target) = resolve_import(&spec, &base, self.home.as_deref()) {
                self.add(&target, trust, depth + 1);
            }
        }
    }
}

/// The CLAUDE.md chain of `project`, each file read once: the user's
/// `~/.claude/CLAUDE.md`, then from the top directory down to the project's
/// resolved root each one's `CLAUDE.md`, `.claude/CLAUDE.md` and
/// `CLAUDE.local.md`, each followed by what it imports (an `AGENTS.md` counts
/// only when imported). The directories from the project up to the
/// outermost git work tree enclosing it ([`untrusted_root`]) are the
/// repository's: their files, and anything that resolves into that tree,
/// are read only when they resolve inside it, so an import of `~/…`, `../…`
/// or an absolute path, or a symlink out of it, is listed as skipped
/// ([`MemorySkip::OutsideProject`]) and never read. The user's own file and
/// the directories above every enclosing work tree are the user's, and their
/// imports may point anywhere. Every file is size-capped
/// ([`read_memory_file`]); skipped files past [`MAX_LISTED_SKIPS`] are
/// counted, not listed.
pub fn memory_chain(project: &Path, home: Option<&Path>) -> MemoryChain {
    let root = std::fs::canonicalize(project).ok();
    let mut walk = ChainWalk {
        untrusted: root.as_deref().map(untrusted_root),
        root: root.clone(),
        home: home.map(Path::to_path_buf),
        home_real: home.map(|h| std::fs::canonicalize(h).unwrap_or_else(|_| h.to_path_buf())),
        seen: HashSet::new(),
        chain: MemoryChain::default(),
    };
    if let Some(h) = home {
        walk.add(&h.join(".claude").join("CLAUDE.md"), Trust::User, 0);
    }
    let (Some(root), Some(untrusted)) = (root, walk.untrusted.clone()) else { return walk.chain };
    // Every ancestor of the resolved root but the filesystem root, top down.
    let mut dirs: Vec<&Path> = root.ancestors().filter(|d| d.parent().is_some()).collect();
    dirs.reverse();
    for dir in dirs {
        let trust = if dir.starts_with(&untrusted) { Trust::Project } else { Trust::User };
        for name in ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"] {
            walk.add(&dir.join(name), trust, 0);
        }
    }
    walk.chain
}

/// The files of a chain that were read, as request items.
fn read_items(chain: &MemoryChain) -> Vec<CarriedItem> {
    chain
        .files
        .iter()
        .filter(|f| f.skipped.is_none())
        .cloned()
        .map(|f| CarriedItem {
            kind: "memory".into(),
            label: f.label,
            path: Some(f.real.unwrap_or(f.path).display().to_string()),
            count: 1,
            bytes: f.bytes,
            tokens: 0,
        })
        .collect()
}

/// The files of [`memory_chain`] that were read, as request items.
pub fn memory_files(project: &Path, home: Option<&Path>) -> Vec<CarriedItem> {
    read_items(&memory_chain(project, home))
}

/// A memory file the chain named but didn't read (`get_request_context`).
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    /// As [`CarriedItem::label`].
    pub label: String,
    /// The path as the chain named it.
    pub path: String,
    /// `outside the project` or `over 4 MiB`.
    pub reason: String,
}

/// The skipped files of a chain, as `get_request_context` lists them.
fn skipped_files(chain: &MemoryChain) -> Vec<SkippedFile> {
    chain
        .files
        .iter()
        .filter_map(|f| {
            f.skipped.map(|why| SkippedFile {
                label: f.label.clone(),
                path: f.path.display().to_string(),
                reason: why.as_str().to_string(),
            })
        })
        .collect()
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

    let chain = memory_chain(project, home);
    let mut items = read_items(&chain);
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
        skipped: skipped_files(&chain),
        more_skipped: chain.more_skipped,
    }
}
