//! Whether Codex will load a repo's `.codex/` config for a Codex CLI stage.
//!
//! Codex loads project-scoped config (`.codex/config.toml`, project hooks,
//! rules, MCP servers) only for a trusted project, and `codex exec` keeps it
//! off in an untrusted one, printing "Untrusted project-local configuration is
//! disabled". Its loader looks the trust up in the merged `[projects]` table,
//! keyed by path: the working directory first, then the main repository's
//! root (`resolve_root_git_project_for_trust` follows a linked worktree back to
//! its main checkout); only `trust_level = "trusted"` loads the layers
//! (openai/codex `codex-rs/config/src/loader/mod.rs`, `ProjectTrustContext`).
//!
//! Octopush only reads these files. It never writes the user's Codex config
//! and never passes a trust flag: trusting a project is the user's call.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The launcher and journal line for an untrusted project with a `.codex/` dir.
pub const CODEX_UNTRUSTED_NOTE: &str =
    "Codex will ignore this repo's .codex/ settings and MCP servers: the project isn't trusted in Codex.";

/// How the user can trust it themselves.
pub const CODEX_TRUST_HOW: &str = "To trust it, open Codex in the repo once and accept, or run \
     `codex exec --trust` there yourself. Octopush never changes your Codex config.";

/// What the readable Codex config says about a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexTrust {
    Trusted,
    /// `untrusted`, or no decision saved: Codex skips the project layers.
    NotTrusted,
    /// The user config is missing or a config file can't be read or parsed:
    /// say nothing.
    Unknown,
}

/// The project's trust from Codex config texts, lowest precedence first (a
/// later layer's entry for a key wins, as in Codex's merge), looked up in
/// `keys` order. Only entries with a `trust_level` count, as in Codex. An
/// unparsable layer or a `trust_level` that isn't `trusted`/`untrusted`
/// reads as [`CodexTrust::Unknown`]. Pure.
pub fn project_trust(layers: &[&str], keys: &[String]) -> CodexTrust {
    let mut levels: HashMap<String, String> = HashMap::new();
    for text in layers {
        let Ok(table) = text.parse::<toml::Table>() else {
            return CodexTrust::Unknown;
        };
        let Some(projects) = table.get("projects") else { continue };
        let Some(projects) = projects.as_table() else {
            return CodexTrust::Unknown;
        };
        for (key, entry) in projects {
            if let Some(level) = entry.get("trust_level") {
                let Some(level) = level.as_str() else { return CodexTrust::Unknown };
                levels.insert(key.clone(), level.to_string());
            }
        }
    }
    match keys.iter().find_map(|k| levels.get(k)).map(String::as_str) {
        Some("trusted") => CodexTrust::Trusted,
        Some("untrusted") | None => CodexTrust::NotTrusted,
        Some(_) => CodexTrust::Unknown,
    }
}

