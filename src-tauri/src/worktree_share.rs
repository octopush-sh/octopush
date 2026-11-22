//! Share with new missions (#961) — what a fresh worktree borrows from the
//! project's main checkout before its setup script runs, so a JS or Python
//! project doesn't reinstall its dependencies for every mission.
//!
//! Two kinds, both opt-in per project (`projects.share_with_missions`, JSON):
//!
//! - **link** a dependency folder ([`LINK_CANDIDATES`]: `node_modules`,
//!   `.venv`, `venv`) as a symlink to the main checkout's copy. The folder is
//!   shared state: an install in one mission changes it for every mission.
//!   Build outputs (`target`, `dist`, `build`, …) are never candidates.
//! - **copy** a local env file (`.env`, `.env.*`) into the worktree.
//!
//! Only entries the main checkout has and git ignores are offered
//! ([`candidates`]), and only those are applied ([`apply`]): a name is checked
//! against the same allowlist again, so a value in the DB can't name another
//! path. After applying, every entry must be git-ignored **in the worktree**
//! (its branch may carry another `.gitignore`), or it is removed again — so a
//! copied `.env` never stages and the secret guard keeps seeing it as an
//! ignored, untracked file, and a link is never committed. A `.gitignore`
//! line `node_modules/` matches only directories, never a symlink, so each
//! linked name is added as `/<name>` to the repo's local `info/exclude`
//! (shared by every worktree, never committed) before that check.
//!
//! **Sandboxed missions get no links.** A link points outside the worktree:
//! Seatbelt would refuse writes through it but Claude Code's read guard
//! (`cli_runner::CLAUDE_SANDBOXED_STAGE_SETTINGS`) would refuse reads through
//! it too, and widening either for a shared folder isn't worth it. Copies
//! still apply: they are ordinary files inside the worktree. A mission whose
//! Execution later becomes `sandbox` loses the links it got ([`unlink`]).
//!
//! Only a freshly created worktree is touched (like the setup script), and
//! nothing already in the worktree is replaced.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

/// The dependency folders a mission may link. Never a build output.
pub const LINK_CANDIDATES: &[&str] = &["node_modules", ".venv", "venv"];

/// The marker line above the names Octopush adds to `info/exclude`.
pub const EXCLUDE_MARKER: &str = "# Octopush: folders linked into new missions (#961)";

/// What a project shares with its new missions: folder names to link and file
/// names to copy, each a single entry at the repo root.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSpec {
    #[serde(default)]
    pub link: Vec<String>,
    #[serde(default)]
    pub copy: Vec<String>,
}

impl ShareSpec {
    pub fn is_empty(&self) -> bool {
        self.link.is_empty() && self.copy.is_empty()
    }

    /// Only the allowed names, each once, in the order given.
    pub fn sanitized(&self) -> ShareSpec {
        fn keep(names: &[String], ok: fn(&str) -> bool) -> Vec<String> {
            let mut out: Vec<String> = Vec::new();
            for n in names {
                if ok(n) && !out.contains(n) {
                    out.push(n.clone());
                }
            }
            out
        }
        ShareSpec { link: keep(&self.link, is_link_name), copy: keep(&self.copy, is_copy_name) }
    }

    /// The stored JSON, read leniently: anything unreadable shares nothing.
    pub fn from_stored(raw: &str) -> ShareSpec {
        serde_json::from_str::<ShareSpec>(raw).unwrap_or_default().sanitized()
    }
}

/// A folder name a mission may link.
pub fn is_link_name(name: &str) -> bool {
    LINK_CANDIDATES.contains(&name)
}

/// A file name a mission may copy: `.env` or `.env.<suffix>`, one plain entry
/// at the repo root (no separators, no `..`, printable ASCII, ≤ 64 bytes).
pub fn is_copy_name(name: &str) -> bool {
    (name == ".env" || name.starts_with(".env."))
        && name.len() <= 64
        && !name.contains("..")
        && name.bytes().all(|b| b.is_ascii_graphic() && b != b'/' && b != b'\\')
}

