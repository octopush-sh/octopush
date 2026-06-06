# Rail Organize — Pin, Reorder, Archive, Rename & Filter — Implementation Plan (Plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users organize the rail — pin projects to the top, reorder them, archive a workspace (keep the branch, free the worktree), rename a workspace, and quick-filter the rail by name — closing out the rail robustness initiative.

**Architecture:** Two new `projects` columns (`pinned`, `sort_order`) drive server-side ordering (pinned first, then manual order, then creation order); commands `set_project_pinned` / `set_project_order` mutate them and `ProjectInfo` gains `pinned` so the menu can show the right toggle. Workspaces reuse the existing `status` column: `archive_workspace` removes the worktree but keeps the branch and sets `status='archived'`, and `list_workspaces` now excludes archived rows. `rename_workspace` updates the workspace name. The rail gains a quick-filter input (frontend-only). Reorder is delivered as accessible **Move up / Move down** menu actions (not drag — no DnD library exists and a hand-rolled drag would be fragile; drag is documented as deferred polish).

**Tech Stack:** Rust + rusqlite + git2, Tauri 2; React 19 + TypeScript, Zustand, Tailwind v4 (theme tokens), Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-05-rail-robustness-design.md` — §9 (reorder & pin), §10 (archive workspace), §5.2 (rename workspace), §4 navigation (quick filter), §6.4 (pinned/sort_order migration).

**Deliberate scope decisions (documented for continuity):**
- **Reorder = Move up / Move down menu actions, not drag.** No DnD lib is installed; the spec explicitly prefers "a minimal pointer-based reorder." Menu actions persist `sort_order`, are keyboard-accessible, and avoid fragile drag UX. Full drag-reorder is deferred.
- **Rename = dedicated small dialog + a distinct "Rename workspace" menu item** (spec §5.2). It does not overload the existing "Customize…" editor (keeps that contract intact).
- **Project rename is out of scope** (the existing "Rename project" item / project customizer is pre-existing and unchanged). This plan's rename covers workspaces only, per the wave-4 deferral list.
- **Archive browse/restore UI is out of scope** (spec §10 notes this). Archive tidies the rail + frees the worktree; the branch survives so work is recoverable by creating a workspace from that branch.

---

## File Structure

**Modified — backend**
- `src-tauri/src/db.rs` — `pinned` + `sort_order` migration; `list_projects`/`list_closed_projects` ordering + extended tuple; `set_project_pinned`, `set_project_order` methods; `archive_workspace`, `rename_workspace` methods; `list_workspaces` excludes archived.
- `src-tauri/src/commands.rs` — `ProjectInfo.pinned`; updated mappers; `set_project_pinned`, `set_project_order`, `archive_workspace`, `rename_workspace` commands.
- `src-tauri/src/lib.rs` — register the four new commands.
- `src-tauri/src/tests.rs` — pin/order, archive, rename DB tests.

**Modified — frontend**
- `src/lib/types.ts` — `ProjectInfo.pinned`.
- `src/lib/ipc.ts` — `setProjectPinned`, `setProjectOrder`, `archiveWorkspace`, `renameWorkspace`.
- `src/stores/projectStore.ts` — `setPinned`, `setOrder` actions.
- `src/stores/projectStore.test.ts` — tests.
- `src/stores/workspaceStore.ts` — `archive`, `rename` actions.
- `src/stores/workspaceStore.test.ts` — tests.
- `src/components/ProjectContextMenu.tsx` — Pin/Unpin toggle + Move up/down; fix Close subtitle.
- `src/components/WorkspaceContextMenu.tsx` — Archive + Rename items.
- `src/components/RenameDialog.tsx` — new small rename modal.
- `src/components/WorkspaceRail.tsx` — quick-filter input + filtering.
- `src/App.tsx` — wire pin/order/archive/rename handlers + the rename dialog.

---

## Task 1: Backend DB — pin + sort_order (migration, ordering, methods)

**Files:**
- Modify: `src-tauri/src/db.rs` (migration block; `list_projects`; `list_closed_projects`; add methods near `update_project`)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Add the migrations**

In `src-tauri/src/db.rs`, after the `closed_at` ADD COLUMN migration (added in Plan 2), add:

```rust
        // ── v4 organize: manual rail ordering. `pinned` floats a project to
        // the top; `sort_order` is the manual position within its group.
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN sort_order INTEGER",
        )?;
```

- [ ] **Step 2: Order by pinned, then manual order, then creation**

In `db.rs`, change `list_projects` to select `pinned` and order accordingly. Its return type becomes a 6-tuple (adds a trailing `bool` for pinned):

```rust
    pub fn list_projects(
        &self,
    ) -> AppResult<Vec<(String, String, String, String, Option<String>, bool)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened, jira_project_key, pinned FROM projects \
             WHERE closed_at IS NULL \
             ORDER BY pinned DESC, sort_order IS NULL, sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get::<_, i64>(5)? != 0,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
```

And `list_closed_projects` likewise selects `pinned` and returns the 6-tuple (ordering stays `closed_at DESC LIMIT 10`):

```rust
    pub fn list_closed_projects(
        &self,
    ) -> AppResult<Vec<(String, String, String, String, Option<String>, bool)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened, jira_project_key, pinned FROM projects \
             WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 10",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get::<_, i64>(5)? != 0,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