/// The main checkout of `worktree`: itself for a regular checkout, the
/// common git dir's parent for a linked worktree (`.git` is a `gitdir:` file
/// whose dir holds a `commondir` file). Filesystem only, no `git`; `None`
/// when it isn't a git checkout.
pub fn main_repo_root(worktree: &Path) -> Option<PathBuf> {
    let dot_git = worktree.join(".git");
    if dot_git.is_dir() {
        return Some(worktree.to_path_buf());
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let gitdir = text.lines().find_map(|l| l.trim().strip_prefix("gitdir:"))?.trim();
    let gitdir = worktree.join(gitdir); // absolute paths replace the base
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
    let common = gitdir.join(common.trim());
    let common = common.canonicalize().unwrap_or(common);
    common.parent().map(Path::to_path_buf)
}

/// Lookup keys for `dirs`, in order: each one's canonical spelling, then
/// its spelling as given, without repeats.
fn lookup_keys(dirs: &[&Path]) -> Vec<String> {
    let mut keys = Vec::new();
    for dir in dirs {
        let canonical = dir.canonicalize().ok();
        for p in canonical.as_deref().into_iter().chain(std::iter::once(*dir)) {
            let k = p.to_string_lossy().trim_end_matches('/').to_string();
            if !k.is_empty() && !keys.contains(&k) {
                keys.push(k);
            }
        }
    }
    keys
}

/// Codex's home: `CODEX_HOME` from the login-shell environment (what a stage
/// runs with), else the app's own, else `~/.codex`.
fn codex_home() -> Option<PathBuf> {
    let shell = crate::orchestrator::cli_runner::login_shell_env();
    let var = |name: &str| {
        shell
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .or_else(|| std::env::var(name).ok())
            .filter(|v| !v.trim().is_empty())
    };
    if let Some(home) = var("CODEX_HOME") {
        return Some(PathBuf::from(home));
    }
    var("HOME").map(PathBuf::from).or_else(dirs::home_dir).map(|h| h.join(".codex"))
}

/// Config files that may hold `[projects]`, lowest precedence first: the
/// system config, the user's, then the managed ones. The user's is required.
fn config_texts(codex_home: &Path) -> Option<Vec<String>> {
    let user = std::fs::read_to_string(codex_home.join("config.toml")).ok()?;
    let mut texts = Vec::new();
    let optional = |p: PathBuf, texts: &mut Vec<String>| -> Option<()> {
        if p.exists() {
            texts.push(std::fs::read_to_string(&p).ok()?);
        }
        Some(())
    };
    optional(PathBuf::from("/etc/codex/config.toml"), &mut texts)?;
    texts.push(user);
    optional(codex_home.join("managed_config.toml"), &mut texts)?;
    optional(PathBuf::from("/etc/codex/managed_config.toml"), &mut texts)?;
    Some(texts)
}

/// The project's trust in `codex_home`'s config for a stage running in
/// `worktree`.
pub fn trust_in(codex_home: &Path, worktree: &Path) -> CodexTrust {
    let Some(texts) = config_texts(codex_home) else { return CodexTrust::Unknown };
    let root = main_repo_root(worktree);
    let dirs: Vec<&Path> = std::iter::once(worktree).chain(root.as_deref()).collect();
    let layers: Vec<&str> = texts.iter().map(String::as_str).collect();
    project_trust(&layers, &lookup_keys(&dirs))
}

/// Whether the worktree or its main checkout has a `.codex/` directory.
pub fn has_codex_dir(worktree: &Path) -> bool {
    worktree.join(".codex").is_dir() || main_repo_root(worktree).is_some_and(|r| r.join(".codex").is_dir())
}

/// [`CODEX_UNTRUSTED_NOTE`] when the repo has a `.codex/` dir that Codex
/// will skip in `worktree` under `codex_home`; `None` when trusted, unknown,
/// or there is nothing to skip.
pub fn untrusted_note_in(codex_home: &Path, worktree: &Path) -> Option<&'static str> {
    (has_codex_dir(worktree) && trust_in(codex_home, worktree) == CodexTrust::NotTrusted)
        .then_some(CODEX_UNTRUSTED_NOTE)
}