/// What applying a [`ShareSpec`] did, for the setup line and the toast.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOutcome {
    pub linked: Vec<String>,
    pub copied: Vec<String>,
    /// One plain sentence per entry left out ("node_modules: not linked in a
    /// sandboxed mission").
    pub skipped: Vec<String>,
}

impl ShareOutcome {
    /// `linked node_modules · copied .env`, or `None` when nothing was shared.
    pub fn summary(&self) -> Option<String> {
        let mut parts = Vec::new();
        if !self.linked.is_empty() {
            parts.push(format!("linked {}", self.linked.join(", ")));
        }
        if !self.copied.is_empty() {
            parts.push(format!("copied {}", self.copied.join(", ")));
        }
        (!parts.is_empty()).then(|| parts.join(" · "))
    }
}

/// Whether git ignores `name` (relative to `dir`). Anything but a clear "yes"
/// (git missing, not a repo) counts as not ignored: fail closed.
fn git_ignores(dir: &Path, name: &str) -> bool {
    Command::new("git")
        .args(["check-ignore", "-q", "--", name])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// What the main checkout at `root` could share: each link candidate it has
/// as a directory and each `.env*` regular file at its top level, git-ignored
/// either way. Sorted; empty when `root` isn't a readable repo.
pub fn candidates(root: &Path) -> ShareSpec {
    let mut out = ShareSpec::default();
    for name in LINK_CANDIDATES {
        if root.join(name).is_dir() && git_ignores(root, name) {
            out.link.push(name.to_string());
        }
    }
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            // `file_type` doesn't follow a symlink: a linked `.env` isn't offered.
            let regular = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if is_copy_name(&name) && regular && git_ignores(root, &name) {
                out.copy.push(name);
            }
        }
    }
    out.copy.sort();
    out
}

/// The repo's shared git dir as seen from `worktree` (`--git-common-dir`).
fn common_git_dir(worktree: &Path) -> Option<std::path::PathBuf> {
    let out = Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(worktree)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| std::path::PathBuf::from(s))
}

/// The `info/exclude` text with `/<name>` added for each of `names` it lacks,
/// under [`EXCLUDE_MARKER`]; `None` when nothing is missing. Pure.
pub fn exclude_with(existing: &str, names: &[String]) -> Option<String> {
    let have = |line: &str| existing.lines().any(|l| l.trim() == line);
    let missing: Vec<String> = names.iter().map(|n| format!("/{n}")).filter(|l| !have(l)).collect();
    if missing.is_empty() {
        return None;
    }
    let mut text = existing.to_string();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if !have(EXCLUDE_MARKER) {
        text.push_str(EXCLUDE_MARKER);
        text.push('\n');
    }
    for l in missing {
        text.push_str(&l);
        text.push('\n');
    }
    Some(text)
}

/// Make sure the repo's local `info/exclude` ignores each linked name as a
/// path (a `name/` rule never matches a symlink).
fn exclude_links(worktree: &Path, names: &[String]) {
    let Some(common) = common_git_dir(worktree) else { return };
    let path = common.join("info").join("exclude");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if let Some(text) = exclude_with(&existing, names) {
        let _ = std::fs::create_dir_all(common.join("info"));
        if let Err(e) = std::fs::write(&path, text) {
            tracing::warn!(error = %e, "share: couldn't update info/exclude");
        }
    }
}

/// Copy `src` to `dest` without following or replacing anything at `dest`,
/// keeping the source's permissions (an `.env` is often 0600).
fn copy_new(src: &Path, dest: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if !meta.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    let mut from = std::fs::File::open(src)?;
    let mut to = std::fs::OpenOptions::new().write(true).create_new(true).open(dest)?;
    std::io::copy(&mut from, &mut to)?;
    to.set_permissions(meta.permissions())?;
    Ok(())
}

#[cfg(unix)]
fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink_dir(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("links need macOS"))
}

