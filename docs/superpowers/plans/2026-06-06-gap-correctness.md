# Gap-Closing 1 — Correctness & Cleanups — Implementation Plan (Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the critical Settings data-loss bug, make project name/tint durably persisted to the backend (fixing the missing `tint` column footgun + localStorage-only fragility), and clear out two trivial code-cleanliness items found in the audit.

**Architecture:** `ModelsPane.handleSave` switches to the read-modify-write pattern already used by `EditorCommandRow`. A `projects.tint` migration is added, and `handleProjectCustomized` persists name+tint through the existing `update_project_customization` command (durable backend copy) in addition to localStorage. Two cleanups: strip debug logging from a test, fix a misleading comment.

**Tech Stack:** React 19 + TS, Tauri 2 / Rust + rusqlite, Vitest, cargo test.

**Audit source:** findings A (data-loss), B (tint column / localStorage-only), and cleanups in the 2026-06-06 gap audit.

---

## Task 1: Fix ModelsPane settings data-loss (read-modify-write)

**Why:** `ModelsPane.handleSave` sends a partial `AppSettings` (`gitCredentials: {}`, omits `issueTracker`/`editorCommand`/`lastPricingRefresh`) to a backend that overwrites the whole file → saving a provider wipes git credentials + Jira config + editor command.

**Files:**
- Modify: `src/components/Settings.tsx` (`ModelsPane.handleSave`, ~line 351-375)

- [ ] **Step 1: Apply the read-modify-write fix**

In `src/components/Settings.tsx`, change the `handleSave` `ipc.saveSettings({...})` call so it reads current settings first and merges only the provider fields (mirror `EditorCommandRow.persist`). Replace:

```tsx
      await ipc.saveProviders(providers);
      await ipc.saveSettings({
        providerKeys: Object.fromEntries(
          Object.entries(keys).filter(([, v]) => v && v.length > 0),
        ),
        providerBaseUrls: Object.fromEntries(
          Object.entries(baseUrls).filter(([, v]) => v && v.length > 0),
        ),
        gitCredentials: {},
      });
```

with:

```tsx
      await ipc.saveProviders(providers);
      // Read-modify-write: save_settings overwrites the whole file, so we must
      // merge onto the existing settings — otherwise we'd wipe gitCredentials,
      // issueTracker, editorCommand, and lastPricingRefresh.
      const current = await ipc.getSettings();
      await ipc.saveSettings({
        ...current,
        providerKeys: Object.fromEntries(
          Object.entries(keys).filter(([, v]) => v && v.length > 0),
        ),
        providerBaseUrls: Object.fromEntries(
          Object.entries(baseUrls).filter(([, v]) => v && v.length > 0),
        ),
      });
```

(Note: the `gitCredentials: {}` line is removed entirely — git credentials are managed by their own pane and must not be touched here.)

- [ ] **Step 2: Verify**

Run: `npm run typecheck` → clean. `npm test` → green.

Manual reasoning to confirm: `current` now carries `gitCredentials`, `issueTracker`, `editorCommand`, `lastPricingRefresh`, and the spread preserves them; only `providerKeys`/`providerBaseUrls` are overwritten with the edited values.

- [ ] **Step 3: Commit**

```bash
git add src/components/Settings.tsx
git commit -m "fix(settings): read-modify-write in ModelsPane save (stop wiping git/jira/editor settings)"
```

---

## Task 2: Persist project name/tint to the backend (+ tint column)

**Why:** Project name/tint live only in `localStorage.projectCustomizations` (lost if cleared); and `projects` has no `tint` column, so `db.update_project(.., Some(tint))` would error at runtime (latent — the backend is never called today). Add the column and have customization persist through the backend too (durable copy), keeping localStorage as the rail's read source (no risky source-of-truth migration in this pass).

**Files:**
- Modify: `src-tauri/src/db.rs` (migration)
- Modify: `src/App.tsx` (`handleProjectCustomized`)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Add the `tint` column migration**

In `src-tauri/src/db.rs`, in the migration block (near the other `add_column_if_missing` project migrations: `jira_project_key`, `closed_at`, `pinned`, `sort_order`), add:

```rust
        // Project tint (parity with the workspaces.tint column). Without this,
        // update_project(..., Some(tint)) errors with "no such column".
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN tint TEXT",
        )?;
```

- [ ] **Step 2: Write a failing Rust test for update_project tint**

In `src-tauri/src/tests.rs` (project test module with `test_db`/`insert_project`), add:

