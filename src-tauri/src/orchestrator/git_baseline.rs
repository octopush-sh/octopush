//! Per-stage worktree baselines for DIRECT mode "Discard changes".
//!
//! Stages never commit (they hand the worktree to the next stage), so to revert
//! ONLY a failed stage's edits we snapshot the worktree at the stage's start as
//! a dangling commit — captured through a TEMPORARY index so the user's real
//! git index is never disturbed — and later make the worktree byte-identical to
//! that snapshot's tree.

use crate::error::{AppError, AppResult};
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

fn git(ws: &Path, index: Option<&Path>, args: &[&str]) -> AppResult<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(ws);
    if let Some(idx) = index {
        cmd.env("GIT_INDEX_FILE", idx);
    }
    cmd.output().map_err(|e| AppError::Other(format!("git {args:?}: {e}")))
}

fn ok(out: &std::process::Output, what: &str) -> AppResult<()> {
    if out.status.success() { Ok(()) }
    else { Err(AppError::Other(format!("{what}: {}", String::from_utf8_lossy(&out.stderr)))) }
}

fn temp_index(ws: &Path) -> std::path::PathBuf {
    // Use a hash of the workspace path so concurrent calls from different
    // worktrees (or tests) never share the same temp index file.
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    ws.hash(&mut h);
    std::process::id().hash(&mut h);
    let key = <std::collections::hash_map::DefaultHasher as Hasher>::finish(&h);
    std::env::temp_dir().join(format!("octopush-idx-{key:x}"))
}

/// Snapshot the current worktree (tracked + newly-added, honoring .gitignore) as
/// a dangling commit and return its SHA. `Ok(None)` when there's no HEAD / not a
/// repo — the caller treats baseline as unavailable (Discard is then hidden).
pub fn capture_baseline(ws: &Path) -> AppResult<Option<String>> {
    let head = git(ws, None, &["rev-parse", "HEAD"])?;
    if !head.status.success() {
        return Ok(None);
    }
    let head_sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
    let idx = temp_index(ws);
    let _ = std::fs::remove_file(&idx);
    ok(&git(ws, Some(&idx), &["read-tree", &head_sha])?, "read-tree HEAD")?;
    ok(&git(ws, Some(&idx), &["add", "-A"])?, "add -A")?;
    let tree_out = git(ws, Some(&idx), &["write-tree"])?;
    ok(&tree_out, "write-tree")?;
    let tree = String::from_utf8_lossy(&tree_out.stdout).trim().to_string();
    let commit_out = git(ws, None, &["commit-tree", &tree, "-p", &head_sha, "-m", "octopush stage baseline"])?;
    ok(&commit_out, "commit-tree")?;
    let _ = std::fs::remove_file(&idx);
    Ok(Some(String::from_utf8_lossy(&commit_out.stdout).trim().to_string()))
}

/// Make the worktree byte-identical to `baseline`'s tree: restore every file the
/// baseline contains, remove every file it does not (i.e. created during the
/// stage). Never touches the user's real index.
pub fn restore_baseline(ws: &Path, baseline: &str) -> AppResult<()> {
    let ls = git(ws, None, &["ls-tree", "-r", "--name-only", baseline])?;
    ok(&ls, "ls-tree baseline")?;
    let in_baseline: HashSet<String> =
        String::from_utf8_lossy(&ls.stdout).lines().map(str::to_string).collect();

    let idx = temp_index(ws);
    let _ = std::fs::remove_file(&idx);
    ok(&git(ws, Some(&idx), &["read-tree", baseline])?, "read-tree baseline")?;
    ok(&git(ws, Some(&idx), &["checkout-index", "-a", "-f"])?, "checkout-index")?;
    let _ = std::fs::remove_file(&idx);

    let tracked = git(ws, None, &["ls-files"])?;
    ok(&tracked, "ls-files")?;
    let untracked = git(ws, None, &["ls-files", "--others", "--exclude-standard"])?;
    ok(&untracked, "ls-files --others")?;
    let mut current: HashSet<String> = HashSet::new();
    for src in [&tracked.stdout, &untracked.stdout] {
        for f in String::from_utf8_lossy(src).lines() {
            current.insert(f.to_string());
        }
    }

    for f in current.difference(&in_baseline) {
        let p = ws.join(f);
        let _ = std::fs::remove_file(&p);
        let mut parent = p.parent();
        while let Some(dir) = parent {
            if dir == ws { break; }
            if std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = std::fs::remove_dir(dir);
                parent = dir.parent();
            } else { break; }
        }
    }
    Ok(())
}
