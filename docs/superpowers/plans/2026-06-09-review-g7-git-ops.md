# G7 · Git Operations Depth — Slice I Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminal-free fetch/pull from Review, plus conflict detection and the two reliability fixes (ahead/behind timeout, per-workspace git lock).

**Architecture:** New git2/string helpers in `git_ops.rs` (`classify_pull`, conflict flag, a `status_files`/`ahead_behind` split); `fetch_changes`/`pull` Tauri commands via the login shell (like `push_branch`); a `git_lock.rs` per-workspace async mutex; the ahead/behind graph walk moved behind a `spawn_blocking` + 3 s timeout at the command layer; and a sync control + reconcile dialog + conflict banner in `ChangesPanel`.

**Tech Stack:** Rust (Tauri 2, git2, tokio), React 19 + TypeScript, Vitest + Testing Library, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-09-review-g7-git-ops-design.md`

**Branch:** `feat/review-g7-git` (worktree `octopus-sh-review`, off `main`).

---

## File structure

| File | Responsibility | Task |
|------|----------------|------|
| `src-tauri/src/git_ops.rs` *(modify)* | `PullKind`/`PullOutcome`/`classify_pull`; `conflicted` on `FileChange`/`GitStatus`; `status_files` + `ahead_behind` split; `get_status` refactor | 1 |
| `src-tauri/src/git_lock.rs` *(new)* | per-workspace async mutex map | 2 |
| `src-tauri/src/commands.rs` *(modify)* | `fetch_changes`/`pull`; ahead/behind timeout; lock around commit/amend; `run_with_timeout` helper | 3 |
| `src-tauri/src/lib.rs` *(modify)* | `mod git_lock;` + register `fetch_changes`/`pull` | 3 |
| `src-tauri/src/tests.rs` *(modify)* | conflict-detection + timeout + git_lock tests | 1, 3 |
| `src/lib/types.ts` *(modify)* | `GitStatus`/`FileChange` add `conflicted` + `aheadBehindKnown` | 4 |
| `src/lib/ipc.ts` *(modify)* | `fetchChanges`/`pull` + `PullOutcome` type | 4 |
| `src/components/ChangesPanel.tsx` *(modify)* + test | sync control, reconcile dialog, conflict banner | 5 |

> **Reuse, don't recreate** (verified): `git_ops::get_status` (git2 status), `commands::
> push_branch` (login-shell network op, `commands.rs:2526`), `get_git_status` (577),
> `workspaces_git_summary` (595), `pushToast`, `ModalShell`, `ConfirmDialog`.

> **tokio features:** the lock holds across an `.await`, so it must be `tokio::sync::Mutex`
> (not parking_lot). If `cargo build` errors that `tokio::sync` / `spawn_blocking` /
> `time::timeout` aren't available, add the missing tokio features (`sync`, `rt`, `time`,
> `macros`) to `src-tauri/Cargo.toml`'s tokio dependency. (Tauri usually enables them.)

---

## Task 1: git_ops — pull classifier, conflict flag, status split

**Files:**
- Modify: `src-tauri/src/git_ops.rs`
- Modify: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing tests**

In `git_ops.rs`'s `#[cfg(test)] mod tests`, add (pure classifier):

```rust
    #[test]
    fn classify_pull_distinguishes_outcomes() {
        use super::{classify_pull, PullKind};
        assert_eq!(classify_pull(true, "Already up to date."), PullKind::Ok);
        assert_eq!(classify_pull(false, "fatal: Not possible to fast-forward, aborting."), PullKind::Diverged);
        assert_eq!(classify_pull(false, "hint: You have divergent branches"), PullKind::Diverged);
        assert_eq!(classify_pull(false, "CONFLICT (content): Merge conflict in a.txt"), PullKind::Conflict);
        assert_eq!(classify_pull(false, "error: Automatic merge failed"), PullKind::Conflict);
        assert_eq!(classify_pull(false, "fatal: couldn't find remote ref"), PullKind::Error);
    }
```

