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
//! **A sandboxed mission gets nothing.** A link points outside the worktree:
//! Seatbelt would refuse writes through it but Claude Code's read guard
//! (`cli_runner::CLAUDE_SANDBOXED_STAGE_SETTINGS`) would refuse reads through
//! it too, and widening either for a shared folder isn't worth it. An env
//! file is not copied either: a sandboxed stage can't read outside its
//! working directory, and a copy would put the file inside it. Both are
//! reported as left out. A mission whose Execution later becomes `sandbox`
//! loses what it was given ([`unshare`]): its links, and each copy that is
//! still identical to the main checkout's file (one edited in the mission is
//! kept and reported, never deleted).
//!
//! **Only what Octopush made is ever removed.** [`apply`] records the links
//! and copies it made in the worktree's own git directory
//! ([`RECORD_FILE`], outside the working tree, gone with the worktree), and
//! [`unshare`] touches nothing that isn't in that record.
//!
//! Only a freshly created worktree is touched (like the setup script), and
//! nothing already in the worktree is replaced. Only the app's own "new
//! mission" path shares: a Routine's fresh worktree and a workspace created
//! through `octopush-mcp` do not (they call `workspace::create` directly and
//! never reach [`apply`]).

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

/// The dependency folders a mission may link. Never a build output.
pub const LINK_CANDIDATES: &[&str] = &["node_modules", ".venv", "venv"];

/// The marker line above the names Octopush adds to `info/exclude`.
pub const EXCLUDE_MARKER: &str = "# Octopush: folders linked into new missions (#961)";

/// Where [`apply`] records what it made, inside the worktree's own git
/// directory (`.git/worktrees/<name>/`): one `link<TAB>name` or
/// `copy<TAB>name` per line.
pub const RECORD_FILE: &str = "octopush-shared";

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

/// Replace `path` with `text` in one step: the text is written to a sibling
/// file and renamed over it, so a reader (git, another mission being
/// created) never sees a half-written file.
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    // A linked file is rewritten where it really lives, not replaced.
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{name}.octopush-{}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Make sure the repo's local `info/exclude` ignores each linked name as a
/// path (a `name/` rule never matches a symlink).
fn exclude_links(worktree: &Path, names: &[String]) {
    let Some(common) = common_git_dir(worktree) else { return };
    let path = common.join("info").join("exclude");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if let Some(text) = exclude_with(&existing, names) {
        let _ = std::fs::create_dir_all(common.join("info"));
        if let Err(e) = write_atomic(&path, &text) {
            tracing::warn!(error = %e, "share: couldn't update info/exclude");
        }
    }
}

