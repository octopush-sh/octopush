//! Read-only stage roles (#847): the roles whose job is to judge or prove,
//! never to change the worktree — `repro`, `verify`, `plan_review`,
//! `code_review`, `critique`, `security_review` and any custom role with a
//! `review` artifact in the worktree environment.
//!
//! Read-only here means: no file edits and no git writes (commit, push,
//! staging, stash, checkout…; `git stash list` and `git stash show` are
//! reads and stay allowed). Commands still run — a reproducer must run the
//! failing scenario, a verifier the repro and the suite, a reviewer the
//! build — so it is a guardrail, not a sandbox:
//! - every substrate gets [`crate::orchestrator::roles::READ_ONLY_CLAUSE`];
//! - API stages lose `write_file`/`edit_file` ([`read_only_api_tools`]), and
//!   [`ReadOnlyGitGate`] refuses a call to either (API execution dispatches
//!   by name, so an unoffered tool would otherwise still run) and a
//!   `run_command` that runs a git write;
//! - Claude Code stages deny Write/Edit/MultiEdit/NotebookEdit and
//!   `Bash(git <write>:*)` (`cli_runner::cli_disallowed_tools`; `stash` gets
//!   one rule per write form, see [`CLI_STASH_DENY_RULES`]);
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
/// `show`, `blame`, `branch`, `tag` listing… stay allowed). `stash` is the
/// one with read forms: [`STASH_READ_FORMS`] stay allowed.
pub const GIT_WRITE_SUBCOMMANDS: &[&str] = &[
    "add", "am", "apply", "checkout", "cherry-pick", "clean", "commit", "merge", "mv", "pull",
    "push", "rebase", "reset", "restore", "revert", "rm", "stash", "switch",
];

/// `git stash` subcommands that only read: allowed on a read-only stage.
/// Every other form (`push`, `pop`, `apply`, `drop`, `clear`, `save`,
/// `branch`, `store`, `create`, a bare `git stash` or one led by an option
/// such as `-u`, which means `push`) is a write.
pub const STASH_READ_FORMS: &[&str] = &["list", "show"];

/// The Claude Code `--disallowedTools` rules for `git stash` on a read-only
/// CLI stage. Bash rules are prefix rules, so one `Bash(git stash:*)` would
/// also deny `git stash list`/`show`; the write forms are denied one by one
/// instead. `Bash(git stash)` (no wildcard) is an exact match for the bare
/// command, and `Bash(git stash -*)` (no space before `*`) catches a push
/// led by an option (`-u`, `-p`, `--keep-index`…). Not expressible: options
/// between `git` and `stash` (`git -C dir stash pop`), which slip past every
/// `Bash(git <sub>:*)` rule alike — the commit notice is the backstop.
pub const CLI_STASH_DENY_RULES: &[&str] = &[
    "Bash(git stash)",
    "Bash(git stash -*)",
    "Bash(git stash push:*)",
    "Bash(git stash save:*)",
    "Bash(git stash pop:*)",
    "Bash(git stash apply:*)",
    "Bash(git stash drop:*)",
    "Bash(git stash clear:*)",
    "Bash(git stash branch:*)",
    "Bash(git stash store:*)",
    "Bash(git stash create:*)",
    "Bash(git stash import:*)",
    "Bash(git stash export:*)",
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

/// The write tools a read-only stage's own saved allowlist grants, which
/// [`read_only_api_tools`] removes (empty for a writer role, or when the
/// stage has no list). Pure.
pub fn stripped_write_tools(read_only: bool, tools: Option<&[String]>) -> Vec<String> {
    if !read_only {
        return Vec::new();
    }
    tools
        .unwrap_or_default()
        .iter()
        .filter(|t| WRITE_TOOLS.contains(&t.as_str()))
        .cloned()
        .collect()
}

/// The stage journal line saying a read-only role's write tools were
/// removed, if any were (see [`stripped_write_tools`]). Pure.
pub fn stripped_write_tools_notice(read_only: bool, tools: Option<&[String]>) -> Option<String> {
    let stripped = stripped_write_tools(read_only, tools);
    if stripped.is_empty() {
        return None;
    }
    let list = stripped.iter().map(|t| format!("`{t}`")).collect::<Vec<_>>().join(", ");
    Some(format!(
        "This role is read-only, so {list} {} removed from its tool allowlist for this stage",
        if stripped.len() == 1 { "was" } else { "were" }
    ))
}

/// The first git write subcommand `cmd` runs, if any. Splits the command line
/// on shell separators (`;`, `&`, `|`, newlines, parentheses, backticks,
/// `$(`), finds each `git` (or `…/git`) word, skips git's global options
/// (`-C <dir>`, `-c <k=v>`, `--git-dir=…` or `--git-dir <dir>`,
/// `--work-tree <dir>`, `--no-pager`…) and checks the subcommand against
/// [`GIT_WRITE_SUBCOMMANDS`] (`stash list`/`stash show` excepted). A heuristic, not a parser:
/// quoted text becomes a `_` placeholder word, so `sh -c "git commit"` style indirection gets
/// through, which is what the commit notice is for. Pure.
pub fn git_write_in(cmd: &str) -> Option<&'static str> {
    // Quoted text is data (`grep 'git commit'`, a commit message), not a
    // command: blank it out first, leaving a `_` placeholder so a quoted
    // option value (`--git-dir "/w/.git"`) still counts as one word.
    let mut unquoted = String::with_capacity(cmd.len());
    let mut quote: Option<char> = None;
    for c in cmd.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                unquoted.push('_');
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
                    // These take a separate value (the `--opt=value`
                    // spelling is one word and needs no skip).
                    if matches!(
                        words[j],
                        "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace" | "--config-env" | "--attr-source"
                    ) {
                        j += 1;
                    }
                    j += 1;
                }
                if let Some(sub) = words.get(j) {
                    if let Some(hit) = GIT_WRITE_SUBCOMMANDS.iter().find(|s| *s == sub) {
                        let stash_read = *hit == "stash"
                            && words.get(j + 1).is_some_and(|f| STASH_READ_FORMS.contains(f));
                        if !stash_read {
                            return Some(hit);
                        }
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

/// The tool result a refused file-write tool returns to the model.
pub fn write_tool_denial(name: &str) -> String {
    format!(
        "Refused: `{name}` edits files, and this is a read-only stage. Leave the worktree exactly \
         as you found it; report what you found instead."
    )
}

/// Pre-execution gate for a read-only API stage: refuses `write_file` and
/// `edit_file` (defence in depth: they are dropped from the offered tools,
/// but API execution dispatches by name without checking the allowlist) and
/// a `run_command` that runs a git write (see [`git_write_in`]). Every other
/// tool runs.
pub struct ReadOnlyGitGate;

#[async_trait::async_trait]
impl crate::orchestrator::agentic::ToolGate for ReadOnlyGitGate {
    async fn check(&self, name: &str, input: &serde_json::Value) -> Option<String> {
        if WRITE_TOOLS.contains(&name) {
            return Some(write_tool_denial(name));
        }
        if name != "run_command" {
            return None;
        }
        let cmd = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
        git_write_in(cmd).map(git_write_denial)
    }
}