```rust
#[test]
fn update_project_sets_name_and_tint_without_error() {
    let db = test_db();
    db.insert_project("p", "Old", "/tmp/octo-upd-p").unwrap();

    // Before the tint migration this errored ("no such column: tint").
    db.update_project("p", Some("New"), Some("verdigris")).unwrap();

    // Name is reflected in list_projects (tuple field 1 = name).
    let row = db
        .list_projects()
        .unwrap()
        .into_iter()
        .find(|t| t.0 == "p")
        .unwrap();
    assert_eq!(row.1, "New");
}
```

Run `cd src-tauri && cargo test update_project_sets_name_and_tint_without_error`. Expected: PASS once the migration is in (it would have errored on the tint UPDATE before). Then full `cargo test`.

- [ ] **Step 3: Persist via the backend in `handleProjectCustomized`**

In `src/App.tsx`, `handleProjectCustomized` currently only writes localStorage (with a stale `// Call IPC to update backend (will be implemented in Task 6)` comment). Add the backend call after the localStorage write, and remove the stale comment:

```tsx
      // Update localStorage (the rail's current read source)
      const customizations = JSON.parse(localStorage.getItem("projectCustomizations") || "{}");
      customizations[customizingProjectId] = { name, tint };
      localStorage.setItem("projectCustomizations", JSON.stringify(customizations));

      // Trigger re-render so projectGroups recalculates with new customizations
      setProjectCustomizationsVersion((v) => v + 1);

      // Durably persist to the backend too (survives a localStorage clear).
      await ipc.updateProjectCustomization(customizingProjectId, name, tint);
      pushToast({ level: "success", title: "Project updated" });
```

(`ipc.updateProjectCustomization(projectId, name, tint)` already exists. The `await` is inside the existing `try` so a backend failure surfaces via the existing catch toast.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck` → clean. `npm test` → green. `cargo test` → green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs src/App.tsx
git commit -m "fix(project): add projects.tint column; persist project name/tint to backend"
```

---

## Task 3: Cleanups (debug logging + misleading comment)

**Files:**
- Modify: the scratchpad store test containing `[DEBUG]` `console.log`s
- Modify: `src-tauri/src/settings.rs` (misleading concurrency comment ~line 126)

- [ ] **Step 1: Remove debug logging from the scratchpad test**

Find it: `grep -rn '\[DEBUG\]' src/`. It's in a scratchpad store test (e.g. `src/stores/scratchpadStore.toggleopen.test.ts`). Remove every `console.log("[DEBUG]" ...)` line in that test file. Do NOT change the assertions or test logic — only delete the debug `console.log` statements.

- [ ] **Step 2: Fix the misleading comment in settings.rs**

In `src-tauri/src/settings.rs` (~line 126), there's a comment claiming the save is "Safe to call concurrently" — but `save_settings` does a full-file overwrite (last-write-wins, no locking). Read the comment and correct it to reflect reality, e.g.:

```rust
// NOTE: save_settings does a full-file overwrite (last-write-wins). Callers
// must read-modify-write to avoid clobbering fields they don't own. Not safe
// for concurrent writers, but the app is single-window so that's acceptable.
```

(Match the surrounding comment style; keep it accurate and concise.)

- [ ] **Step 3: Verify + commit**

Run: `npm test` (the scratchpad test still passes) and `cd src-tauri && cargo build` (comment-only change compiles).

```bash
git add -A
git commit -m "chore: drop debug logging from scratchpad test; correct settings concurrency comment"
```

---

## Task 4: Full verification

- [ ] **Step 1:** `npm run typecheck && npm test && (cd src-tauri && cargo test)` — all green.
- [ ] **Step 2:** `git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo clean` (no hex in any frontend change).

---

## Self-Review (during planning)

- **Coverage:** data-loss fix (T1), tint column + backend persistence (T2), cleanups (T3). The full "rail reads project name/tint from backend instead of localStorage" source-of-truth migration is intentionally NOT done here (current localStorage path works; backend now holds a durable copy) — documented as a possible future item to avoid a risky migration in a correctness pass.
- **Placeholders:** none. T2 Step 1 migration mirrors the established `add_column_if_missing` pattern. T3 uses grep to locate the exact debug-log file.
- **Consistency:** `ipc.updateProjectCustomization(projectId, name, tint)` signature matches the existing wrapper; `db.update_project(id, Some(name), Some(tint))` now has a real `tint` column to write.
