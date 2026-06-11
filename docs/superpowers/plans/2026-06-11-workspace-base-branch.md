# Workspace Base-Branch + Creator Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose the base branch when creating a workspace (today the backend silently ignores `from_branch` and the UI hardcodes `main`), and bring the WorkspaceCreator wizard up to the minimalism/premium doctrine (design-system §9 + user imperatives: no italics, **no arrow glyphs or line decorations in buttons**, icons + tooltips, smooth step transitions).

**Architecture:** New `list_branches` git_ops fn + Tauri command (default branch first, then alphabetical). `create_workspace` honors an explicit `from_branch` (empty → repo default, current behavior). The Creator's static "from main" preview becomes a quiet branch picker (portal + fixed menu via `useMenuChrome`, the house pattern). Step swap animates via `FadeSwap`. Audit fixes: duplicate "Skip & begin" removed, arrows out of buttons, rgba literals → tokens, error rise-in, Escape to cancel, focus rings.

**Tech Stack:** Rust (git2), React 19 + TS, `useMenuChrome`, `FadeSwap`, Vitest, `#[test]` + tempfile.

**Branch:** `feat/workspace-base-branch` off `main`, worktree `octopus-sh-review`.

**Verified current state:** `create_workspace` (commands.rs:536) computes `base = default_branch(project_path)?.unwrap_or(from_branch)` — the UI's value only applies to repos with no HEAD (the bug). `create_branch(path, name, from)` (git_ops.rs:277) already supports any local base and errors clearly on a missing one. `WorkspaceCreator.tsx` hardcodes `"main"` (line 56) and renders a static `from main` label (lines 145-150). No branch-listing command exists. Creator is mounted full-canvas from App.tsx (3 sites), all passing the same props.

---

### Task 1: Backend — `list_branches` + honor `from_branch`

**Files:**
- Modify: `src-tauri/src/git_ops.rs` (new `list_branches`, new pure `resolve_base`)
- Modify: `src-tauri/src/commands.rs:536-567` (create_workspace base resolution; new `list_branches` command)
- Modify: `src-tauri/src/lib.rs` (register `list_branches`)
- Modify: `src-tauri/src/tests.rs` (tests)
- Modify: `src/lib/ipc.ts` (binding)

- [ ] **Step 1: Write failing tests** in `tests.rs` (new mod `branch_listing_tests`, using the existing tempdir+git-CLI pattern from `read_directory_tests`):

```rust
#[cfg(test)]
mod branch_listing_tests {
    use crate::git_ops::{list_branches, resolve_base};
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo_with_branches() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let d = tmp.path();
        git(d, &["init", "-b", "main"]);
        git(d, &["config", "user.email", "t@t"]);
        git(d, &["config", "user.name", "t"]);
        fs::write(d.join("a.txt"), "a").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-m", "init"]);
        git(d, &["branch", "release/1.0"]);
        git(d, &["branch", "feat-x"]);
        tmp
    }

    #[test]
    fn lists_local_branches_default_first_then_alpha() {
        let tmp = repo_with_branches();
        let branches = list_branches(tmp.path()).unwrap();
        assert_eq!(branches, vec!["main", "feat-x", "release/1.0"]);
    }

    #[test]
    fn resolve_base_prefers_explicit_branch() {
        assert_eq!(resolve_base("release/1.0", Some("main".into())).unwrap(), "release/1.0");
        assert_eq!(resolve_base("  ", Some("main".into())).unwrap(), "main");
        assert_eq!(resolve_base("", Some("main".into())).unwrap(), "main");
        assert!(resolve_base("", None).is_err(), "no explicit base and no HEAD must error");
        assert_eq!(resolve_base("dev", None).unwrap(), "dev");
    }
}
```

- [ ] **Step 2: Run** `cd src-tauri && cargo test branch_listing` — FAIL (fns missing).

- [ ] **Step 3: Implement in `git_ops.rs`** (near `default_branch`):

```rust
/// Local branch names: the repo's default (HEAD) branch first, the rest
/// alphabetical (case-insensitive). Used by the workspace creator's base picker.
pub fn list_branches(path: &Path) -> AppResult<Vec<String>> {
    let repo = open_repo(path)?;
    let default = default_branch(path)?;
    let mut names: Vec<String> = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| AppError::Other(format!("list branches: {e}")))?
        .filter_map(|b| b.ok())
        .filter_map(|(b, _)| b.name().ok().flatten().map(String::from))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    if let Some(def) = default {
        names.retain(|n| n != &def);
        names.insert(0, def);
    }
    Ok(names)
}

/// Resolve the base branch for a new workspace: an explicit non-blank choice
/// wins; otherwise the repo's default branch; empty repos with no choice error.
pub fn resolve_base(from_branch: &str, default: Option<String>) -> AppResult<String> {
    let explicit = from_branch.trim();
    if !explicit.is_empty() {
        return Ok(explicit.to_string());
    }
    default.ok_or_else(|| AppError::Other("repository has no branches yet".into()))
}
```

- [ ] **Step 4: Fix `create_workspace`** in commands.rs — replace the base computation:

```rust
    // Explicit base branch wins; blank falls back to the repo's default.
    let base = crate::git_ops::resolve_base(
        &from_branch,
        crate::git_ops::default_branch(project_path)?,
    )?;
```

(`ensure_initial_commit` stays before it.) Add the command:

```rust
#[tauri::command]
pub async fn list_branches(path: String) -> AppResult<Vec<String>> {
    let path = expand_tilde(&path);
    crate::git_ops::list_branches(std::path::Path::new(&path))
}
```

Register `list_branches` in `lib.rs`'s invoke handler list.

