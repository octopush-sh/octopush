# Perf — Git-status poll churn on large change sets — Plan 9

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Eliminate the project-specific UI lag (reproduced on `colpensiones-api-rest`, whose `main` worktree has ~833 untracked files). Root cause: the active workspace's git status is fetched every 3s and `setGitStatus` fires unconditionally, re-rendering every `gitStatus` subscriber with an 833-item payload every 3 seconds even when nothing changed.

**Evidence (measured):** git status is fast (~0.05s even uncached); login shell ~0.03s; `gh` ~0.7s but async. The cost is the recurring re-render, not the scan. So the fix is to (a) only re-render when the status actually changed, (b) not poll while idle in talk mode, (c) cap the rendered file list, (d) make the rail's dirty-only check not build the full 833-entry list.

**Architecture:** Frontend change-detection via a signature ref so identical polls don't re-render; gate the 3s interval to run/review modes + a window-focus refresh; cap ChangesPanel's rendered rows; backend fast `is_dirty` (untracked dirs not recursed) for `dirty_ahead_behind`.

**Tech Stack:** React 19 + TS, Tauri 2 / Rust + git2, Vitest, cargo test.

**Note:** This is a pre-existing poll (commit c1ef419, 2026-05-18); the symptom is exposed by a repo with many untracked files (an untracked 21 MB `documentacion/`). The user's own `.gitignore` is the data-side fix; this plan is the app-side robustness fix.

---

## Task 1: Backend — fast dirty check (don't build the full file list for a bool)

**Why:** `dirty_ahead_behind` (Plan 3, rail git pulse/dots) calls `get_status`, which builds a `Vec<FileChange>` of all changed files (833 here) just to compute `!is_empty()`. Use a status scan that does NOT recurse untracked directories (an untracked dir counts as one entry), so a folder of 807 untracked files is one stat, not 807.

**Files:**
- Modify: `src-tauri/src/git_ops.rs`
- Test: existing `git_ops` test module

- [ ] **Step 1: add `is_dirty`**

In `src-tauri/src/git_ops.rs`, add near `dirty_ahead_behind`:

```rust
/// Fast "has any uncommitted change?" check. Unlike `get_status`, this does
/// NOT recurse into untracked directories — an untracked folder counts as a
/// single entry — so a directory of hundreds of untracked files costs one
/// stat instead of hundreds. Used for the rail's dirty indicator where only
/// the boolean matters.
pub fn is_dirty(path: &Path) -> AppResult<bool> {
    let repo = open_repo(path)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AppError::Other(format!("git status: {e}")))?;
    Ok(!statuses.is_empty())
}
```
(`StatusOptions` is already imported in this file — `get_status` uses it.)

- [ ] **Step 2: use it in `dirty_ahead_behind`**

Change `dirty_ahead_behind` to use `is_dirty` for the bool and keep ahead/behind from the upstream computation. Replace its body:

```rust
pub fn dirty_ahead_behind(path: &Path) -> AppResult<(bool, usize, usize)> {
    let dirty = is_dirty(path)?;
    // ahead/behind still come from the upstream comparison.
    let repo = open_repo(path)?;
    let (ahead, behind) = upstream_ahead_behind(&repo).unwrap_or((0, 0));
    Ok((dirty, ahead, behind))
}
```
(`upstream_ahead_behind(&repo)` is the existing private helper used by `get_status`. Confirm its signature/visibility — it's in the same module, so callable. If it takes `&Repository` and returns `Option<(usize,usize)>`, the above is correct.)

- [ ] **Step 3: test**

In the `git_ops` `#[cfg(test)] mod tests`, add a test that an untracked directory makes `is_dirty` true and `dirty_ahead_behind` agrees:

```rust
#[test]
fn is_dirty_detects_untracked_dir_without_recursing() {
    use std::fs;
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path()).unwrap();
    assert!(!is_dirty(dir.path()).unwrap(), "fresh repo is clean");

    // An untracked subdirectory with files → dirty (counted as one entry).
    fs::create_dir(dir.path().join("docs")).unwrap();
    fs::write(dir.path().join("docs/a.md"), "x").unwrap();
    fs::write(dir.path().join("docs/b.md"), "y").unwrap();
    assert!(is_dirty(dir.path()).unwrap(), "untracked dir marks dirty");
    let (dirty, _, _) = dirty_ahead_behind(dir.path()).unwrap();
    assert!(dirty);
}
```

- [ ] **Step 4: run + commit**

Run `cd src-tauri && cargo test is_dirty_detects_untracked_dir_without_recursing` then full `cargo test` (the existing `dirty_ahead_behind_reports_clean_then_dirty` test must still pass — its untracked single file still makes it dirty).

```bash
git add src-tauri/src/git_ops.rs
git commit -m "perf(git): fast is_dirty (no untracked recursion) for rail dirty check"
```

---

## Task 2: Frontend — change-detection + mode-gated git-status poll (the core fix)

**Why:** The effect at `App.tsx:466-491` calls `setGitStatus`/`setGitDiff` on every 3s poll regardless of whether anything changed, re-rendering all subscribers (ContextHeader, ReviewCanvas, ChangesPanel, the `fileTreeProps` memo) every 3 seconds. Only update state when the status/diff actually changed, and only run the live interval where changes matter (run/review), refreshing on window focus otherwise.

**Files:**
- Modify: `src/App.tsx` (the git-status effect, ~466-491; add a ref + a signature helper)

- [ ] **Step 1: add a signature ref**

Near the other refs in the `App` component, add:
```tsx
  const gitSigRef = useRef<string>("");
```
(`useRef` is already imported.)

- [ ] **Step 2: rework the effect**

Replace the entire git-status effect (currently `useEffect(() => { const ws = ...; ... }, [activeWorkspaceId, workspaces, project]);` at ~466-491) with:

```tsx
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    const path = ws?.worktreePath ?? project?.path;
    if (!path) {
      setGitStatus(null);
      setGitDiff("");
      gitSigRef.current = "";
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const [s, d] = await Promise.all([
          ipc.getGitStatus(path),
          ipc.getGitDiff(path).catch(() => ""),
        ]);
        if (cancelled) return;
        // Only re-render when the status/diff actually changed — the poll
        // otherwise re-renders every gitStatus subscriber every 3s with the
        // full changed-files payload (laggy on repos with many changes).
        const sig =
          `${s?.branch ?? ""}|${s?.ahead ?? 0}|${s?.behind ?? 0}|` +
          `${(s?.changedFiles ?? []).map((f) => `${f.path}:${f.status}:${f.staged ? 1 : 0}:${f.unstaged ? 1 : 0}`).join(",")}` +
          `|${d.length}`;
        if (sig === gitSigRef.current) return;
        gitSigRef.current = sig;
        setGitStatus(s);
        setGitDiff(d);
      } catch {
        /* non-fatal */
      }
    };
    refresh(); // immediate on workspace/mode change
    // Live polling only where file changes matter (run/review). In talk mode,
    // refresh on window focus instead of a tight interval.
    const id = activeMode !== "talk" ? setInterval(refresh, 3_000) : undefined;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeWorkspaceId, workspaces, project, activeMode]);
```

Key points: `activeMode` is added to deps so switching modes re-evaluates polling; the immediate `refresh()` runs in all modes (so counts/dots are fresh on switch); the interval runs only outside talk mode; window focus always refreshes. Confirm `activeMode` is in scope at that point in the component (it's defined at ~524 — if the effect is ABOVE that line, move the effect below `activeMode`'s definition, or read mode via a ref; the simplest is to ensure `activeMode` is declared before this effect — verify ordering and adjust).

- [ ] **Step 3: verify**

Run: `npm run typecheck` → clean (watch the `activeMode` declaration-order — if it's declared after this effect, TS/lint will flag use-before-declare; reorder so `activeMode` precedes the effect). `npm test` → green.

Manual reasoning to confirm no behavior loss: on workspace switch, `refresh()` runs immediately (fresh status); in run/review the 3s interval keeps the diff live; in talk mode focus refreshes it; identical polls no longer re-render.

- [ ] **Step 4: commit**

```bash
git add src/App.tsx
git commit -m "perf(rail): git-status change-detection + mode-gated poll (stop 3s re-render churn)"
```

---

## Task 3: Frontend — cap the rendered changed-file list in ChangesPanel

**Why:** `ChangesPanel` renders `files.map(...)` over the full changed-file list (`ChangesPanel.tsx:315`), with no virtualization — 833 rows on this repo. Cap the rendered rows with a "+N more" notice so a huge changeset can't produce a giant DOM.

**Files:**
- Modify: `src/components/ChangesPanel.tsx`

- [ ] **Step 1: cap the list**

In `ChangesPanel.tsx`, where `const files = gitStatus?.changedFiles ?? [];` (line ~66) and the render `files.map((file) => (...))` (line ~315):

Add a cap constant near the top of the component module:
```tsx
const MAX_VISIBLE_FILES = 200;
```
Where the list is rendered, slice it and show an overflow notice. Replace `{files.map((file) => ( ... ))}` with:
```tsx
          {files.slice(0, MAX_VISIBLE_FILES).map((file) => (
            ... existing row JSX unchanged ...
          ))}
          {files.length > MAX_VISIBLE_FILES && (
            <div className="px-3 py-2 font-mono text-[11px] text-octo-mute">
              +{files.length - MAX_VISIBLE_FILES} more changed files
            </div>
          )}
```
(Keep the existing row JSX inside the `.map` exactly as-is. READ the file to splice precisely; preserve any surrounding container.)

- [ ] **Step 2: verify + commit**

Run `npm run typecheck` → clean. `npm test` → green (if a ChangesPanel test asserts all files render, it likely uses < 200 files, so unaffected — confirm). `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.

```bash
git add src/components/ChangesPanel.tsx
git commit -m "perf(review): cap rendered changed-file rows in ChangesPanel (+N more)"
```

---

## Task 4: Verification

- [ ] `npm run typecheck && npm test && (cd src-tauri && cargo test)` — all green.
- [ ] `git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo clean`.
- [ ] Manual on `colpensiones-api-rest` (`npm run tauri:dev`): in talk mode the rail/header no longer churn while idle; switching to `main` updates once (not continuously); switching workspaces is responsive; in review mode the diff still updates live as files change. Compare against a clean project (should feel identical).

---

## Self-Review (during planning)

- **Coverage:** change-detection (T2 — the dominant fix), mode-gated poll + focus refresh (T2), render cap (T3), backend fast dirty (T1). Full virtualization intentionally skipped — the render cap (T3) bounds the DOM without a new dependency; revisit only if a capped 200-row render is still heavy.
- **Evidence-based:** measurements ruled out slow git scan / slow shell / fetch pile-up; the fix targets the confirmed cost (recurring re-render on unchanged status).
- **Risk:** T2 changes a core, widely-subscribed effect — the change-detection preserves exact output (same `s`/`d` set when changed), only skipping redundant sets; mode-gating keeps immediate-on-switch + focus refresh so no surface goes stale beyond a focus event. T1 keeps `dirty_ahead_behind`'s contract (bool + ahead/behind). T3 is display-only.
- **Consistency:** `is_dirty(path) -> AppResult<bool>` mirrors `get_status`'s `StatusOptions` usage; the signature string covers branch/ahead/behind/all files/diff-length so any real change re-renders.