/// The worktree's own git directory (`.git/worktrees/<name>` for a linked
/// worktree).
fn own_git_dir(worktree: &Path) -> Option<std::path::PathBuf> {
    let out = Command::new("git")
        .args(["rev-parse", "--absolute-git-dir"])
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

/// The text of a record: `link<TAB>name` / `copy<TAB>name` lines. Pure.
pub fn record_text(made: &ShareSpec) -> String {
    let mut text = String::new();
    for (kind, names) in [("link", &made.link), ("copy", &made.copy)] {
        for name in names {
            text.push_str(&format!("{kind}\t{name}\n"));
        }
    }
    text
}

/// Read a record leniently: unknown lines are dropped, and every name goes
/// through the same allowlist as a stored spec. Pure.
pub fn parse_record(text: &str) -> ShareSpec {
    let mut made = ShareSpec::default();
    for line in text.lines() {
        match line.split_once('\t') {
            Some(("link", name)) => made.link.push(name.to_string()),
            Some(("copy", name)) => made.copy.push(name.to_string()),
            _ => {}
        }
    }
    made.sanitized()
}

/// What [`apply`] made in `worktree` and hasn't been removed since.
pub fn recorded(worktree: &Path) -> ShareSpec {
    own_git_dir(worktree)
        .and_then(|dir| std::fs::read_to_string(dir.join(RECORD_FILE)).ok())
        .map(|text| parse_record(&text))
        .unwrap_or_default()
}

/// Remember `made` as what Octopush created in `worktree` (nothing: no file).
fn record(worktree: &Path, made: &ShareSpec) -> std::io::Result<()> {
    let dir = own_git_dir(worktree).ok_or_else(|| std::io::Error::other("no git directory"))?;
    let path = dir.join(RECORD_FILE);
    if made.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    write_atomic(&path, &record_text(made))
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
/// (`sandboxed`: the mission's own exec isolation is `sandbox`, so nothing
/// is shared). Never fails the mission: each entry that can't be shared is
/// reported in [`ShareOutcome::skipped`]. An entry is applied only while
/// the main checkout still git-ignores it: the list was saved earlier, and
/// the repo's rules may have changed since.
pub fn apply(root: &Path, worktree: &Path, spec: &ShareSpec, sandboxed: bool) -> ShareOutcome {
    let spec = spec.sanitized();
    let mut out = ShareOutcome::default();
    for name in &spec.link {
        let (src, dest) = (root.join(name), worktree.join(name));
        if sandboxed {
            out.skipped.push(format!("{name}: not linked in a sandboxed mission"));
        } else if !src.is_dir() {
            out.skipped.push(format!("{name}: not in the main checkout"));
        } else if !git_ignores(root, name) {
            out.skipped.push(format!("{name}: no longer git-ignored in the main checkout"));
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
        if sandboxed {
            out.skipped.push(format!("{name}: not copied into a sandboxed mission"));
        } else if std::fs::symlink_metadata(&src).is_err() {
            out.skipped.push(format!("{name}: not in the main checkout"));
        } else if !git_ignores(root, name) {
            out.skipped.push(format!("{name}: no longer git-ignored in the main checkout"));
        } else if std::fs::symlink_metadata(&dest).is_ok() {
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
    // Remember what was made, so only that can ever be removed again.
    let made = ShareSpec { link: out.linked.clone(), copy: out.copied.clone() };
    if !made.is_empty() {
        if let Err(e) = record(worktree, &made) {
            tracing::warn!(error = %e, "share: couldn't record what was shared");
        }
    }
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

/// Whether `a` and `b` are the same folder, however each path is spelled
/// (a symlinked parent, `..`, a trailing slash).
pub(crate) fn same_dir(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (std::fs::canonicalize(a), std::fs::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
}

/// Whether two regular files hold the same bytes (links not followed).
fn same_file_content(a: &Path, b: &Path) -> bool {
    let regular = |p: &Path| std::fs::symlink_metadata(p).map(|m| m.is_file()).unwrap_or(false);
    if !regular(a) || !regular(b) {
        return false;
    }
    matches!((std::fs::read(a), std::fs::read(b)), (Ok(x), Ok(y)) if x == y)
}

/// What [`unshare`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unshared {
    /// Links removed.
    pub unlinked: Vec<String>,
    /// Copied env files removed (still identical to the main checkout's).
    pub uncopied: Vec<String>,
    /// Copied env files left in place because they changed in the mission.
    pub kept: Vec<String>,
}

impl Unshared {
    pub fn is_empty(&self) -> bool {
        self.unlinked.is_empty() && self.uncopied.is_empty() && self.kept.is_empty()
    }
}

/// Take back what [`apply`] gave `worktree`, for a mission whose Execution
/// became `sandbox`. Only entries in the worktree's record are considered:
/// - a recorded link that is still a symlink to the main checkout `root`'s
///   folder of the same name is removed (the link, never the folder);
/// - a recorded copy that is still byte-identical to the main checkout's
///   file is removed; one that changed in the mission is kept and reported.
///
/// A real folder, a link the user made, a file Octopush didn't copy and the
/// main checkout itself are all left alone.
pub fn unshare(root: &Path, worktree: &Path) -> Unshared {
    let mut done = Unshared::default();
    if same_dir(root, worktree) {
        return done;
    }
    let made = recorded(worktree);
    if made.is_empty() {
        return done;
    }
    let mut left = ShareSpec::default();
    for name in &made.link {
        let (src, dest) = (root.join(name), worktree.join(name));
        if !links_to(&dest, &src) {
            // Replaced or already gone: no longer ours.
            continue;
        }
        match std::fs::remove_file(&dest) {
            Ok(()) => done.unlinked.push(name.clone()),
            Err(e) => {
                tracing::warn!(error = %e, name = %name, "share: couldn't remove a link");
                left.link.push(name.clone());
            }
        }
    }
    for name in &made.copy {
        let (src, dest) = (root.join(name), worktree.join(name));
        if std::fs::symlink_metadata(&dest).is_err() {
            continue;
        }
        if same_file_content(&src, &dest) && std::fs::remove_file(&dest).is_ok() {
            done.uncopied.push(name.clone());
        } else {
            done.kept.push(name.clone());
            left.copy.push(name.clone());
        }
    }
    if let Err(e) = record(worktree, &left) {
        tracing::warn!(error = %e, "share: couldn't update the record");
    }
    done
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
    fn a_sandboxed_mission_gets_neither_links_nor_env_copies() {
        let (_tmp, root, wt) = repo("node_modules\n.env\n");
        let spec = ShareSpec { link: vec!["node_modules".into()], copy: vec![".env".into()] };
        let out = apply(&root, &wt, &spec, true);
        assert!(out.linked.is_empty());
        assert!(out.copied.is_empty());
        assert_eq!(
            out.skipped,
            vec![
                "node_modules: not linked in a sandboxed mission".to_string(),
                ".env: not copied into a sandboxed mission".to_string(),
            ]
        );
        assert!(std::fs::symlink_metadata(wt.join("node_modules")).is_err());
        assert!(std::fs::symlink_metadata(wt.join(".env")).is_err(), "no env file inside a sandboxed worktree");
        assert_eq!(recorded(&wt), ShareSpec::default());
    }

    /// Decided on #1019: only the app's own new-mission path shares. A
    /// Routine's fresh worktree and an `octopush-mcp` workspace create their
    /// worktree directly and must never reach this module.
    #[test]
    fn routines_and_mcp_workspaces_do_not_share() {
        for (file, src) in [
            ("routines.rs", include_str!("routines.rs")),
            ("bin/octopush-mcp/tools.rs", include_str!("bin/octopush-mcp/tools.rs")),
        ] {
            for name in ["worktree_share", "share_into_fresh_worktree", "get_project_share"] {
                assert!(!src.contains(name), "{file} must not reference {name}");
            }
        }
    }

    #[test]
    fn a_record_round_trips_and_is_read_through_the_allowlist() {
        let made = ShareSpec { link: vec!["node_modules".into(), ".venv".into()], copy: vec![".env".into()] };
        let text = record_text(&made);
        assert_eq!(text, "link\tnode_modules\nlink\t.venv\ncopy\t.env\n");
        assert_eq!(parse_record(&text), made);
        let odd = "link\ttarget\nlink\t../x\ncopy\t../.ssh/id_rsa\nnoise\nlink\tnode_modules\ncopy\t.env.local\n";
        assert_eq!(
            parse_record(odd),
            ShareSpec { link: vec!["node_modules".into()], copy: vec![".env.local".into()] }
        );
        assert_eq!(parse_record(""), ShareSpec::default());
    }

    #[cfg(unix)]
    #[test]
    fn apply_records_what_it_made_outside_the_working_tree() {
        let (_tmp, root, wt) = repo("node_modules\n.env\n");
        let spec = ShareSpec { link: vec!["node_modules".into(), ".venv".into()], copy: vec![".env".into()] };
        let out = apply(&root, &wt, &spec, false);
        assert_eq!(out.skipped, vec![".venv: not in the main checkout".to_string()]);
        assert_eq!(recorded(&wt), ShareSpec { link: vec!["node_modules".into()], copy: vec![".env".into()] });
        assert!(!wt.join(RECORD_FILE).exists(), "the record is not a file in the working tree");
        assert_eq!(git(&wt, &["status", "--porcelain", "--untracked-files=all"]), "");
        assert_eq!(recorded(&root), ShareSpec::default(), "the main checkout has no record");
    }

    #[cfg(unix)]
    #[test]
    fn an_entry_the_main_checkout_no_longer_ignores_is_not_shared() {
        let (_tmp, root, wt) = repo("node_modules\n.env\n");
        // The saved list is older than the repo's rules: both entries have
        // stopped being ignored in the main checkout.
        std::fs::write(root.join(".gitignore"), "").unwrap();
        let spec = ShareSpec { link: vec!["node_modules".into()], copy: vec![".env".into()] };
        let out = apply(&root, &wt, &spec, false);
        assert!(out.linked.is_empty() && out.copied.is_empty());
        assert_eq!(
            out.skipped,
            vec![
                "node_modules: no longer git-ignored in the main checkout".to_string(),
                ".env: no longer git-ignored in the main checkout".to_string(),
            ]
        );
        assert!(std::fs::symlink_metadata(wt.join("node_modules")).is_err());
        assert!(!wt.join(".env").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_exclude_file_is_replaced_in_one_step() {
        let (_tmp, root, wt) = repo("node_modules/\n");
        let exclude = root.join(".git/info/exclude");
        std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        std::fs::write(&exclude, "*.swp\n").unwrap();
        let out = apply(&root, &wt, &ShareSpec { link: vec!["node_modules".into()], copy: vec![] }, false);
        assert_eq!(out.linked, vec!["node_modules".to_string()]);
        assert_eq!(
            std::fs::read_to_string(&exclude).unwrap(),
            format!("*.swp\n{EXCLUDE_MARKER}\n/node_modules\n")
        );
        let stray: Vec<String> = std::fs::read_dir(exclude.parent().unwrap())
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(stray.is_empty(), "no temporary file is left behind: {stray:?}");
    }

    #[cfg(unix)]
    #[test]
    fn unshare_removes_only_the_links_octopush_made() {
        let (_tmp, root, wt) = repo("node_modules\n.venv\nvenv\n.env\n");
        std::fs::create_dir(root.join("venv")).unwrap();
        let spec = ShareSpec { link: vec!["node_modules".into()], copy: vec![] };
        assert_eq!(apply(&root, &wt, &spec, false).linked, vec!["node_modules".to_string()]);
        // A `.venv` linked somewhere else is the user's, not ours.
        let elsewhere = root.parent().unwrap().join("other-venv");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, wt.join(".venv")).unwrap();
        // So is a link the user made themselves, even to the main checkout's
        // own folder: it is not in the record.
        std::os::unix::fs::symlink(root.join("venv"), wt.join("venv")).unwrap();

        let done = unshare(&root, &wt);
        assert_eq!(done.unlinked, vec!["node_modules".to_string()]);
        assert!(done.uncopied.is_empty() && done.kept.is_empty());
        assert!(std::fs::symlink_metadata(wt.join("node_modules")).is_err());
        assert!(root.join("node_modules/left-pad/index.js").exists(), "the main checkout's folder stays");
        assert!(std::fs::symlink_metadata(wt.join(".venv")).unwrap().file_type().is_symlink());
        assert!(std::fs::symlink_metadata(wt.join("venv")).unwrap().file_type().is_symlink());
        assert_eq!(recorded(&wt), ShareSpec::default(), "nothing is left on record");

        // A real folder of that name is never removed, and a second pass
        // finds nothing to do.
        std::fs::create_dir(wt.join("node_modules")).unwrap();
        assert!(unshare(&root, &wt).is_empty());
        assert!(wt.join("node_modules").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn unshare_never_touches_the_main_checkout_however_its_path_is_spelled() {
        let (_tmp, root, wt) = repo("node_modules\n.env\n");
        let spec = ShareSpec { link: vec!["node_modules".into()], copy: vec![".env".into()] };
        apply(&root, &wt, &spec, false);
        // The same folder through a symlinked parent, `..` and a trailing slash.
        let alias = root.parent().unwrap().join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let dotted = wt.join("..").join("repo");
        let slashed = std::path::PathBuf::from(format!("{}/", root.display()));
        for spelled in [&root, &alias, &dotted, &slashed] {
            assert!(unshare(&root, spelled).is_empty(), "{spelled:?}");
            assert!(unshare(spelled, &root).is_empty(), "{spelled:?}");
        }
        assert!(root.join("node_modules/left-pad/index.js").exists());
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), "SECRET=1\n");
        // Reached through the alias, the worktree's own link still goes.
        assert_eq!(unshare(&alias, &wt).unlinked, vec!["node_modules".to_string()]);
        assert!(root.join("node_modules").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn unshare_removes_an_untouched_env_copy_and_keeps_an_edited_one() {
        let (_tmp, root, wt) = repo(".env*\n");
        std::fs::write(root.join(".env.local"), "LOCAL=1\n").unwrap();
        let spec = ShareSpec { link: vec![], copy: vec![".env".into(), ".env.local".into()] };
        assert_eq!(apply(&root, &wt, &spec, false).copied.len(), 2);
        // One copy is edited in the mission; a third file is the user's own.
        std::fs::write(wt.join(".env.local"), "LOCAL=mission\n").unwrap();
        std::fs::write(wt.join(".env.test"), "MINE=1\n").unwrap();

        let done = unshare(&root, &wt);
        assert_eq!(done.uncopied, vec![".env".to_string()]);
        assert_eq!(done.kept, vec![".env.local".to_string()]);
        assert!(!wt.join(".env").exists());
        assert_eq!(std::fs::read_to_string(wt.join(".env.local")).unwrap(), "LOCAL=mission\n");
        assert_eq!(std::fs::read_to_string(wt.join(".env.test")).unwrap(), "MINE=1\n");
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), "SECRET=1\n", "the source stays");
        assert_eq!(recorded(&wt), ShareSpec { link: vec![], copy: vec![".env.local".into()] });
    }

    #[cfg(unix)]
    #[test]
    fn an_env_file_this_branch_doesnt_ignore_is_removed_again() {
        // This branch's `.gitignore` doesn't cover `.env`: a copy would show
        // as untracked and could stage, so it must not stay behind.
        let (_tmp, root, wt) = repo("node_modules\n");
        // The main checkout ignores it (an uncommitted rule); the branch doesn't.
        std::fs::write(root.join(".gitignore"), "node_modules\n.env\n").unwrap();
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
