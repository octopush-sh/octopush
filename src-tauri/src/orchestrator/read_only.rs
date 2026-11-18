//! Read-only stage roles (#847): the roles whose job is to judge or prove,
//! never to change the worktree — `repro`, `verify`, `plan_review`,
//! `code_review`, `critique`, `security_review` and any custom role with a
//! `review` artifact in the worktree environment.
//!
//! Read-only here means: no file edits and no git writes (commit, push,
//! staging, stash, checkout…). Commands still run — a reproducer must run the
//! failing scenario, a verifier the repro and the suite, a reviewer the
//! build — so it is a guardrail, not a sandbox:
//! - every substrate gets [`crate::orchestrator::roles::READ_ONLY_CLAUSE`];
//! - API stages lose `write_file`/`edit_file` ([`read_only_api_tools`]) and
//!   a `run_command` that runs a git write is refused ([`ReadOnlyGitGate`]);
//! - Claude Code stages deny Write/Edit/MultiEdit/NotebookEdit and
//!   `Bash(git <write>:*)` (`cli_runner::cli_disallowed_tools`);
//! - Codex stages run in Codex's kernel-enforced `--sandbox read-only`.
//!
//! Writer roles are untouched: `implement`, `fix`, `refine` and `test`
//! (Tests writes the test files it runs). Action roles (`pull_request`,
//! `merge`, `release`) commit and push by design. The orchestrator's
//! "this stage created git commit(s)" journal notice stays as the backstop
//! for anything a shell command slips past these rules.

use crate::orchestrator::types::{ArtifactKind, RoleEnvironment};

/// Whether a role is read-only: a `review` artifact in the worktree
/// environment. Action-environment roles keep write access — committing and
/// pushing is their job. Pure.
pub fn role_is_read_only(kind: &ArtifactKind, env: RoleEnvironment) -> bool {
    matches!(kind, ArtifactKind::Review) && matches!(env, RoleEnvironment::Worktree)
}

/// The workspace tools that edit files, dropped from a read-only API stage.
pub const WRITE_TOOLS: &[&str] = &["write_file", "edit_file"];

/// Git subcommands that change the index, the working tree, refs or the
/// remote. A read-only stage may not run them (`git status`, `diff`, `log`,
/// `show`, `blame`, `branch`, `tag` listing… stay allowed).
pub const GIT_WRITE_SUBCOMMANDS: &[&str] = &[
    "add", "am", "apply", "checkout", "cherry-pick", "clean", "commit", "merge", "mv", "pull",
    "push", "rebase", "reset", "restore", "revert", "rm", "stash", "switch",
];

/// The effective API tool allowlist for a read-only stage: the stage's own
/// allowlist (`None` = the full workspace set) minus [`WRITE_TOOLS`]. Order
/// is kept. Pure.
pub fn read_only_api_tools(tools: Option<&[String]>) -> Vec<String> {
    let base: Vec<String> = match tools {
        Some(t) => t.to_vec(),
        None => crate::db::KNOWN_TOOLS.iter().map(|s| s.to_string()).collect(),
    };
    base.into_iter().filter(|t| !WRITE_TOOLS.contains(&t.as_str())).collect()
}

/// The first git write subcommand `cmd` runs, if any. Splits the command line
/// on shell separators (`;`, `&`, `|`, newlines, parentheses, backticks,
/// `$(`), finds each `git` (or `…/git`) word, skips git's global options
/// (`-C <dir>`, `-c <k=v>`, `--git-dir=…`, `--no-pager`…) and checks the
/// subcommand against [`GIT_WRITE_SUBCOMMANDS`]. A heuristic, not a parser:
/// quoted text is skipped, so `sh -c "git commit"` style indirection gets
/// through, which is what the commit notice is for. Pure.
pub fn git_write_in(cmd: &str) -> Option<&'static str> {
    // Quoted text is data (`grep 'git commit'`, a commit message), not a
    // command: blank it out first.
    let mut unquoted = String::with_capacity(cmd.len());
    let mut quote: Option<char> = None;
    for c in cmd.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                unquoted.push(' ');
            }
            None => unquoted.push(c),
        }
    }
    let segments = unquoted.split(|c: char| matches!(c, ';' | '&' | '|' | '\n' | '(' | ')' | '`' | '{' | '}'));
    for seg in segments {
        let words: Vec<&str> = seg.split_whitespace().map(|w| w.trim_start_matches('$')).collect();
        let mut i = 0;
        while i < words.len() {
            let w = words[i];
            if w == "git" || w.ends_with("/git") {
                let mut j = i + 1;
                while j < words.len() && words[j].starts_with('-') {
                    // `-C <dir>` and `-c <k=v>` take a separate value.
                    if matches!(words[j], "-C" | "-c") {
                        j += 1;
                    }
                    j += 1;
                }
                if let Some(sub) = words.get(j) {
                    if let Some(hit) = GIT_WRITE_SUBCOMMANDS.iter().find(|s| *s == sub) {
                        return Some(hit);
                    }
                }
                i = j;
            }
            i += 1;
        }
    }
    None
}

/// The tool result a refused git write returns to the model.
pub fn git_write_denial(sub: &str) -> String {
    format!(
        "Refused: `git {sub}` changes the repository, and this is a read-only stage. Leave the \
         worktree and git history exactly as you found them; report what you found instead."
    )
}

/// Pre-execution gate for a read-only API stage: refuses a `run_command`
/// that runs a git write (see [`git_write_in`]). Every other tool runs.
pub struct ReadOnlyGitGate;

#[async_trait::async_trait]
impl crate::orchestrator::agentic::ToolGate for ReadOnlyGitGate {
    async fn check(&self, name: &str, input: &serde_json::Value) -> Option<String> {
        if name != "run_command" {
            return None;
        }
        let cmd = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
        git_write_in(cmd).map(git_write_denial)
    }
}
