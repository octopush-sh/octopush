//! The project's instructions for Talk: the `CLAUDE.md` chain Claude Code
//! loads in a workspace, or the workspace's `AGENTS.md` when it has no
//! `CLAUDE.md` of its own. The director and every sub-agent carry the same
//! section in their system prompt, so a rule a user wrote for Claude Code
//! (test commands, style, "never do X") applies in Talk too.
//!
//! - **The chain is Claude Code's.** [`request_context::memory_files`]
//!   resolves it: `~/.claude/CLAUDE.md`, then from the top directory down to
//!   the workspace each one's `CLAUDE.md`, `.claude/CLAUDE.md` and
//!   `CLAUDE.local.md`, each followed by the files it `@imports`.
//! - **`AGENTS.md` is the fallback.** Claude Code doesn't read it on its own,
//!   and a project that keeps both usually mirrors one into the other (often
//!   with a line changed, so a content dedupe misses it). So the workspace's
//!   `AGENTS.md` and `CONVENTIONS.md` (the files Direct's API stages read,
//!   `runner::repo_conventions_section`) are added only when the workspace
//!   has no `CLAUDE.md` or `.claude/CLAUDE.md`, or when the chain imports one.
//! - **Bounded.** Each file is capped like a Direct dossier section
//!   ([`SECTION_CAP_CHARS`], head and tail kept) and the whole section at
//!   [`INSTRUCTIONS_CAP_CHARS`]; a file identical to one already included is
//!   left out.
//! - **Cache-stable.** The section depends on nothing but the files, so it
//!   is the same text every turn until a file changes. It sits right after
//!   the base prompt, before anything that varies per turn.
//!
//! Read-only: nothing here writes a file, and the text goes only to the
//! provider the conversation already uses.

use crate::orchestrator::runner::{cap_to, SECTION_CAP_CHARS};
use crate::request_context::{estimate_tokens, memory_files};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Cap (chars) on the whole section: Claude Code's own warning threshold for
/// a large `CLAUDE.md` (about 10k tokens), so a runaway file can't crowd out
/// the conversation.
pub const INSTRUCTIONS_CAP_CHARS: usize = 40_000;

/// Read from the workspace root when it has no `CLAUDE.md` of its own, in
/// this order (Direct's API stages read the same names).
const FALLBACK_FILES: &[&str] = &["AGENTS.md", "CONVENTIONS.md"];

/// One instruction file, as the Companion lists it.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFile {
    /// The path as the user knows it: relative to the workspace, `~/…` under
    /// home, else in full.
    pub label: String,
    /// The file's full path.
    pub path: String,
    /// Estimated tokens of the text sent (0 when it was left out).
    pub tokens: u64,
    /// The file wasn't sent whole: trimmed to fit a cap, or (with 0 tokens)
    /// left out because the section was already full.
    pub trimmed: bool,
}

/// What [`load`] answers: the files and the system-prompt section built
/// from them (empty when there is none).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectInstructions {
    pub files: Vec<InstructionFile>,
    pub section: String,
}

/// The canonical form of `path`, for comparing files reached two ways.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Every file the workspace's instructions come from, in load order, as
/// `(label, path)`: the `CLAUDE.md` chain, then the fallback files when the
/// workspace has no `CLAUDE.md` of its own.
fn instruction_paths(workspace: &Path, home: Option<&Path>) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = memory_files(workspace, home)
        .into_iter()
        .filter_map(|item| item.path.map(|p| (item.label, PathBuf::from(p))))
        .collect();
    let has_own = ["CLAUDE.md", ".claude/CLAUDE.md"].iter().any(|n| workspace.join(n).is_file());
    if !has_own {
        let seen: HashSet<PathBuf> = out.iter().map(|(_, p)| canonical(p)).collect();
        for name in FALLBACK_FILES {
            let path = workspace.join(name);
            if path.is_file() && !seen.contains(&canonical(&path)) {
                out.push((name.to_string(), path));
            }
        }
    }
    out
}

/// The workspace's instructions: the files and the section for the system
/// prompt. `home` is the user's home (`None` skips `~/.claude/CLAUDE.md`).
/// A missing or unreadable file is skipped; with none, both are empty.
pub fn load(workspace: &Path, home: Option<&Path>) -> ProjectInstructions {
    let mut files = Vec::new();
    let mut bodies: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut budget = INSTRUCTIONS_CAP_CHARS;
    for (label, path) in instruction_paths(workspace, home) {
        let Ok(raw) = std::fs::read(&path) else { continue };
        let text = String::from_utf8_lossy(&raw);
        let trimmed = text.trim();
        if trimmed.is_empty() || seen.iter().any(|s| s == trimmed) {
            continue;
        }
        seen.push(trimmed.to_string());
        let cap = SECTION_CAP_CHARS.min(budget);
        // Less than a useful slice left: name the file, send none of it.
        let body = if cap < 1_000 { String::new() } else { cap_to(trimmed, cap) };
        budget = budget.saturating_sub(body.len());
        files.push(InstructionFile {
            label: label.clone(),
            path: path.display().to_string(),
            tokens: estimate_tokens(body.len() as u64),
            trimmed: body.is_empty() || trimmed.len() > cap,
        });
        if !body.is_empty() {
            bodies.push(format!("Contents of {label}:\n\n{body}"));
        }
    }
    if bodies.is_empty() {
        return ProjectInstructions { files, section: String::new() };
    }
    let mut section = String::from(
        "\n\n# Project instructions\n\nThe project's own instruction files follow (the ones Claude Code \
         loads in this workspace). Follow them while you work here: they take precedence over the \
         general guidance above, and a later file over an earlier one.",
    );
    for body in &bodies {
        section.push_str("\n\n");
        section.push_str(body);
    }
    let left_out: Vec<&str> = files.iter().filter(|f| f.tokens == 0).map(|f| f.label.as_str()).collect();
    if !left_out.is_empty() {
        section.push_str(&format!("\n\n(Left out for length: {}.)", left_out.join(", ")));
    }
    ProjectInstructions { files, section }
}

/// [`load`] with the user's real home: what a Talk turn and its sub-agents use.
pub fn for_workspace(workspace: &Path) -> ProjectInstructions {
    load(workspace, dirs::home_dir().as_deref())
}