In `src-tauri/src/tests.rs`, add a module that builds a real conflict via the `git` CLI and
asserts `get_status` reports it (mirrors the existing `g4_staging_tests` git-CLI pattern):

```rust
#[cfg(test)]
mod g7_git_tests {
    use crate::git_ops::get_status;
    use std::process::Command;
    use tempfile::tempdir;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git").args(args).current_dir(dir).status().unwrap().success();
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn get_status_reports_conflicted_files() {
        let dir = tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q"]);
        git(p, &["config", "user.email", "t@t.dev"]);
        git(p, &["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "base"]);
        // branch B: change a.txt
        git(p, &["checkout", "-qb", "feature"]);
        std::fs::write(p.join("a.txt"), "feature\n").unwrap();
        git(p, &["commit", "-qam", "feature"]);
        // back to the base branch (portable: `-` = previous branch, no name assumption)
        git(p, &["checkout", "-q", "-"]);
        std::fs::write(p.join("a.txt"), "main\n").unwrap();
        git(p, &["commit", "-qam", "main"]);
        // merge feature → conflict (ignore the non-zero exit)
        let _ = Command::new("git").args(["merge", "feature"]).current_dir(p).output().unwrap();

        let st = get_status(p).unwrap();
        assert!(st.conflicted >= 1, "expected a conflicted file, got {}", st.conflicted);
        assert!(st.changed_files.iter().any(|f| f.path == "a.txt" && f.conflicted),
            "a.txt should be marked conflicted");
    }
}
```

> `checkout -q -` returns to the previous branch (the base you were on before
> `checkout -b feature`), so the test works whether `git init`'s default is `master` or
> `main` — no branch-name assumption.

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review/src-tauri && cargo test classify_pull get_status_reports_conflicted 2>&1 | tail -20`
Expected: compile error — `classify_pull`/`PullKind` not found; `GitStatus.conflicted`/`FileChange.conflicted` not found.

- [ ] **Step 3: Implement in `git_ops.rs`**

Add the `conflicted` fields. Replace the `GitStatus`/`FileChange` structs (lines 8-30) with:

```rust
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub changed_files: Vec<FileChange>,
    pub ahead: usize,
    pub behind: usize,
    pub has_upstream: bool,
    /// Count of files with an unresolved merge conflict.
    pub conflicted: usize,
    /// False when ahead/behind couldn't be computed in time (huge-graph timeout);
    /// the UI hides the ↑/↓ badge rather than showing a misleading 0.
    pub ahead_behind_known: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    /// The file is in an unresolved merge-conflict (unmerged index) state.
    pub conflicted: bool,
}
```

Add the pull classifier near the top of the file (after the structs):

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome { pub kind: PullKind, pub output: String }

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PullKind { Ok, Diverged, Conflict, Error }

/// Classify a `git pull` result from its exit success + combined output. Pure.
pub fn classify_pull(success: bool, combined: &str) -> PullKind {
    let s = combined.to_lowercase();
    if success {
        PullKind::Ok
    } else if s.contains("not possible to fast-forward") || s.contains("divergent") || s.contains("have diverged") {
        PullKind::Diverged
    } else if s.contains("conflict") || s.contains("automatic merge failed") || s.contains("could not apply") {
        PullKind::Conflict
    } else {
        PullKind::Error
    }
}
```

Now refactor `get_status` into a fast `status_files` + a standalone `ahead_behind`, and keep
`get_status` as the fully-computed convenience (used by tests + non-command callers).
Replace the current `get_status` (150-185) with:

```rust
/// Branch + changed files (incl. conflict flag) + cheap has_upstream. Does NOT do the
/// (potentially slow) ahead/behind graph walk — that's `ahead_behind`, timed at the
/// command layer.
pub fn status_files(path: &Path) -> AppResult<GitStatus> {
    let repo = open_repo(path)?;
    let branch = current_branch(&repo);
    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    let statuses = repo.statuses(Some(&mut opts))
        .map_err(|e| AppError::Other(format!("git status: {e}")))?;
    let changed_files: Vec<FileChange> = statuses.iter().map(|entry| {
        let path = entry.path().unwrap_or("").to_string();
        let st = entry.status();
        let conflicted = st.is_conflicted();
        let staged =
            st.is_index_new() || st.is_index_modified() || st.is_index_deleted()
            || st.is_index_renamed() || st.is_index_typechange();
        let unstaged =
            st.is_wt_new() || st.is_wt_modified() || st.is_wt_deleted()
            || st.is_wt_renamed() || st.is_wt_typechange();
        let status = if conflicted { "conflicted" }
            else if st.is_index_new() || st.is_wt_new() { "new" }
            else if st.is_index_modified() || st.is_wt_modified() { "modified" }
            else if st.is_index_deleted() || st.is_wt_deleted() { "deleted" }
            else if st.is_index_renamed() || st.is_wt_renamed() { "renamed" }
            else { "unknown" };
        FileChange { path, status: status.to_string(), staged, unstaged, conflicted }
    }).collect();
    let conflicted = changed_files.iter().filter(|f| f.conflicted).count();
    // Cheap upstream presence check (no graph walk).
    let has_upstream = repo
        .head().ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .and_then(|name| repo.find_branch(&name, git2::BranchType::Local).ok())
        .map(|b| b.upstream().is_ok())
        .unwrap_or(false);
    Ok(GitStatus {
        branch, changed_files, ahead: 0, behind: 0, has_upstream, conflicted,
        ahead_behind_known: false,
    })
}

/// Ahead/behind vs the upstream (the slow graph walk). None if no upstream / can't compute.
pub fn ahead_behind(path: &Path) -> Option<(usize, usize)> {
    let repo = open_repo(path).ok()?;
    upstream_ahead_behind(&repo)
}

/// Fully-computed status (files + ahead/behind), synchronous. Convenience for tests and
/// non-command callers; the Tauri command computes ahead/behind with a timeout instead.
pub fn get_status(path: &Path) -> AppResult<GitStatus> {
    let mut s = status_files(path)?;
    if let Some((a, b)) = ahead_behind(path) {
        s.ahead = a; s.behind = b;
    }
    s.ahead_behind_known = true;
    Ok(s)
}
```