/// [`untrusted_note_in`] with the user's Codex home.
pub fn untrusted_note(worktree: &Path) -> Option<&'static str> {
    untrusted_note_in(&codex_home()?, worktree)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(k: &[&str]) -> Vec<String> {
        k.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn trusted_untrusted_missing_and_malformed() {
        let k = keys(&["/w/feature", "/w/repo"]);
        assert_eq!(project_trust(&["[projects.\"/w/repo\"]\ntrust_level = \"trusted\"\n"], &k), CodexTrust::Trusted);
        assert_eq!(project_trust(&["[projects.\"/w/repo\"]\ntrust_level = \"untrusted\"\n"], &k), CodexTrust::NotTrusted);
        assert_eq!(project_trust(&["model = \"gpt-5.5\"\n"], &k), CodexTrust::NotTrusted, "no decision: Codex skips it");
        assert_eq!(project_trust(&["[projects.\"/elsewhere\"]\ntrust_level = \"trusted\"\n"], &k), CodexTrust::NotTrusted);
        assert_eq!(project_trust(&["[projects\nbroken"], &k), CodexTrust::Unknown);
        assert_eq!(project_trust(&["projects = 3\n"], &k), CodexTrust::Unknown);
        assert_eq!(project_trust(&["[projects.\"/w/repo\"]\ntrust_level = \"maybe\"\n"], &k), CodexTrust::Unknown);
        assert_eq!(project_trust(&["[projects.\"/w/repo\"]\ntrust_level = 1\n"], &k), CodexTrust::Unknown);
    }

    #[test]
    fn the_working_dir_wins_over_the_main_checkout_and_later_layers_win() {
        let k = keys(&["/w/feature", "/w/repo"]);
        let both = "[projects.\"/w/feature\"]\ntrust_level = \"untrusted\"\n[projects.\"/w/repo\"]\ntrust_level = \"trusted\"\n";
        assert_eq!(project_trust(&[both], &k), CodexTrust::NotTrusted);
        // An entry without a trust level doesn't count.
        let bare = "[projects.\"/w/feature\"]\n[projects.\"/w/repo\"]\ntrust_level = \"trusted\"\n";
        assert_eq!(project_trust(&[bare], &k), CodexTrust::Trusted);
        // A managed layer overrides the user's entry for the same key.
        let user = "[projects.\"/w/repo\"]\ntrust_level = \"trusted\"\n";
        let managed = "[projects.\"/w/repo\"]\ntrust_level = \"untrusted\"\n";
        assert_eq!(project_trust(&[user, managed], &k), CodexTrust::NotTrusted);
        assert_eq!(project_trust(&[managed, user], &k), CodexTrust::Trusted);
    }

    /// A main checkout with a linked worktree, laid out as git does.
    fn linked_worktree(base: &Path) -> (PathBuf, PathBuf) {
        let repo = base.join("repo");
        let wt = base.join("wt");
        std::fs::create_dir_all(repo.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(repo.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", repo.join(".git/worktrees/wt").display())).unwrap();
        (repo.canonicalize().unwrap(), wt.canonicalize().unwrap())
    }

    #[test]
    fn a_linked_worktree_resolves_to_its_main_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, wt) = linked_worktree(tmp.path());
        assert_eq!(main_repo_root(&wt).as_deref(), Some(repo.as_path()));
        assert_eq!(main_repo_root(&repo).as_deref(), Some(repo.as_path()));
        assert_eq!(main_repo_root(tmp.path()), None, "not a checkout");
    }

    #[test]
    fn the_note_shows_only_for_an_untrusted_repo_with_a_codex_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, wt) = linked_worktree(tmp.path());
        let home = tmp.path().join("codex-home");
        std::fs::create_dir_all(&home).unwrap();
        let write = |text: &str| std::fs::write(home.join("config.toml"), text).unwrap();
        let trusted = |p: &Path| format!("[projects.\"{}\"]\ntrust_level = \"trusted\"\n", p.display());

        // No .codex/ dir: nothing to skip.
        write("model = \"gpt-5.5\"\n");
        assert_eq!(untrusted_note_in(&home, &wt), None);

        std::fs::create_dir_all(wt.join(".codex")).unwrap();
        assert_eq!(untrusted_note_in(&home, &wt), Some(CODEX_UNTRUSTED_NOTE), "no decision saved");
        write(&trusted(&repo));
        assert_eq!(untrusted_note_in(&home, &wt), None, "the main checkout's trust covers its worktree");
        write(&trusted(&wt));
        assert_eq!(untrusted_note_in(&home, &wt), None);
        write(&format!("[projects.\"{}\"]\ntrust_level = \"untrusted\"\n", repo.display()));
        assert_eq!(untrusted_note_in(&home, &wt), Some(CODEX_UNTRUSTED_NOTE));
        write("[projects\nbroken");
        assert_eq!(untrusted_note_in(&home, &wt), None, "malformed: unknown, silent");
        std::fs::remove_file(home.join("config.toml")).unwrap();
        assert_eq!(untrusted_note_in(&home, &wt), None, "missing: unknown, silent");
        assert_eq!(trust_in(&home, &wt), CodexTrust::Unknown);
    }
}
