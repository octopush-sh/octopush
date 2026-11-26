//! The project's instructions for Talk: the `CLAUDE.md` chain Claude Code
//! loads in a workspace, or the workspace's `AGENTS.md` when it has no
//! `CLAUDE.md` of its own. The director and every sub-agent carry the same
//! section in their system prompt, so a rule a user wrote for Claude Code
//! (test commands, style, "never do X") applies in Talk too.
//!
//! - **The chain is Claude Code's, kept to the project.**
//!   [`request_context::memory_chain`] resolves it and reads each file once:
//!   `~/.claude/CLAUDE.md`, then from the top directory down to the
//!   workspace each one's `CLAUDE.md`, `.claude/CLAUDE.md` and
//!   `CLAUDE.local.md`, each followed by the files it `@imports`. Only the
//!   user's own `~/.claude/CLAUDE.md` may point anywhere; every other file,
//!   import or symlink target must resolve inside the workspace, or it is
//!   listed as skipped and never read. A file over 4 MiB is skipped too.
//! - **`AGENTS.md` is the fallback.** A project that keeps both usually
//!   mirrors one into the other (often with a line changed, so a content
//!   dedupe misses it). So the workspace's `AGENTS.md` and `CONVENTIONS.md`
//!   (the files Direct's API stages read, `runner::repo_conventions_section`)
//!   are added only when the workspace has no `CLAUDE.md` or
//!   `.claude/CLAUDE.md`, or when the chain imports one.
//! - **Bounded, in bytes.** Each file is capped at [`SECTION_CAP_CHARS`]
//!   bytes like a Direct dossier section (head and tail kept, plus a short
//!   note), the whole section at [`INSTRUCTIONS_CAP_BYTES`]. The workspace's
//!   own `CLAUDE.md` is budgeted first, so it is never the file left out; a
//!   file that fits what is left is sent whole, however small; a file
//!   identical to one already included is sent once.
//! - **Cache-stable.** The section depends on nothing but the files, so it
//!   is the same text every turn until a file changes. It sits right after
//!   the base prompt, before anything that varies per turn.
//!
//! Read-only: nothing here writes a file, and the text goes only to the
//! provider the conversation already uses.

use crate::orchestrator::runner::{cap_to, SECTION_CAP_CHARS};
use crate::request_context::{estimate_tokens, memory_chain, read_memory_file, MemoryFile};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Cap (bytes) on the whole section, about 10k tokens: the size at which
/// Claude Code warns about a large `CLAUDE.md` (40k characters), so a runaway
/// file can't crowd out the conversation.
pub const INSTRUCTIONS_CAP_BYTES: usize = 40_000;

/// Below this many bytes of budget left, a file that doesn't fit whole is
/// left out rather than cut to a stub.
const MIN_TRIMMED_BYTES: usize = 1_000;

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
    /// The file's full path, as the chain named it.
    pub path: String,
    /// Estimated tokens of the text sent (0 when it was left out or skipped).
    pub tokens: u64,
    /// The file wasn't sent whole: trimmed to fit a cap, or (with 0 tokens)
    /// left out because the section was already full.
    pub trimmed: bool,
    /// Named but never read, and why: `outside the project` or `over 4 MiB`.
    pub skipped: Option<String>,
}

/// What [`load`] answers: the files and the system-prompt section built
/// from them (empty when there is none).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectInstructions {
    pub files: Vec<InstructionFile>,
    pub section: String,
}

/// Every file the workspace's instructions come from, in load order: the
/// `CLAUDE.md` chain, then the fallback files when the workspace has no
/// `CLAUDE.md` of its own (read with the same containment and bound).
fn instruction_files(workspace: &Path, home: Option<&Path>) -> Vec<MemoryFile> {
    let mut out = memory_chain(workspace, home);
    let has_own = ["CLAUDE.md", ".claude/CLAUDE.md"].iter().any(|n| workspace.join(n).is_file());
    let Ok(root) = std::fs::canonicalize(workspace) else { return out };
    if has_own {
        return out;
    }
    let mut seen: HashSet<PathBuf> = out.iter().filter_map(|f| f.real.clone()).collect();
    for name in FALLBACK_FILES {
        let path = workspace.join(name);
        let file = match read_memory_file(&path, Some(&root)) {
            Ok(None) => continue,
            Ok(Some((real, raw))) => {
                if !seen.insert(real.clone()) {
                    continue;
                }
                let bytes = raw.len() as u64;
                MemoryFile {
                    label: name.to_string(),
                    path,
                    real: Some(real),
                    text: String::from_utf8_lossy(&raw).into_owned(),
                    bytes,
                    skipped: None,
                }
            }
            Err(skip) => MemoryFile {
                label: name.to_string(),
                path,
                real: None,
                text: String::new(),
                bytes: 0,
                skipped: Some(skip),
            },
        };
        out.push(file);
    }
    out
}