> `current_branch`, `open_repo`, `upstream_ahead_behind`, `StatusOptions` are all already in
> scope in this file. Any other caller of `get_status` keeps working (same return type, now
> with two extra fields).

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test classify_pull get_status_reports_conflicted 2>&1 | tail -15`
Expected: both pass. Also `cargo build 2>&1 | tail -5` — fix any caller that constructs
`FileChange`/`GitStatus` literally (grep `FileChange {` / `GitStatus {` in `src-tauri/src/`;
add `conflicted`/`ahead_behind_known` where a literal is built — likely none besides these).

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review && git add src-tauri/src/git_ops.rs src-tauri/src/tests.rs && git commit -m "feat(g7): pull classifier + conflict detection + status_files/ahead_behind split"
```

---

## Task 2: git_lock — per-workspace async mutex

**Files:**
- Create: `src-tauri/src/git_lock.rs`
- Modify: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/tests.rs`:

```rust
#[cfg(test)]
mod git_lock_tests {
    use crate::git_lock::lock_for;
    use std::sync::Arc;

    #[test]
    fn same_path_shares_one_lock_distinct_paths_differ() {
        let a1 = lock_for("/repo/a");
        let a2 = lock_for("/repo/a");
        let b = lock_for("/repo/b");
        assert!(Arc::ptr_eq(&a1, &a2), "same path must share one mutex");
        assert!(!Arc::ptr_eq(&a1, &b), "distinct paths must have distinct mutexes");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review/src-tauri && cargo test git_lock_tests 2>&1 | tail -10`
Expected: compile error — `crate::git_lock` module not found.

- [ ] **Step 3: Implement `git_lock.rs`**

```rust
//! Per-workspace serialization for mutating git operations. Two commands on the
//! same worktree must not interleave (e.g. a pull racing a commit). Each path
//! gets its own async mutex; commands hold the guard for their duration.

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

static LOCKS: Lazy<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Get-or-insert the async mutex for `path` (does not lock it). Exposed for tests.
pub fn lock_for(path: &str) -> Arc<AsyncMutex<()>> {
    let mut map = LOCKS.lock().unwrap();
    map.entry(path.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// Acquire the per-workspace git lock; hold the returned guard across the operation.
pub async fn git_lock(path: &str) -> tokio::sync::OwnedMutexGuard<()> {
    lock_for(path).lock_owned().await
}
```

> Uses `once_cell::sync::Lazy`. If `once_cell` isn't a dependency, use
> `std::sync::OnceLock<Mutex<HashMap<...>>>` instead (std, no dep) — grep `once_cell` in
> `src-tauri/Cargo.toml` first; if absent, the OnceLock form is:
> `static LOCKS: std::sync::OnceLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
> std::sync::OnceLock::new();` and `LOCKS.get_or_init(|| Mutex::new(HashMap::new())).lock()`.

- [ ] **Step 4: Register the module + run the test**

In `src-tauri/src/lib.rs`, add `mod git_lock;` near the other `mod` declarations (top of the file).

Run: `cargo test git_lock_tests 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review && git add src-tauri/src/git_lock.rs src-tauri/src/lib.rs src-tauri/src/tests.rs && git commit -m "feat(g7): per-workspace git lock module"
```

---

## Task 3: commands — fetch/pull, ahead/behind timeout, lock wiring

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test (timeout helper)**

Append to `src-tauri/src/tests.rs`:

```rust
#[cfg(test)]
mod g7_timeout_tests {
    use crate::commands::run_with_timeout;
    use std::time::Duration;

    #[test]
    fn run_with_timeout_returns_value_when_fast_and_none_when_slow() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        // Fast closure → Some
        let fast = rt.block_on(run_with_timeout(Duration::from_millis(500), || 42));
        assert_eq!(fast, Some(42));
        // Slow closure → None (timed out)
        let slow = rt.block_on(run_with_timeout(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_millis(300));
            7
        }));
        assert_eq!(slow, None);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review/src-tauri && cargo test g7_timeout_tests 2>&1 | tail -10`
Expected: compile error — `run_with_timeout` not found. (If the runtime builder errors on
`enable_time`, the tokio `time` feature is missing — add it to Cargo.toml.)

- [ ] **Step 3: Implement in `commands.rs`**

Add the generic timeout helper (near the top of the file's command section):

```rust
/// Run a blocking closure with a wall-clock timeout. `None` on timeout (the closure keeps
/// running on the blocking pool but its result is dropped) — used to keep slow git2 graph
/// walks from hanging the UI.
pub async fn run_with_timeout<F, T>(dur: std::time::Duration, f: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    match tokio::time::timeout(dur, tokio::task::spawn_blocking(f)).await {
        Ok(Ok(v)) => Some(v),
        _ => None,
    }
}
```

Replace `get_git_status` (577-580) so files come fast and ahead/behind is timed:

```rust
#[tauri::command]
pub async fn get_git_status(path: String) -> AppResult<crate::git_ops::GitStatus> {
    let path = expand_tilde(&path);
    let mut status = crate::git_ops::status_files(std::path::Path::new(&path))?;
    let p = path.clone();
    match run_with_timeout(std::time::Duration::from_secs(3), move || {
        crate::git_ops::ahead_behind(std::path::Path::new(&p))
    }).await {
        Some(Some((a, b))) => { status.ahead = a; status.behind = b; status.ahead_behind_known = true; }
        _ => { status.ahead = 0; status.behind = 0; status.ahead_behind_known = false; }
    }
    Ok(status)
}
```

In `workspaces_git_summary` (595-619), replace the `dirty_ahead_behind` call (609-610) so
the ahead/behind part is timed (degrade to 0,0 on timeout; keep `dirty` fast):

```rust
        let dirty = crate::git_ops::is_dirty(path).unwrap_or(false);
        let wt = wt.clone();
        let (ahead, behind) = run_with_timeout(std::time::Duration::from_secs(3), move || {
            crate::git_ops::ahead_behind(std::path::Path::new(&wt))
        }).await.flatten().unwrap_or((0, 0));
```

Add `fetch_changes` and `pull` (login shell + lock). Place them near `push_branch`:

```rust
#[tauri::command]
pub async fn fetch_changes(workspace_path: String) -> AppResult<String> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg("git fetch 2>&1")
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git fetch: {e}")))?;
    let combined = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(AppError::Other(format!("git fetch failed: {combined}")));
    }
    Ok(combined)
}

#[tauri::command]
pub async fn pull(workspace_path: String, strategy: String) -> AppResult<crate::git_ops::PullOutcome> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    let flag = match strategy.as_str() {
        "ffOnly" => "--ff-only",
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        other => return Err(AppError::Other(format!("unknown pull strategy: {other}"))),
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let cmd = format!("git pull {flag} 2>&1");
    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg(&cmd)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git pull: {e}")))?;
    let combined = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let kind = crate::git_ops::classify_pull(output.status.success(), &combined);
    Ok(crate::git_ops::PullOutcome { kind, output: combined })
}
```

Wrap the two existing slow mutators with the lock: in `commit_changes` (2235) and
`amend_commit` (2917), add as the first line after `let workspace_path = expand_tilde(...)`:

```rust
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
```

- [ ] **Step 4: Register `fetch_changes` + `pull` in `lib.rs`**

In `tauri::generate_handler![...]`, near `commands::push_branch`, add:

```rust
            commands::fetch_changes,
            commands::pull,
```

- [ ] **Step 5: Tests + build**

Run: `cargo test g7_timeout_tests g7_git_tests git_lock_tests 2>&1 | tail -12`
Expected: all pass.

Run: `cargo build 2>&1 | tail -5`
Expected: builds. (fetch/pull network happy-paths are verified manually — login shell + creds.)

- [ ] **Step 6: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review && git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs && git commit -m "feat(g7): fetch/pull commands, ahead-behind timeout, lock around mutators"
```

---

## Task 4: types + ipc

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: Extend the TS types**

In `src/lib/types.ts`, update `GitStatus` and `FileChange`:

```ts
export interface GitStatus {
  branch: string | null;
  changedFiles: FileChange[];
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  /** Count of files with an unresolved merge conflict. */
  conflicted: number;
  /** False when ahead/behind timed out (huge graph); UI hides the ↑/↓ badge. */
  aheadBehindKnown: boolean;
}
export interface FileChange {
  path: string;
  status: "new" | "modified" | "deleted" | "renamed" | "unknown" | "conflicted";
  staged: boolean;
  unstaged: boolean;
  /** Unresolved merge-conflict (unmerged index) state. */
  conflicted: boolean;
}
```

- [ ] **Step 2: Add the ipc bindings**

In `src/lib/ipc.ts`, add a type near the top:

```ts
export type PullKind = "ok" | "diverged" | "conflict" | "error";
export interface PullOutcome { kind: PullKind; output: string }
```

In the ipc object, near `pushBranch`, add:

```ts
  fetchChanges: (workspacePath: string) => invoke<string>("fetch_changes", { workspacePath }),
  pull: (workspacePath: string, strategy: "ffOnly" | "rebase" | "merge") =>
    invoke<PullOutcome>("pull", { workspacePath, strategy }),
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review && npm run typecheck 2>&1 | tail -8`
Expected: this surfaces any code that builds a `GitStatus`/`FileChange` literal missing the
new required fields — most likely test mocks (`ChangesPanel.test.tsx`'s `STATUS` fixture and
any `FileChange` mock). Add `conflicted: 0`/`aheadBehindKnown: true` to `GitStatus` mocks and
`conflicted: false` to `FileChange` mocks. Re-run → clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/ipc.ts src/components/ChangesPanel.test.tsx && git commit -m "feat(g7): types + ipc for fetch/pull + conflict/aheadBehindKnown"
```

---

## Task 5: ChangesPanel — sync control, reconcile dialog, conflict banner

**Files:**
- Modify: `src/components/ChangesPanel.tsx`
- Modify: `src/components/ChangesPanel.test.tsx`

**Context:** `ChangesPanel` derives `staged`/`unstaged`/`ahead`/`hasUpstream` from `gitStatus`
(~lines 68-72), has a `refresh()` callback, a header eyebrow row (~160-174: "Changes" + +/−),
and a `FileRow` sub-component. `pushToast` + `ipc` imported. Add `behind`/`conflicted`/
`aheadBehindKnown` derivations, the sync control, the reconcile dialog, and the banner.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/ChangesPanel.test.tsx` (the `ipcMock` from Task-4's G4 tests already
mocks several ipc fns; ensure it includes `fetchChanges`, `pull`, and that `getGitStatus`
resolves a `GitStatus` with the new fields):

```tsx
  it("Pull (ff-only ok) calls ipc.pull and toasts", async () => {
    ipcMock.getGitStatus.mockResolvedValue({
      branch: "main", ahead: 0, behind: 2, hasUpstream: true,
      conflicted: 0, aheadBehindKnown: true, changedFiles: [],
    });
    ipcMock.pull.mockResolvedValue({ kind: "ok", output: "Updated." });
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByRole("button", { name: /pull/i });
    await userEvent.click(screen.getByRole("button", { name: /pull/i }));
    await waitFor(() => expect(ipcMock.pull).toHaveBeenCalledWith("/repo", "ffOnly"));
  });

  it("diverged pull opens the reconcile dialog and routes Rebase", async () => {
    ipcMock.getGitStatus.mockResolvedValue({
      branch: "main", ahead: 1, behind: 1, hasUpstream: true,
      conflicted: 0, aheadBehindKnown: true, changedFiles: [],
    });
    ipcMock.pull
      .mockResolvedValueOnce({ kind: "diverged", output: "Not possible to fast-forward" })
      .mockResolvedValueOnce({ kind: "ok", output: "Rebased." });
    render(<ChangesPanel projectPath="/repo" />);
    await userEvent.click(await screen.findByRole("button", { name: /pull/i }));
    await userEvent.click(await screen.findByRole("button", { name: /rebase/i }));
    await waitFor(() => expect(ipcMock.pull).toHaveBeenNthCalledWith(2, "/repo", "rebase"));
  });

  it("shows a conflict banner when conflicted > 0", async () => {
    ipcMock.getGitStatus.mockResolvedValue({
      branch: "main", ahead: 0, behind: 0, hasUpstream: true,
      conflicted: 2, aheadBehindKnown: true,
      changedFiles: [{ path: "a.ts", status: "conflicted", staged: false, unstaged: true, conflicted: true }],
    });
    render(<ChangesPanel projectPath="/repo" />);
    expect(await screen.findByText(/2 conflicts/i)).toBeInTheDocument();
  });

  it("hides the ahead/behind badge when aheadBehindKnown is false", async () => {
    ipcMock.getGitStatus.mockResolvedValue({
      branch: "main", ahead: 0, behind: 0, hasUpstream: true,
      conflicted: 0, aheadBehindKnown: false, changedFiles: [],
    });
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByText("main");
    expect(screen.queryByTestId("ahead-behind")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/ChangesPanel.test.tsx` → the 4 new tests fail (no sync control / banner).

- [ ] **Step 3: Implement in `ChangesPanel.tsx`**

Add derivations next to the others (~line 72):

```ts
  const behind = gitStatus?.behind ?? 0;
  const conflicted = gitStatus?.conflicted ?? 0;
  const aheadBehindKnown = gitStatus?.aheadBehindKnown ?? true;
  const branchName = gitStatus?.branch ?? null;
  const [reconcile, setReconcile] = useState(false);
  const [syncing, setSyncing] = useState(false);
```

Add `ModalShell` to the imports: `import { ModalShell } from "./ModalShell";`

Add the handlers (near `handleCommitOrAmend`):

```ts
  async function runPull(strategy: "ffOnly" | "rebase" | "merge") {
    setSyncing(true);
    try {
      const r = await ipc.pull(projectPath, strategy);
      if (r.kind === "ok") {
        pushToast({ level: "success", title: "Pulled", body: r.output.split("\n").slice(-1)[0] || undefined });
      } else if (r.kind === "diverged") {
        setReconcile(true);
      } else if (r.kind === "conflict") {
        pushToast({ level: "warning", title: "Merge conflicts", body: "Resolve the conflicted files." });
      } else {
        pushToast({ level: "error", title: "Pull failed", body: r.output });
      }
      await refresh();
      onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Pull failed", body: String(e) });
    } finally {
      setSyncing(false);
    }
  }

  async function handleFetch() {
    setSyncing(true);
    try {
      await ipc.fetchChanges(projectPath);
      pushToast({ level: "success", title: "Fetched" });
      await refresh(); onChange?.();
    } catch (e) {
      pushToast({ level: "error", title: "Fetch failed", body: String(e) });
    } finally {
      setSyncing(false);
    }
  }

  async function reconcileWith(strategy: "rebase" | "merge") {
    setReconcile(false);
    await runPull(strategy);
  }
```

In the header eyebrow row (after the `+N/−M` span, still inside the `<header>`), add the sync
control. Replace the `<header>` block (~160-174) with:

```tsx
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-octo-hairline px-4">
        <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Changes</span>
        {branchName && <span className="font-mono text-[10px] text-octo-sage">{branchName}</span>}
        {aheadBehindKnown && (ahead > 0 || behind > 0) && (
          <span data-testid="ahead-behind" className="font-mono text-[10px] text-octo-mute">
            {ahead > 0 && <span className="text-octo-brass">↑{ahead}</span>}
            {behind > 0 && <span className="ml-1 text-octo-sage">↓{behind}</span>}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button" onClick={handleFetch} disabled={syncing}
            aria-label="Fetch from remote"
            className="rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-octo-sage disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >Fetch</button>
          <button
            type="button" onClick={() => runPull("ffOnly")} disabled={syncing || behind === 0}
            aria-label="Pull from remote"
            className="rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-octo-brass disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            style={{ border: "1px solid var(--brass-dim)" }}
          >Pull</button>
        </span>
      </header>

      {conflicted > 0 && (
        <div className="shrink-0 border-b border-octo-hairline px-4 py-2 text-[11px] text-octo-rouge">
          {conflicted} conflict{conflicted !== 1 ? "s" : ""} — resolve them in your terminal for now; in-app resolution is coming next.
        </div>
      )}
```

> The original header showed `+N/−M` derived from the diff prop. Keep that span if present —
> append it before the `ml-auto` sync group (it can sit between the branch/badge and the
> Fetch/Pull buttons). If it's awkward, drop the +/− span (the file list already conveys
> changes); note which you did.

In `FileRow`, add a conflict glyph when `file.conflicted` (before the filename or as a status
badge): `{file.conflicted && <span className="font-mono text-[11px] text-octo-rouge" title="Merge conflict">!</span>}`.

Render the reconcile dialog near the discard `ConfirmDialog` (end of the component JSX):

```tsx
      {reconcile && (
        <ModalShell onClose={() => setReconcile(false)} ariaLabel="Reconcile diverged branch">
          <div className="p-5">
            <h2 className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">Diverged</h2>
            <p className="mb-4 text-[12px] text-octo-sage">
              Your branch and its upstream have diverged. Reconcile by:
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReconcile(false)}
                className="rounded px-3 py-1.5 text-[11px] text-octo-mute focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass">Cancel</button>
              <button type="button" onClick={() => reconcileWith("merge")}
                className="rounded px-3 py-1.5 text-[11px] text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass" style={{ border: "1px solid var(--brass-dim)" }}>Merge</button>
              <button type="button" onClick={() => reconcileWith("rebase")}
                className="rounded px-3 py-1.5 text-[11px] font-semibold text-octo-onyx focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass" style={{ background: "var(--color-octo-brass)" }}>Rebase</button>
            </div>
          </div>
        </ModalShell>
      )}
```

(`useState` is already imported; ensure `ModalShell`'s prop names match its actual signature —
`onClose`, `ariaLabel`, `children`. If it requires `align`/other props, pass sensible defaults.)

- [ ] **Step 4: Run tests + typecheck + build**

Run: `npx vitest run src/components/ChangesPanel.test.tsx 2>&1 | tail -10` → all pass (existing G4 tests + the 4 new).
Run: `npm run typecheck 2>&1 | tail -4` → clean.
Run: `npm run build 2>&1 | tail -4` → succeeds.
Run: `grep -nE '#[0-9a-fA-F]{3,8}|rgba\(' src/components/ChangesPanel.tsx` → only `var(--…)` tokens.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChangesPanel.tsx src/components/ChangesPanel.test.tsx && git commit -m "feat(g7): ChangesPanel sync control + reconcile dialog + conflict banner"
```

---

## Final verification (after all tasks)

- [ ] `cd src-tauri && cargo test 2>&1 | tail -8` — all Rust tests pass (classify_pull, conflict detection, timeout, git_lock). Ignore any pre-existing PTY-sandbox flake.
- [ ] `npm run typecheck` clean; `npx vitest run` all pass; `npm run build` succeeds.
- [ ] `git diff main...HEAD | grep -nE '#[0-9a-fA-F]{3,8}|rgba\(' | grep -v '\.rs:'` — empty (TS/TSX tokens only).
- [ ] Manual (`npm run tauri:dev`, a repo with an upstream): **Fetch** updates remote-tracking; **Pull** with the branch behind fast-forwards (toast); with divergence → the Rebase/Merge dialog; a conflicting pull → the conflict banner + `!` on files; a huge-graph repo doesn't hang the panel; the ↑/↓ badge appears with real ahead/behind counts.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `classify_pull` + `PullKind`/`PullOutcome` | 1 |
| Conflict detection (`FileChange.conflicted` + `GitStatus.conflicted`) | 1 |
| `status_files` + `ahead_behind` split | 1 |
| `git_lock` per-workspace mutex | 2 |
| `fetch_changes` + `pull(strategy)` (login shell) | 3 |
| ahead/behind timeout (`run_with_timeout`, `aheadBehindKnown`) | 3 |
| Lock around pull/fetch/commit/amend | 2, 3 |
| commands registered in lib.rs | 2, 3 |
| TS types `conflicted` + `aheadBehindKnown` | 4 |
| ipc `fetchChanges`/`pull` | 4 |
| Sync control (branch + ↑/↓ + Fetch/Pull) | 5 |
| Reconcile dialog (diverged → Rebase/Merge) | 5 |
| Conflict banner + `!` glyph | 5 |

Deferred (correctly absent): conflict resolution UI + AI (Slice II); history/blame (III);
branch switch/stash (IV); reset/clean/cherry-pick/tags (V); lock around stage/unstage/discard;
rail behind/conflict indicators.