```

- [ ] **Step 3: Add the pin + order methods**

In `db.rs`, near `update_project` (or just above `delete_project`), add:

```rust
    /// Pin/unpin a project (floats it to the top of the rail).
    pub fn set_project_pinned(&self, id: &str, pinned: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE projects SET pinned = ?1 WHERE id = ?2",
            params![pinned as i64, id],
        )?;
        Ok(())
    }

    /// Rewrite manual ordering: `sort_order` becomes each id's position in
    /// `ids` (0-based). Ids not present keep their existing sort_order.
    pub fn set_project_order(&self, ids: &[String]) -> AppResult<()> {
        for (idx, id) in ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE projects SET sort_order = ?1 WHERE id = ?2",
                params![idx as i64, id],
            )?;
        }
        Ok(())
    }
```

- [ ] **Step 4: Write the failing test**

In `src-tauri/src/tests.rs`, add (in the module where the Plan-2 `soft_close_*` project test lives, which has `insert_project`/`list_projects` in scope):

```rust
#[test]
fn pin_and_order_projects() {
    let db = test_db();
    db.insert_project("a", "A", "/tmp/octo-a").unwrap();
    db.insert_project("b", "B", "/tmp/octo-b").unwrap();
    db.insert_project("c", "C", "/tmp/octo-c").unwrap();

    // Default order = creation order, none pinned.
    let ids: Vec<String> = db.list_projects().unwrap().into_iter().map(|t| t.0).collect();
    assert_eq!(ids, ["a", "b", "c"]);

    // Manual reorder: c, a, b.
    db.set_project_order(&["c".into(), "a".into(), "b".into()]).unwrap();
    let ids: Vec<String> = db.list_projects().unwrap().into_iter().map(|t| t.0).collect();
    assert_eq!(ids, ["c", "a", "b"]);

    // Pinning b floats it above the manual order.
    db.set_project_pinned("b", true).unwrap();
    let rows = db.list_projects().unwrap();
    assert_eq!(rows[0].0, "b");
    assert!(rows[0].5, "b should report pinned = true");
    assert!(!rows[1].5, "non-pinned rows report pinned = false");

    // Unpin restores manual order.
    db.set_project_pinned("b", false).unwrap();
    let ids: Vec<String> = db.list_projects().unwrap().into_iter().map(|t| t.0).collect();
    assert_eq!(ids, ["c", "a", "b"]);
}
```

- [ ] **Step 5: Run + commit**

Run: `cd src-tauri && cargo test pin_and_order_projects` → PASS, then full `cargo test` (note: this changes the `list_projects` tuple arity — Task 2 fixes the command mappers; the crate will NOT fully compile until Task 2. So for THIS task, run only the db test via `cargo test --lib pin_and_order_projects` if the crate compiles, OR proceed to Task 2 and run tests there. If `cargo test` fails to compile due to the mapper arity, that's expected — commit this task and do Task 2 immediately.)

```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(backend): projects pinned + sort_order; ordered list_projects (§9)"
```

(Note: committing a transiently-non-compiling backend is acceptable here because Task 2 immediately follows and restores it — same controller-sequenced pattern used in earlier plans. If you prefer, implement Task 1 + Task 2 back-to-back before running the full suite.)

---

## Task 2: Backend commands — ProjectInfo.pinned + set_project_pinned / set_project_order

**Files:**
- Modify: `src-tauri/src/commands.rs` (`ProjectInfo` struct; every ProjectInfo construction; `list_recent_projects` + `list_closed_projects` mappers; new commands)
- Modify: `src-tauri/src/db.rs` (`get_project` selects `pinned`)
- Modify: `src-tauri/src/lib.rs` (register)

- [ ] **Step 1: Add `pinned` to `ProjectInfo`**

In `commands.rs`, add to the `ProjectInfo` struct (which already has `#[serde(rename_all = "camelCase")]`):

```rust
    pub jira_project_key: Option<String>,
    pub pinned: bool,
```

- [ ] **Step 2: Fix every `ProjectInfo { ... }` construction**