/// Whether `file` is the workspace's own `CLAUDE.md` (or the `AGENTS.md`
/// standing in for it): the file the budget serves first.
fn is_own_instructions(file: &MemoryFile, workspace: &Path) -> bool {
    ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"].iter().any(|n| file.path == workspace.join(n))
}

/// The workspace's instructions: the files and the section for the system
/// prompt. `home` is the user's home (`None` skips `~/.claude/CLAUDE.md`).
/// A missing or unreadable file is left out, a skipped one is listed; with
/// none, both are empty.
pub fn load(workspace: &Path, home: Option<&Path>) -> ProjectInstructions {
    // Read files, deduped by content; skipped ones are listed, never sent.
    let mut kept: Vec<(MemoryFile, String)> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for file in instruction_files(workspace, home) {
        let text = file.text.trim().to_string();
        if file.skipped.is_none() {
            if text.is_empty() || seen.contains(&text) {
                continue;
            }
            seen.push(text.clone());
        }
        kept.push((file, text));
    }

    // The budget: the workspace's own instructions first, then the rest in
    // load order. A file that fits what is left goes whole; a larger one is
    // trimmed to it, or left out when too little is left.
    let own: Vec<bool> = kept.iter().map(|(f, _)| is_own_instructions(f, workspace)).collect();
    let order = (0..kept.len()).filter(|&i| own[i]).chain((0..kept.len()).filter(|&i| !own[i]));
    let mut bodies: Vec<String> = vec![String::new(); kept.len()];
    let mut budget = INSTRUCTIONS_CAP_BYTES;
    for i in order {
        let (file, text) = &kept[i];
        if file.skipped.is_some() {
            continue;
        }
        let cap = SECTION_CAP_CHARS.min(budget);
        bodies[i] = if text.len() <= cap {
            text.clone()
        } else if cap < MIN_TRIMMED_BYTES {
            String::new()
        } else {
            cap_to(text, cap)
        };
        budget = budget.saturating_sub(bodies[i].len());
    }

    let mut files = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    for ((file, text), body) in kept.iter().zip(&bodies) {
        files.push(InstructionFile {
            label: file.label.clone(),
            path: file.path.display().to_string(),
            tokens: estimate_tokens(body.len() as u64),
            trimmed: file.skipped.is_none() && body != text,
            skipped: file.skipped.map(|s| s.as_str().to_string()),
        });
        if !body.is_empty() {
            parts.push(format!("Contents of {}:\n\n{body}", file.label));
        }
    }
    if parts.is_empty() {
        return ProjectInstructions { files, section: String::new() };
    }
    let mut section = String::from(
        "\n\n# Project instructions\n\nThe instruction files for this workspace follow: the user's own \
         ~/.claude/CLAUDE.md and the project's CLAUDE.md files. Follow them while you work here: they \
         take precedence over the general guidance above, and a later file over an earlier one.",
    );
    for part in &parts {
        section.push_str("\n\n");
        section.push_str(part);
    }
    let left_out: Vec<&str> = files
        .iter()
        .filter(|f| f.skipped.is_none() && f.tokens == 0)
        .map(|f| f.label.as_str())
        .collect();
    if !left_out.is_empty() {
        section.push_str(&format!("\n\n(Left out for length: {}.)", left_out.join(", ")));
    }
    ProjectInstructions { files, section }
}

/// The user's home for [`for_workspace`]. Under test there is none, so no
/// test ever reads the real `~/.claude`; tests pass a temp home to [`load`].
fn user_home() -> Option<PathBuf> {
    if cfg!(test) {
        None
    } else {
        dirs::home_dir()
    }
}

/// [`load`] with the user's real home: what a Talk turn and its sub-agents use.
pub fn for_workspace(workspace: &Path) -> ProjectInstructions {
    load(workspace, user_home().as_deref())
}

/// [`for_workspace`] on a blocking thread, off the async runtime: it reads
/// files. A thread that fails to finish sends no instructions.
pub async fn for_workspace_off_runtime(workspace: PathBuf) -> ProjectInstructions {
    tokio::task::spawn_blocking(move || for_workspace(&workspace)).await.unwrap_or_default()
}