- [ ] **Step 5: ipc binding** — in `src/lib/ipc.ts` next to the other git bindings:

```ts
  listBranches: (path: string) => invoke<string[]>("list_branches", { path }),
```

- [ ] **Step 6: Run** `cargo test` (lib all green) + `npm run typecheck`.

- [ ] **Step 7: Commit** `feat(workspace): list_branches command + create_workspace honors the chosen base branch`

---

### Task 2: Creator UI — base-branch picker

**Files:**
- Create: `src/components/BaseBranchPicker.tsx`
- Modify: `src/components/WorkspaceCreator.tsx` (picker in step 1, pass base to create)
- Test: `src/components/BaseBranchPicker.test.tsx`, `src/components/WorkspaceCreator.test.tsx`

- [ ] **Step 1: Failing tests** — `BaseBranchPicker.test.tsx`: renders the current base; opens a `role="menu"` on click with one `menuitem` per branch; selecting calls `onSelect` and dismisses; the trigger has a `title` tooltip; menu portals to body with `fixed`. `WorkspaceCreator.test.tsx`: mock `ipc.listBranches` → `["main","release/1.0"]`; after picking `release/1.0`, `create` is called with that base (assert the 6th arg).

- [ ] **Step 2: Implement `BaseBranchPicker.tsx`** — quiet inline control for the BRANCH preview row: a `<button>` showing the selected base in mono 10px (sage; hover brass via `transition-colors duration-[220ms]`), `GitBranch` lucide icon size 10, `title="Base branch — the new branch starts from here"`, `aria-haspopup="menu"`. On click → portal+fixed menu (clone the `FileTreeContextMenu` chrome: `useMenuChrome`, `octo-menu-enter`, `fixed z-[60] w-[224px] rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-2xl`, `role="menu"`): one `role="menuitem"` row per branch (mono 11px, ITEM-style hover, the SELECTED branch's name in brass with a `Check` lucide 12px in the leading slot; others get an empty 12px slot so labels align). NO arrow glyphs anywhere. Empty/error branch list → the control degrades to a static label of the current base (feature intact: backend falls back to default).

- [ ] **Step 3: Wire into `WorkspaceCreator`** — `const [base, setBase] = useState<string | null>(null);` + on mount `ipc.listBranches(projectPath).then(b => { setBranches(b); setBase(b[0] ?? null); }).catch(() => {})` (b[0] is the repo default). The preview row becomes `BRANCH <slug> from <BaseBranchPicker>`. `handleCreate` passes `base ?? ""` as `fromBranch` (empty string keeps the backend-default fallback). The worktree path hint and everything else unchanged.

- [ ] **Step 4: Run** both test files + typecheck — green. **Step 5: Commit** `feat(workspace): base-branch picker in the creator`

---

### Task 3: Creator polish — doctrine pass

**Files:**
- Modify: `src/components/WorkspaceCreator.tsx`
- Test: `src/components/WorkspaceCreator.test.tsx`

All items below; write/adjust tests for behavior changes (Skip button gone, Escape cancels, FadeSwap step swap renders both steps' content across the transition — use the existing FadeSwap test patterns with fake timers if needed):

- [ ] **No arrows/lines in buttons**: `← Back` (both: the aside's and step 2's) → lucide `ChevronLeft` size-12 icon + the word `Back`, canonical quiet-button hover (`transition-colors duration-[220ms] hover:text-octo-sage` stays fine) + focus ring. The `↵ to continue` hint is NOT a button — restyle as a quiet kbd chip: `<kbd className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-[9px] text-octo-mute">Enter</kbd> <span>to continue</span>` (no `↵` glyph; tracking-normal).
- [ ] **Remove `Skip & begin`** — it calls the exact same `handleCreate` as `Begin` (the script is already optional); pure noise and it half-works when the task is invalid (silently no-ops). One `Begin` button. Update tests that reference it.
- [ ] **FadeSwap the step change**: wrap the `<main>`'s conditional in `<FadeSwap swapKey={String(step)} className="flex flex-1 flex-col justify-center">` (move the centering classes so layout is preserved; `main` keeps padding).
- [ ] **Tokens**: the root radial gradient `rgba(212,165,116,0.05)` → `var(--brass-faint)` inside the gradient (`radial-gradient(ellipse at 30% 25%, var(--brass-faint), transparent 50%), var(--color-octo-onyx)`); the error box `rgba(209, 139, 139, 0.08)` → `var(--rouge-ghost)` (verify the token exists in styles.css — it does, used by menu DANGER styles; if the exact name differs, use the existing one).
- [ ] **Error entrance**: add `octo-rise-in` to the error box.
- [ ] **CTA buttons**: replace the inline `style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}` with classes `border border-[var(--brass-dim)] bg-[var(--brass-ghost)]` + add `focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass`; keep the upright serif voice (`font-serif`, never italic).
- [ ] **StepIndex**: add `transition-colors duration-[220ms]`, `focus-visible` ring, and `title="Complete the task first"` on the disabled step II.
- [ ] **Escape cancels**: a `useEffect` window keydown — Escape → `onCancel()` (unless `creating`). Test it.
- [ ] Run full `npx vitest run` + `npm run typecheck` — green. Commit `fix(workspace): creator doctrine pass — no arrow buttons, FadeSwap steps, tokens, single CTA, escape`

---

## Done criteria

Picker chooses any local branch and the created workspace branches from it (backend test proves base is honored); default behavior unchanged when untouched; zero arrow glyphs inside buttons; zero rgba/hex literals in the diff outside token definitions; step swap and error entrance animated; one CTA; Escape cancels; 100% suites green.