Search `commands.rs` for `ProjectInfo {`. Update each:
- `list_recent_projects`: the mapper now destructures the 6-tuple and sets `pinned`:
```rust
pub async fn list_recent_projects(state: State<'_, AppState>) -> AppResult<Vec<ProjectInfo>> {
    let rows = state.db.lock().list_projects()?;
    Ok(rows
        .into_iter()
        .map(|(id, name, path, _, jira_project_key, pinned)| ProjectInfo {
            id,
            name,
            path,
            jira_project_key,
            pinned,
        })
        .collect())
}
```
- `list_closed_projects`: same destructure + `pinned` (closed projects' pinned is irrelevant but the field is required).
- `open_project` (both the existing-row and new-row branches), `create_project`: these build `ProjectInfo` without a `pinned` source. For the existing-row branch, read it from the db (see Step 3 `get_project`), e.g. `pinned: db.get_project(&id)?.map(|p| p.pinned).unwrap_or(false)`. For the brand-new project branch, use `pinned: false`.

- [ ] **Step 3: `db.get_project` selects pinned**

In `db.rs`, `get_project` builds a `ProjectInfo` from a `SELECT`. Add `pinned` to its SELECT and construction:
```rust
    pub fn get_project(&self, project_id: &str) -> AppResult<Option<crate::commands::ProjectInfo>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, jira_project_key, pinned FROM projects WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![project_id], |r| {
                Ok(crate::commands::ProjectInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    path: r.get(2)?,
                    jira_project_key: r.get(3)?,
                    pinned: r.get::<_, i64>(4)? != 0,
                })
            })
            .optional()?;
        Ok(row)
    }
```
(Read the actual `get_project` first; match its existing shape — only add the `pinned` column + field.)

- [ ] **Step 4: Add the two commands**

In `commands.rs`, near `update_project_customization`, add:

```rust
#[tauri::command]
pub async fn set_project_pinned(
    state: State<'_, AppState>,
    project_id: String,
    pinned: bool,
) -> AppResult<()> {
    state.db.lock().set_project_pinned(&project_id, pinned)
}

#[tauri::command]
pub async fn set_project_order(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<()> {
    state.db.lock().set_project_order(&ids)
}
```

- [ ] **Step 5: Register in lib.rs**

After `commands::update_project_customization,` add:
```rust
            commands::set_project_pinned,
            commands::set_project_order,
```

- [ ] **Step 6: Build + test + commit**

Run: `cd src-tauri && cargo build` (must compile) then `cargo test` (full suite green, incl. Task 1's `pin_and_order_projects`).

```bash
git add src-tauri/src/commands.rs src-tauri/src/db.rs src-tauri/src/lib.rs
git commit -m "feat(backend): ProjectInfo.pinned + set_project_pinned/set_project_order commands (§9)"
```

---

## Task 3: Backend — archive workspace

**Why:** Archive frees a worktree and tidies the rail while keeping the branch (recoverable), unlike delete which removes the branch too. Reuses the existing `status` column.

**Files:**
- Modify: `src-tauri/src/db.rs` (`archive_workspace` method; `list_workspaces` excludes archived)
- Modify: `src-tauri/src/commands.rs` (`archive_workspace` command)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: db method + exclude archived from list**

In `db.rs`, add:
```rust
    /// Mark a workspace archived (worktree removed, branch kept). The row
    /// survives but is hidden from the rail.
    pub fn archive_workspace(&self, id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET status = 'archived' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }
```
And change `list_workspaces` to exclude archived rows — add the status filter to its WHERE clause:
```rust
            "SELECT id, project_id, name, task, branch, worktree_path, setup_script, \
             status, created_at, last_active, glyph, tint, test_command, \
             linked_issue_key, issue_link_dismissed \
             FROM workspaces WHERE project_id = ?1 AND status != 'archived' \
             ORDER BY created_at ASC",
```
(Read the actual `list_workspaces` SELECT and add only `AND status != 'archived'` to the existing WHERE.)

- [ ] **Step 2: command (remove worktree, keep branch, set status)**

In `commands.rs`, model on `delete_workspace` but DO NOT delete the branch. Add:
```rust
#[tauri::command]
pub async fn archive_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    project_path: String,
    worktree_path: Option<String>,
) -> AppResult<()> {
    let project_path = expand_tilde(&project_path);
    // Remove the worktree from disk (free space) but KEEP the branch so the
    // work is recoverable. The main worktree (== project root) is never
    // archived — the rail hides Archive for it (and we guard here too).
    if let Some(wt) = worktree_path {
        let wt = expand_tilde(&wt);
        if wt != project_path {
            if std::path::Path::new(&wt).exists() {
                let _ = std::fs::remove_dir_all(&wt);
            }
            let _ = crate::git_ops::delete_worktree(
                std::path::Path::new(&project_path),
                std::path::Path::new(&wt),
            );
        }
    }
    state.db.lock().archive_workspace(&workspace_id)
}
```
IMPORTANT: read the actual `delete_workspace` command + `git_ops::delete_worktree` signature first and MATCH it exactly (the worktree-removal call there is the source of truth — mirror its argument shapes; do NOT call `delete_branch`). If `delete_worktree` takes a worktree *name* rather than a path, mirror whatever `delete_workspace` passes. Adjust the code above to match the real signatures.

- [ ] **Step 3: register**

In `lib.rs`, near `commands::delete_workspace,` add `commands::archive_workspace,`.

- [ ] **Step 4: test**

In `tests.rs` (workspace test module with `insert_workspace`/`list_workspaces`/`insert_project`):
```rust
#[test]
fn archive_hides_workspace_but_keeps_row() {
    let db = test_db();
    db.insert_project("p", "P", "/tmp/octo-arch-p").unwrap();
    db.insert_workspace("w1", "p", "alpha", "", "feat/a", Some("/tmp/octo-arch-p/.wt/a"), "").unwrap();
    db.insert_workspace("w2", "p", "beta", "", "feat/b", Some("/tmp/octo-arch-p/.wt/b"), "").unwrap();

    assert_eq!(db.list_workspaces("p").unwrap().len(), 2);

    db.archive_workspace("w1").unwrap();

    let rows = db.list_workspaces("p").unwrap();
    assert_eq!(rows.len(), 1, "archived workspace hidden from the rail list");
    assert_eq!(rows[0].id, "w2");
}
```
(Read the real `insert_workspace` signature first and match its argument list/types exactly — the call above is illustrative.)

- [ ] **Step 5: run + commit**

Run: `cd src-tauri && cargo test archive_hides_workspace_but_keeps_row` then full `cargo test`.
```bash
git add src-tauri/src/db.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs
git commit -m "feat(backend): archive_workspace (worktree removed, branch kept) (§10)"
```

---

## Task 4: Backend — rename workspace

**Files:**
- Modify: `src-tauri/src/db.rs` (`rename_workspace` method)
- Modify: `src-tauri/src/commands.rs` (`rename_workspace` command)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: db method**
```rust
    pub fn rename_workspace(&self, id: &str, name: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE workspaces SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }
```

- [ ] **Step 2: command**
```rust
#[tauri::command]
pub async fn rename_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
) -> AppResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Other("Workspace name cannot be empty".into()));
    }
    state.db.lock().rename_workspace(&workspace_id, &name)
}
```

- [ ] **Step 3: register** — in `lib.rs`, near `commands::update_workspace_customization,` add `commands::rename_workspace,`.

- [ ] **Step 4: test**
```rust
#[test]
fn rename_workspace_updates_name() {
    let db = test_db();
    db.insert_project("p", "P", "/tmp/octo-rn-p").unwrap();
    db.insert_workspace("w1", "p", "old", "", "feat/a", Some("/tmp/octo-rn-p/.wt/a"), "").unwrap();

    db.rename_workspace("w1", "new name").unwrap();

    let rows = db.list_workspaces("p").unwrap();
    assert_eq!(rows[0].name, "new name");
}
```
(Match the real `insert_workspace` signature.)

- [ ] **Step 5: run + commit**
Run: `cd src-tauri && cargo test rename_workspace_updates_name` then full `cargo test`.
```bash
git add src-tauri/src/db.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs
git commit -m "feat(backend): rename_workspace command (§5.2)"
```

---

## Task 5: Frontend types + IPC

**Files:**
- Modify: `src/lib/types.ts` (`ProjectInfo.pinned`)
- Modify: `src/lib/ipc.ts` (4 commands)

- [ ] **Step 1: types**

In `src/lib/types.ts`, add `pinned` to `ProjectInfo`:
```ts
export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  jiraProjectKey: string | null;
  pinned: boolean;
}
```

- [ ] **Step 2: ipc**

In `src/lib/ipc.ts`, add near the project commands:
```ts
  setProjectPinned: (projectId: string, pinned: boolean) =>
    invoke<void>("set_project_pinned", { projectId, pinned }),
  setProjectOrder: (ids: string[]) => invoke<void>("set_project_order", { ids }),
```
and near the workspace commands:
```ts
  archiveWorkspace: (workspaceId: string, projectPath: string, worktreePath: string | null) =>
    invoke<void>("archive_workspace", { workspaceId, projectPath, worktreePath }),
  renameWorkspace: (workspaceId: string, name: string) =>
    invoke<void>("rename_workspace", { workspaceId, name }),
```

- [ ] **Step 3: verify + commit**

Run: `npm run typecheck`. This will report errors anywhere a `ProjectInfo` object literal is constructed in TS WITHOUT `pinned` (e.g. test factories). Fix those by adding `pinned: false` to such literals (search `jiraProjectKey:` in `.ts`/`.tsx` to find object literals — production code receives ProjectInfo from IPC so only test factories/mocks need updating). If `projectStore.test.ts`'s `proj()` factory and `workspaceStore.test.ts`'s `makeProject()` build ProjectInfo, add `pinned: false` there.

```bash
git add src/lib/types.ts src/lib/ipc.ts src/stores/projectStore.test.ts src/stores/workspaceStore.test.ts
git commit -m "feat(ipc): ProjectInfo.pinned + pin/order/archive/rename commands"
```

(Only include test files in the commit if you had to touch them for the `pinned` field.)

---

## Task 6: projectStore — pin + reorder actions

**Files:**
- Modify: `src/stores/projectStore.ts`
- Test: `src/stores/projectStore.test.ts`

- [ ] **Step 1: write failing tests**

In `src/stores/projectStore.test.ts`, add `setProjectPinned` + `setProjectOrder` to the `mockIpc`, and add:
```ts
describe("projectStore — pin & reorder", () => {
  beforeEach(() => resetStore());

  it("setPinned calls ipc and reloads recent", async () => {
    const a = proj("a");
    useProjectStore.setState({ recent: [a] });
    mockIpc.setProjectPinned.mockResolvedValueOnce(undefined);
    mockIpc.listRecentProjects.mockResolvedValueOnce([{ ...a, pinned: true }]);

    await useProjectStore.getState().setPinned("a", true);

    expect(mockIpc.setProjectPinned).toHaveBeenCalledWith("a", true);
    expect(useProjectStore.getState().recent[0].pinned).toBe(true);
  });

  it("setOrder calls ipc with the id sequence and reloads recent", async () => {
    const a = proj("a");
    const b = proj("b");
    useProjectStore.setState({ recent: [a, b] });
    mockIpc.setProjectOrder.mockResolvedValueOnce(undefined);
    mockIpc.listRecentProjects.mockResolvedValueOnce([b, a]);

    await useProjectStore.getState().setOrder(["b", "a"]);

    expect(mockIpc.setProjectOrder).toHaveBeenCalledWith(["b", "a"]);
    expect(useProjectStore.getState().recent.map((p) => p.id)).toEqual(["b", "a"]);
  });
});
```
(Ensure the `proj()` factory includes `pinned: false` from Task 5.) Run `npm test -- src/stores/projectStore.test.ts` → FAIL.

- [ ] **Step 2: implement**

In `src/stores/projectStore.ts`, add to the `ProjectState` interface:
```ts
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setOrder: (ids: string[]) => Promise<void>;
```
and the actions (after `reopenProject`):
```ts
  setPinned: async (id, pinned) => {
    await ipc.setProjectPinned(id, pinned);
    const recent = await ipc.listRecentProjects();
    set({ recent });
  },

  setOrder: async (ids) => {
    await ipc.setProjectOrder(ids);
    const recent = await ipc.listRecentProjects();
    set({ recent });
  },
```

- [ ] **Step 3: run + commit**

Run: `npm test -- src/stores/projectStore.test.ts` → PASS; `npm run typecheck` → clean.
```bash
git add src/stores/projectStore.ts src/stores/projectStore.test.ts
git commit -m "feat(rail): projectStore pin + reorder actions (§9)"
```

---

## Task 7: workspaceStore — archive + rename actions

**Files:**
- Modify: `src/stores/workspaceStore.ts`
- Test: `src/stores/workspaceStore.test.ts`

- [ ] **Step 1: write failing tests**

In `src/stores/workspaceStore.test.ts`, add `archiveWorkspace` + `renameWorkspace` to `mockIpc`, and add:
```ts
describe("workspaceStore — archive & rename", () => {
  beforeEach(() => resetStore());

  it("archive removes the workspace from the rail maps (like remove)", async () => {
    const a = makeWorkspace("p1", "alpha");
    const b = makeWorkspace("p1", "beta");
    useWorkspaceStore.setState({
      workspaces: [a, b],
      activeId: a.id,
      workspacesByProjectId: { p1: [a, b] },
    });
    mockIpc.archiveWorkspace.mockResolvedValueOnce(undefined);

    await useWorkspaceStore.getState().archive(a.id, "/repo", a.worktreePath);

    const s = useWorkspaceStore.getState();
    expect(mockIpc.archiveWorkspace).toHaveBeenCalledWith(a.id, "/repo", a.worktreePath);
    expect(s.workspacesByProjectId.p1.map((w) => w.id)).toEqual([b.id]);
    expect(s.workspaces.map((w) => w.id)).toEqual([b.id]);
    expect(s.activeId).toBeNull();
  });

  it("rename updates the name in both maps", async () => {
    const a = makeWorkspace("p1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [a],
      workspacesByProjectId: { p1: [a] },
    });
    mockIpc.renameWorkspace.mockResolvedValueOnce(undefined);

    await useWorkspaceStore.getState().rename(a.id, "renamed");

    const s = useWorkspaceStore.getState();
    expect(mockIpc.renameWorkspace).toHaveBeenCalledWith(a.id, "renamed");
    expect(s.workspaces[0].name).toBe("renamed");
    expect(s.workspacesByProjectId.p1[0].name).toBe("renamed");
  });
});
```
Run `npm test -- src/stores/workspaceStore.test.ts` → FAIL.

- [ ] **Step 2: implement**

In `src/stores/workspaceStore.ts`, add to the interface:
```ts
  /** Archive a workspace (worktree removed, branch kept) — drops it from the rail. */
  archive: (workspaceId: string, projectPath: string, worktreePath: string | null) => Promise<void>;
  /** Rename a workspace in the backend + both rail maps. */
  rename: (workspaceId: string, name: string) => Promise<void>;
```
and the actions (after `remove`):
```ts
  archive: async (workspaceId, projectPath, worktreePath) => {
    await ipc.archiveWorkspace(workspaceId, projectPath, worktreePath);
    // Archived rows are excluded from list_workspaces, so drop locally just
    // like remove (also prune the git summary for hygiene).
    set((s) => {
      const nextByProject: Record<string, Workspace[]> = {};
      for (const [pid, wss] of Object.entries(s.workspacesByProjectId)) {
        nextByProject[pid] = wss.filter((w) => w.id !== workspaceId);
      }
      const { [workspaceId]: _dropped, ...nextSummaries } = s.gitSummaryByWs;
      return {
        workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
        workspacesByProjectId: nextByProject,
        gitSummaryByWs: nextSummaries,
        activeId: s.activeId === workspaceId ? null : s.activeId,
      };
    });
  },

  rename: async (workspaceId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await ipc.renameWorkspace(workspaceId, trimmed);
    set((s) => {
      const patch = (w: Workspace) => (w.id === workspaceId ? { ...w, name: trimmed } : w);
      const nextByProject: Record<string, Workspace[]> = {};
      for (const [pid, wss] of Object.entries(s.workspacesByProjectId)) {
        nextByProject[pid] = wss.map(patch);
      }
      return {
        workspaces: s.workspaces.map(patch),
        workspacesByProjectId: nextByProject,
      };
    });
  },
```

- [ ] **Step 3: run + commit**

Run: `npm test -- src/stores/workspaceStore.test.ts` → PASS; `npm run typecheck` → clean.
```bash
git add src/stores/workspaceStore.ts src/stores/workspaceStore.test.ts
git commit -m "feat(rail): workspaceStore archive + rename actions (§10, §5.2)"
```

---

## Task 8: ProjectContextMenu — Pin/Unpin + Move up/down (+ Close subtitle)

**Files:**
- Modify: `src/components/ProjectContextMenu.tsx`
- Modify: `src/App.tsx` (project menu render block + handlers)

- [ ] **Step 1: extend the menu component**

In `src/components/ProjectContextMenu.tsx`:
- Add icons to the lucide import: `Pin, PinOff, ChevronUp, ChevronDown`.
- Add props to `Props`:
```ts
  pinned: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onTogglePin: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
```
- Add them to the destructure.
- Insert a new band BETWEEN the edit band (Rename/Tint/Jira) and the danger band (after the `<div className={SEP} />` that precedes "Close project"). Add:
```tsx
      <div className={SEP} />

      <button type="button" role="menuitem" className={ITEM} onClick={run(onTogglePin)}>
        {pinned ? <PinOff size={12} className="shrink-0" /> : <Pin size={12} className="shrink-0" />}
        {pinned ? "Unpin" : "Pin to top"}
      </button>
      {canMoveUp && (
        <button type="button" role="menuitem" className={ITEM} onClick={run(onMoveUp)}>
          <ChevronUp size={12} className="shrink-0" /> Move up
        </button>
      )}
      {canMoveDown && (
        <button type="button" role="menuitem" className={ITEM} onClick={run(onMoveDown)}>
          <ChevronDown size={12} className="shrink-0" /> Move down
        </button>
      )}
```
- While here, update the "Close project" subtitle to mention recovery (Plan 2 made close reversible). Change the subtitle span text from `Removes it from the rail; folder stays on disk` to:
```tsx
          <span className="text-octo-mute">Restore it later from Recently closed</span>
```

- [ ] **Step 2: wire in App.tsx**

In the `projectContextMenu` render block, the `proj` lookup already resolves a `ProjectInfo` (with `pinned` now). Pass the new props. Compute move affordances from the displayed order (`projectGroups`):
```tsx
            pinned={proj.pinned}
            canMoveUp={(() => {
              const idx = projectGroups.findIndex((g) => g.id === projectContextMenu.projectId);
              return idx > 0;
            })()}
            canMoveDown={(() => {
              const idx = projectGroups.findIndex((g) => g.id === projectContextMenu.projectId);
              return idx >= 0 && idx < projectGroups.length - 1;
            })()}
            onTogglePin={() => {
              void setProjectPinnedAction(projectContextMenu.projectId, !proj.pinned);
              setProjectContextMenu(null);
            }}
            onMoveUp={() => {
              const ids = projectGroups.map((g) => g.id);
              const i = ids.indexOf(projectContextMenu.projectId);
              if (i > 0) {
                [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                void setProjectOrderAction(ids);
              }
              setProjectContextMenu(null);
            }}
            onMoveDown={() => {
              const ids = projectGroups.map((g) => g.id);
              const i = ids.indexOf(projectContextMenu.projectId);
              if (i >= 0 && i < ids.length - 1) {
                [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
                void setProjectOrderAction(ids);
              }
              setProjectContextMenu(null);
            }}
```
Add the store selectors near the other project-store selectors in App.tsx:
```tsx
  const setProjectPinnedAction = useProjectStore((s) => s.setPinned);
  const setProjectOrderAction = useProjectStore((s) => s.setOrder);
```
(Read the actual project-menu render block to splice these props in alongside the existing `onRename`/`onClose`/`onDelete`. `projectGroups` is in scope in the component body.)

- [ ] **Step 3: verify + commit**

Run: `npm run typecheck` → clean. `npm test` → green.
```bash
git add src/components/ProjectContextMenu.tsx src/App.tsx
git commit -m "feat(rail): project pin/unpin + move up/down; close subtitle (§9)"
```

---

## Task 9: WorkspaceContextMenu — Archive + Rename (+ RenameDialog)

**Files:**
- Create: `src/components/RenameDialog.tsx`
- Modify: `src/components/WorkspaceContextMenu.tsx`
- Modify: `src/App.tsx` (workspace menu render block + handlers + dialog render)

- [ ] **Step 1: create the rename dialog**

`src/components/RenameDialog.tsx`:
```tsx
import { useState } from "react";

interface Props {
  title: string;
  label: string;
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Minimal single-field rename modal — used for workspace rename (§5.2). */
export function RenameDialog({ title, label, initialValue, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-[300px] rounded-xl border border-octo-hairline bg-octo-panel p-4 shadow-xl"
      aria-label={title}
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
        {title}
      </div>
      <label htmlFor="rename-input" className="mt-3 block font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
        {label}
      </label>
      <input
        id="rename-input"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
        className="mt-1 w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-sans text-[14px] text-octo-ivory outline-none focus:border-octo-brass"
      />
      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          disabled={!trimmed}
          className="rounded-md px-3 py-1.5 font-serif text-[12px] text-octo-brass disabled:opacity-40"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 font-sans text-[12px] text-octo-mute hover:text-octo-sage"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: add Archive + Rename to the workspace menu**

In `src/components/WorkspaceContextMenu.tsx`:
- Add icons to the lucide import: `Archive` (and keep `Pencil`, `Trash2`). Add a `Tag`-free approach — reuse `Pencil` for Rename and change Customize's icon to `Palette` to disambiguate. So: import `Palette` and `Archive`.
- Add props:
```ts
  onRename: () => void;
  onArchive: () => void;
```
- Change the existing "Customize…" button icon from `Pencil` to `Palette`, and ADD a "Rename workspace" item (with `Pencil`) directly ABOVE Customize in the edit band:
```tsx
      <button type="button" role="menuitem" className={ITEM} onClick={run(onRename)}>
        <Pencil size={12} className="shrink-0" /> Rename workspace…
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={run(onCustomize)}>
        <Palette size={12} className="shrink-0" /> Customize…
      </button>
```
- In the `!isMain` danger band, add an **Archive** item ABOVE the Delete item. Archive is recoverable, so it uses the normal `ITEM` style (not `DANGER`), with a subtitle. Restructure the `!isMain` block:
```tsx
      {!isMain && (
        <>
          <div className={SEP} />
          <button type="button" role="menuitem" className={`${ITEM} items-start`} onClick={run(onArchive)}>
            <Archive size={12} className="mt-0.5 shrink-0" />
            <span className="flex flex-col text-left">
              <span>Archive workspace</span>
              <span className="text-octo-mute">Keeps the branch; removes the worktree</span>
            </span>
          </button>
          <button type="button" role="menuitem" className={DANGER} onClick={run(onDelete)}>
            <Trash2 size={12} className="shrink-0" /> Delete workspace…
          </button>
        </>
      )}
```

- [ ] **Step 3: wire in App.tsx (handlers + dialog)**

In the workspace menu render block, pass `onRename` + `onArchive`:
```tsx
            onRename={() => {
              setRenamingWorkspace({ id: ws.id, name: ws.name });
              setContextMenu(null);
            }}
            onArchive={() => {
              setContextMenu(null);
              void useWorkspaceStore.getState()
                .archive(ws.id, proj?.path ?? "", ws.worktreePath ?? null)
                .then(() => pushToast({ level: "success", title: "Workspace archived", body: "The branch is kept." }))
                .catch((err) => pushToast({ level: "error", title: "Archive failed", body: String(err) }));
            }}
```
(`ws` and `proj` are already derived in that render block from Plan 1/2 — confirm by reading it.)

Add the rename dialog state near other modal state:
```tsx
  const [renamingWorkspace, setRenamingWorkspace] = useState<{ id: string; name: string } | null>(null);
```
Add the dialog render near the other overlay modals (e.g. beside the WorkspaceCustomizeMenu overlay):
```tsx
      {renamingWorkspace && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 p-2"
          onClick={() => setRenamingWorkspace(null)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <RenameDialog
              title="Rename workspace"
              label="Name"
              initialValue={renamingWorkspace.name}
              onSubmit={(name) => {
                void useWorkspaceStore.getState().rename(renamingWorkspace.id, name);
                setRenamingWorkspace(null);
              }}
              onCancel={() => setRenamingWorkspace(null)}
            />
          </div>
        </div>
      )}
```
Add the import: `import { RenameDialog } from "./components/RenameDialog";` (match the existing import style/path in App.tsx).

- [ ] **Step 4: verify + commit**

Run: `npm run typecheck` → clean. `npm test` → green. `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.
```bash
git add src/components/RenameDialog.tsx src/components/WorkspaceContextMenu.tsx src/App.tsx
git commit -m "feat(rail): workspace archive + rename (dialog) (§10, §5.2)"
```

---

## Task 10: Quick filter / jump

**Why:** A long rail needs fast narrowing. A single calm input at the top of the rail filters projects + workspaces by name; non-matches hide; matching projects auto-expand while filtering.

**Files:**
- Modify: `src/components/WorkspaceRail.tsx`

- [ ] **Step 1: add the filter state + input**

In `src/components/WorkspaceRail.tsx`:
- Add `import { useState } from "react";` is already present. Add filter state in the component body (near `collapsedProjects`):
```tsx
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
```
- Render the input as the FIRST child of the scroll container `<div className="flex-1 flex flex-col ...">`, only when the rail is expanded:
```tsx
        {!isCollapsed && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setFilter(""); }}
            placeholder="Filter projects & workspaces"
            spellCheck={false}
            aria-label="Filter the rail"
            className="mx-3 mb-2 rounded-md border border-octo-hairline bg-octo-onyx px-2.5 py-1.5 font-mono text-[11px] text-octo-ivory placeholder:text-octo-mute outline-none focus:border-octo-brass"
          />
        )}
```

- [ ] **Step 2: apply the filter to the project map**

Where the rail iterates `projects`, compute the visible workspaces per project and skip non-matching projects. Replace the project `.map(...)` opening so each project derives its matches; for each `project`:
```tsx
        {(projects || []).map((project, projectIndex) => {
          const nameMatch = q === "" || project.name.toLowerCase().includes(q);
          const visibleWs =
            q === "" || nameMatch
              ? (project?.workspaces || [])
              : (project?.workspaces || []).filter((w) =>
                  (w?.name ?? "").toLowerCase().includes(q),
                );
          // While filtering, hide projects with no hit and force-expand matches.
          if (q !== "" && !nameMatch && visibleWs.length === 0) return null;
          const projectExpanded = q !== "" ? true : !collapsedProjects[project.id];
          return (
```
Then inside, change the workspaces render to iterate `visibleWs` and gate on `projectExpanded` instead of `!collapsedProjects[project.id]`:
```tsx
            {(isCollapsed || projectExpanded) &&
              visibleWs.map((ws) => (
                <WorkspaceRow ... />   // keep all existing WorkspaceRow props unchanged
              ))}
```
And update the "No workspaces yet" empty-state condition to use `visibleWs.length === 0` and `projectExpanded`. Close the map callback with `);` + `})` to match the new arrow-function body (it previously used `(project, projectIndex) => ( ... )` — you are converting it to a block body `=> { ... return ( ... ); }`).

IMPORTANT: This converts the map callback from an implicit-return arrow to a block-body arrow. Read the current JSX carefully and keep ALL existing per-project markup (header IIFE, git pulse, collapse chevron, WorkspaceRow props, empty state) intact — only (a) add the `nameMatch`/`visibleWs`/`projectExpanded` derivations, (b) the early `return null` for non-matches, (c) swap `project.workspaces`→`visibleWs` and `!collapsedProjects[project.id]`→`projectExpanded` in the two places they're used. Verify the dirty-count pulse still reads from `project.workspaces` (the pulse should reflect the whole project, not the filtered subset — keep it `project.workspaces`).

- [ ] **Step 3: verify + commit**

Run: `npm run typecheck` → clean. `npm test` → green (the WorkspaceRail test passes projects with no filter; confirm the button-count test still holds — the input is not a button). `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.
```bash
git add src/components/WorkspaceRail.tsx
git commit -m "feat(rail): quick filter for projects & workspaces (§4)"
```

---

## Task 11: Full-plan verification

- [ ] **Step 1: Typecheck + tests + Rust**
```bash
npm run typecheck
npm test
cd src-tauri && cargo test && cd ..
```
All green.

- [ ] **Step 2: Manual smoke test (`npm run tauri:dev`)**

Verify:
- **Pin:** right-click a project → Pin to top → it floats above the others and persists across restart; the item now reads "Unpin".
- **Reorder:** Move up / Move down reorders a project; order persists across restart. Pinned projects always stay above unpinned.
- **Archive:** right-click a non-main workspace → Archive → it disappears from the rail, its worktree folder is gone, but `git branch` still lists its branch. Archive is hidden for the main workspace.
- **Rename:** right-click a workspace → Rename workspace… → the dialog renames it; the rail updates; the name persists across restart. Empty name is rejected.
- **Filter:** type in the rail filter — only matching projects/workspaces show, matches auto-expand; Escape clears.
- Nothing else in the rail regressed (pulse, dots, drawer, collapse, close/reopen all still work).

- [ ] **Step 3: Design-system check**
```bash
git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo "clean"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §9 pin ✓ (T1/T2/T6/T8) + reorder via Move up/down ✓ (drag deferred, documented); §10 archive ✓ (T3/T7/T9); §5.2 rename workspace ✓ (T4/T7/T9); §4 quick filter ✓ (T10); §6.4 pinned/sort_order migration ✓ (T1). Project rename, archive-browse UI, and drag-reorder explicitly out of scope (documented).
- **Placeholder scan:** none — every step has concrete code/commands. Task 1 Step 5 documents the intentional transient backend-arity break resolved by Task 2 (controller-sequenced, same pattern as earlier plans). Several steps say "read the actual X and match its signature" for backend functions whose exact arg shapes (`insert_workspace`, `git_ops::delete_worktree`) must be confirmed at implementation — these are verification instructions, not placeholders (the surrounding code is concrete).
- **Type consistency:** `ProjectInfo.pinned` added in Rust (commands.rs), db tuples (6-tuple), all ProjectInfo constructions, TS type, and test factories. `set_project_pinned(project_id, pinned)` / `set_project_order(ids)` / `archive_workspace(workspace_id, project_path, worktree_path)` / `rename_workspace(workspace_id, name)` command signatures match the ipc wrappers (`setProjectPinned`/`setProjectOrder`/`archiveWorkspace`/`renameWorkspace`) and the store actions (`setPinned`/`setOrder`/`archive`/`rename`). Menu prop names (`pinned`, `canMoveUp/Down`, `onTogglePin`, `onMoveUp/Down`, `onRename`, `onArchive`) match the App wiring. `RenameDialog` props (`title,label,initialValue,onSubmit,onCancel`) match its single call site.
- **Calm/design:** Pin/Move/Rename use mute→brass hover like existing items; Archive is a normal (non-rouge) item with a subtitle since it's recoverable, distinct from rouge Delete; filter input is mono with an upright placeholder (no italics); reorder avoids fragile drag. No new top-level chrome.