/// Apply `spec` from the main checkout `root` to the fresh `worktree`
/// (`sandboxed`: the mission's own exec isolation is `sandbox`, so no links).
/// Never fails the mission: each entry that can't be shared is reported in
/// [`ShareOutcome::skipped`].
pub fn apply(root: &Path, worktree: &Path, spec: &ShareSpec, sandboxed: bool) -> ShareOutcome {
    let spec = spec.sanitized();
    let mut out = ShareOutcome::default();
    for name in &spec.link {
        let (src, dest) = (root.join(name), worktree.join(name));
        if sandboxed {
            out.skipped.push(format!("{name}: not linked in a sandboxed mission"));
        } else if !src.is_dir() {
            out.skipped.push(format!("{name}: not in the main checkout"));
        } else if std::fs::symlink_metadata(&dest).is_ok() {
            out.skipped.push(format!("{name}: already in the worktree"));
        } else if let Err(e) = symlink_dir(&src, &dest) {
            out.skipped.push(format!("{name}: couldn't link ({e})"));
        } else {
            out.linked.push(name.clone());
        }
    }
    for name in &spec.copy {
        let (src, dest) = (root.join(name), worktree.join(name));
        if std::fs::symlink_metadata(&dest).is_ok() {
            out.skipped.push(format!("{name}: already in the worktree"));
        } else if let Err(e) = copy_new(&src, &dest) {
            out.skipped.push(match e.kind() {
                std::io::ErrorKind::NotFound => format!("{name}: not in the main checkout"),
                _ => format!("{name}: couldn't copy ({e})"),
            });
        } else {
            out.copied.push(name.clone());
        }
    }
    if !out.linked.is_empty() {
        exclude_links(worktree, &out.linked);
    }
    // Nothing shared may ever stage: undo whatever git doesn't ignore here.
    out.linked.retain(|name| {
        let ignored = git_ignores(worktree, name);
        if !ignored {
            let _ = std::fs::remove_file(worktree.join(name));
            out.skipped.push(format!("{name}: removed, git doesn't ignore it in this worktree"));
        }
        ignored
    });
    out.copied.retain(|name| {
        let ignored = git_ignores(worktree, name);
        if !ignored {
            let _ = std::fs::remove_file(worktree.join(name));
            out.skipped.push(format!("{name}: removed, this branch doesn't git-ignore it"));
        }
        ignored
    });
    out
}

/// Whether `link` is a symlink to the main checkout's `src` (as [`apply`]
/// made it: the same path, or one that resolves to the same folder).
fn links_to(link: &Path, src: &Path) -> bool {
    let is_link = std::fs::symlink_metadata(link).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    let Ok(target) = std::fs::read_link(link) else { return false };
    is_link
        && (target == src
            || matches!(
                (std::fs::canonicalize(link), std::fs::canonicalize(src)),
                (Ok(a), Ok(b)) if a == b
            ))
}

/// Remove the links [`apply`] made in `worktree`, for a mission whose
/// Execution became `sandbox`: each [`LINK_CANDIDATES`] entry that is a
/// symlink to the main checkout `root`'s folder of the same name. A real
/// folder, a copy, or a link elsewhere is left alone, and so is `root` itself.
/// Returns the names removed.
pub fn unlink(root: &Path, worktree: &Path) -> Vec<String> {
    if worktree == root {
        return Vec::new();
    }
    let mut removed = Vec::new();
    for name in LINK_CANDIDATES {
        let (src, dest) = (root.join(name), worktree.join(name));
        if links_to(&dest, &src) {
            match std::fs::remove_file(&dest) {
                Ok(()) => removed.push(name.to_string()),
                Err(e) => tracing::warn!(error = %e, name = %name, "share: couldn't remove a link"),
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A repo with `.gitignore` committed, a main-checkout `node_modules` and
    /// `.env`, and a linked worktree at `<tmp>/wt`.
    fn repo(gitignore: &str) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q"]);
        std::fs::write(root.join(".gitignore"), gitignore).unwrap();
        std::fs::write(root.join(".env.example"), "KEY=\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "init"]);
        std::fs::create_dir_all(root.join("node_modules/left-pad")).unwrap();
        std::fs::write(root.join("node_modules/left-pad/index.js"), "x").unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        let wt = root.parent().unwrap().join("wt");
        git(&root, &["worktree", "add", "-q", "-b", "m", wt.to_str().unwrap()]);
        (tmp, root, wt)
    }

    #[test]
    fn build_outputs_are_never_link_candidates() {
        for out in ["target", "dist", "build", ".next", "out", ".turbo", "__pycache__"] {
            assert!(!is_link_name(out), "{out}");
        }
        assert!(is_link_name("node_modules") && is_link_name(".venv"));
    }

    #[test]
    fn copy_names_stay_one_env_file_at_the_root() {
        for ok in [".env", ".env.local", ".env.development.local"] {
            assert!(is_copy_name(ok), "{ok}");
        }
        for bad in ["env", ".envrc", ".env/../x", "../.env", ".env.a/b", ".env..x", ".env.\u{200b}", "a/.env", ""] {
            assert!(!is_copy_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn stored_specs_are_read_leniently_and_sanitized() {
        assert_eq!(ShareSpec::from_stored(""), ShareSpec::default());
        assert_eq!(ShareSpec::from_stored("not json"), ShareSpec::default());
        let s = ShareSpec::from_stored(r#"{"link":["node_modules","target","node_modules","/etc"],"copy":[".env","../.ssh/id_rsa"]}"#);
        assert_eq!(s, ShareSpec { link: vec!["node_modules".into()], copy: vec![".env".into()] });
    }

    #[test]
    fn summary_reads_like_the_setup_line() {
        let o = ShareOutcome { linked: vec!["node_modules".into()], copied: vec![".env".into(), ".env.local".into()], skipped: vec![] };
        assert_eq!(o.summary().as_deref(), Some("linked node_modules · copied .env, .env.local"));
        assert_eq!(ShareOutcome::default().summary(), None);
    }

    #[test]
    fn exclude_adds_each_missing_name_once() {
        let names = vec!["node_modules".to_string()];
        let t = exclude_with("# git ls-files\n*.swp", &names).unwrap();
        assert_eq!(t, format!("# git ls-files\n*.swp\n{EXCLUDE_MARKER}\n/node_modules\n"));
        assert_eq!(exclude_with(&t, &names), None);
        let t2 = exclude_with(&t, &[".venv".to_string()]).unwrap();
        assert_eq!(t2.matches(EXCLUDE_MARKER).count(), 1);
        assert!(t2.ends_with("/node_modules\n/.venv\n"));
    }

    #[test]
    fn candidates_are_what_the_checkout_has_and_ignores() {
        let (_tmp, root, _wt) = repo("node_modules/\ntarget/\n.env\n");
        let c = candidates(&root);
        assert_eq!(c.link, vec!["node_modules".to_string()]);
        // `.env.example` is tracked, not ignored: never offered.
        assert_eq!(c.copy, vec![".env".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn apply_links_and_copies_and_nothing_stages() {
        // `node_modules/` (trailing slash) never matches a symlink by itself.
        let (_tmp, root, wt) = repo("node_modules/\n.env\n");
        let spec = ShareSpec { link: vec!["node_modules".into()], copy: vec![".env".into()] };
        let out = apply(&root, &wt, &spec, false);
        assert_eq!(out.linked, vec!["node_modules".to_string()]);
        assert_eq!(out.copied, vec![".env".to_string()]);
        assert!(out.skipped.is_empty(), "{:?}", out.skipped);
        assert!(std::fs::symlink_metadata(wt.join("node_modules")).unwrap().file_type().is_symlink());
        assert!(wt.join("node_modules/left-pad/index.js").exists());
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "SECRET=1\n");
        // Neither shows as untracked, so neither can stage or reach a commit.
        assert_eq!(git(&wt, &["status", "--porcelain", "--untracked-files=all"]), "");
        git(&wt, &["add", "-A"]);
        assert_eq!(git(&wt, &["diff", "--cached", "--name-only"]), "");
        // The main checkout's own status is unchanged too.
        assert_eq!(git(&root, &["status", "--porcelain"]), "");
    }

    #[cfg(unix)]
    #[test]
    fn a_sandboxed_mission_gets_copies_but_no_links() {
        let (_tmp, root, wt) = repo("node_modules\n.env\n");
        let spec = ShareSpec { link: vec!["node_modules".into()], copy: vec![".env".into()] };
        let out = apply(&root, &wt, &spec, true);
        assert!(out.linked.is_empty());
        assert_eq!(out.copied, vec![".env".to_string()]);
        assert_eq!(out.skipped, vec!["node_modules: not linked in a sandboxed mission".to_string()]);
        assert!(std::fs::symlink_metadata(wt.join("node_modules")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unlink_removes_only_the_links_to_the_main_checkout() {
        let (_tmp, root, wt) = repo("node_modules\n.venv\n.env\n");
        let spec = ShareSpec { link: vec!["node_modules".into()], copy: vec![".env".into()] };
        assert_eq!(apply(&root, &wt, &spec, false).linked, vec!["node_modules".to_string()]);
        // A `.venv` linked somewhere else is the user's, not ours.
        let elsewhere = root.parent().unwrap().join("other-venv");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, wt.join(".venv")).unwrap();
        assert_eq!(unlink(&root, &wt), vec!["node_modules".to_string()]);
        assert!(std::fs::symlink_metadata(wt.join("node_modules")).is_err());
        assert!(root.join("node_modules/left-pad/index.js").exists(), "the main checkout's folder stays");
        assert!(std::fs::symlink_metadata(wt.join(".venv")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "SECRET=1\n");
        // A real folder of that name is never removed, nor the main checkout's own.
        std::fs::create_dir(wt.join("node_modules")).unwrap();
        assert!(unlink(&root, &wt).is_empty());
        assert!(wt.join("node_modules").is_dir());
        assert!(unlink(&root, &root).is_empty());
        assert!(root.join("node_modules").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn an_env_file_this_branch_doesnt_ignore_is_removed_again() {
        // This branch's `.gitignore` doesn't cover `.env`: a copy would show
        // as untracked and could stage, so it must not stay behind.
        let (_tmp, root, wt) = repo("node_modules\n");
        let spec = ShareSpec { link: vec![], copy: vec![".env".into()] };
        let out = apply(&root, &wt, &spec, false);
        assert!(out.copied.is_empty());
        assert_eq!(out.skipped, vec![".env: removed, this branch doesn't git-ignore it".to_string()]);
        assert!(!wt.join(".env").exists());
    }

    #[cfg(unix)]
    #[test]
    fn apply_never_replaces_what_the_worktree_has_or_names_outside_paths() {
        let (_tmp, root, wt) = repo("node_modules\n.env\n");
        std::fs::write(wt.join(".env"), "MINE=1\n").unwrap();
        let spec = ShareSpec { link: vec!["target".into()], copy: vec![".env".into(), "../.env".into()] };
        let out = apply(&root, &wt, &spec, false);
        assert!(out.linked.is_empty() && out.copied.is_empty());
        assert_eq!(out.skipped, vec![".env: already in the worktree".to_string()]);
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "MINE=1\n");
        assert!(std::fs::symlink_metadata(wt.join("target")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_env_file_is_neither_offered_nor_copied() {
        let (_tmp, root, wt) = repo(".env*\n");
        let outside = root.parent().unwrap().join("secret");
        std::fs::write(&outside, "X=1\n").unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".env.local")).unwrap();
        assert!(!candidates(&root).copy.contains(&".env.local".to_string()));
        let out = apply(&root, &wt, &ShareSpec { link: vec![], copy: vec![".env.local".into()] }, false);
        assert!(out.copied.is_empty());
        assert!(!wt.join(".env.local").exists());
    }
}
