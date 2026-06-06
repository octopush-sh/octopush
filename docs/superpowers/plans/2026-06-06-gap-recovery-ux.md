# Gap-Closing 2 — Recovery UX (Recently-closed on Welcome + Archive Restore) — Plan 6

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Make recovery fully discoverable: surface **Recently closed** projects on the welcome screen (so a closed sole-project is reachable without the rail), and add an **Archive restore** flow (browse a project's archived workspaces and restore them — recreating the worktree from the kept branch).

**Architecture:** WelcomeScreen already renders a "Recent" section from `projectStore.recent`; we add a parallel "Recently closed" section from `projectStore.closed` (clicking opens via `open(path)`, which already clears `closed_at`). For archive: `create_worktree` already attaches to an existing branch, and `db.restore_workspace` (status→active) already exists — so a `restore_workspace` command just recreates the worktree + flips status. A new `list_archived_workspaces` feeds an `ArchivedWorkspacesModal` opened from the project context menu.

**Tech Stack:** React 19 + TS, Zustand, Tauri 2 / Rust + git2, Vitest, cargo test.

**Audit source:** deferrals C (welcome recently-closed) and D (archive restore).

---

## Task 1: Backend — list_archived_workspaces + restore_workspace command

**Files:**
- Modify: `src-tauri/src/db.rs` (`list_archived_workspaces`; confirm `restore_workspace` exists)
- Modify: `src-tauri/src/commands.rs` (`list_archived_workspaces`, `restore_workspace` commands)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: db method to list archived**

READ `list_workspaces` in `db.rs` (it now ends `... WHERE project_id = ?1 AND status != 'archived' ORDER BY created_at ASC`). Add a sibling that lists ONLY archived, with the SAME SELECT columns + row mapping:

```rust
    /// Archived workspaces for a project (status='archived'), newest first.
    pub fn list_archived_workspaces(&self, project_id: &str) -> AppResult<Vec<WorkspaceRow>> {
        // ... same SELECT column list + row construction as list_workspaces,
        // but: WHERE project_id = ?1 AND status = 'archived' ORDER BY created_at DESC
    }
```
Copy the exact SELECT + the `WorkspaceRow { ... }` mapping from `list_workspaces` (do not paraphrase the column list); only change the WHERE (`= 'archived'`) and ORDER (`DESC`).

Confirm `restore_workspace(&self, id)` already exists (it should: `UPDATE workspaces SET status = 'active' WHERE id = ?1`). If it does NOT exist, add it.

- [ ] **Step 2: commands**

In `commands.rs`, add (near `archive_workspace`):

```rust
#[tauri::command]
pub async fn list_archived_workspaces(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Vec<crate::db::WorkspaceRow>> {
    state.db.lock().list_archived_workspaces(&project_id)
}

#[tauri::command]
pub async fn restore_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    project_path: String,
    branch: String,
    worktree_path: Option<String>,
) -> AppResult<()> {
    let project_path = expand_tilde(&project_path);
    // Recreate the worktree from the kept branch (create_worktree attaches to
    // the existing refs/heads/<branch>; it does NOT create a new branch), then
    // flip status back to active. The main worktree never gets archived.
    if let Some(wt) = worktree_path {
        let wt = expand_tilde(&wt);
        crate::git_ops::create_worktree(
            std::path::Path::new(&project_path),
            &branch,
            std::path::Path::new(&wt),
        )?;
    }
    state.db.lock().restore_workspace(&workspace_id)
}
```
(Match `git_ops::create_worktree`'s real signature — it is `create_worktree(repo_path: &Path, branch: &str, worktree_path: &Path)`. Adjust if different.)

- [ ] **Step 3: register**

In `lib.rs`, near `commands::archive_workspace,` add:
```rust
            commands::list_archived_workspaces,
            commands::restore_workspace,
```

- [ ] **Step 4: test**

In `tests.rs` (workspace module; use the REAL `insert_workspace` signature `(id, project_id, name, task, branch, worktree_path: Option<&str>, setup_script)`):
```rust
#[test]
fn archive_then_list_archived_and_restore() {
    let db = test_db();
    db.insert_project("p", "P", "/tmp/octo-arch2-p").unwrap();
    db.insert_workspace("w1", "p", "alpha", "", "feat/a", Some("/tmp/x/a"), "").unwrap();

    db.archive_workspace("w1").unwrap();
    assert!(db.list_workspaces("p").unwrap().is_empty());
    let archived = db.list_archived_workspaces("p").unwrap();
    assert_eq!(archived.len(), 1);
    assert_eq!(archived[0].id, "w1");

    db.restore_workspace("w1").unwrap();
    assert_eq!(db.list_workspaces("p").unwrap().len(), 1);
    assert!(db.list_archived_workspaces("p").unwrap().is_empty());
}
```

- [ ] **Step 5: run + commit**

Run `cd src-tauri && cargo test archive_then_list_archived_and_restore` then full `cargo test`.
```bash
git add src-tauri/src/db.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs
git commit -m "feat(backend): list_archived_workspaces + restore_workspace (§10 restore)"
```

---

## Task 2: Frontend IPC

**Files:**
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: wire commands**

In `src/lib/ipc.ts`, near the workspace commands:
```ts
  listArchivedWorkspaces: (projectId: string) =>
    invoke<Workspace[]>("list_archived_workspaces", { projectId }),
  restoreWorkspace: (workspaceId: string, projectPath: string, branch: string, worktreePath: string | null) =>
    invoke<void>("restore_workspace", { workspaceId, projectPath, branch, worktreePath }),
```
(`Workspace` is already imported. Match the camelCase arg convention used by `deleteWorkspace`/`archiveWorkspace`.)

- [ ] **Step 2: verify + commit**

Run `npm run typecheck` → clean.
```bash
git add src/lib/ipc.ts
git commit -m "feat(ipc): listArchivedWorkspaces + restoreWorkspace"
```

---

## Task 3: Recently-closed on the Welcome screen

**Why:** A closed sole-project currently isn't reachable from the welcome screen. WelcomeScreen already shows "Recent"; add a parallel "Recently closed" section. Clicking opens via `open(path)`, which clears `closed_at` (Plan 2).

**Files:**
- Modify: `src/components/WelcomeScreen.tsx`

- [ ] **Step 1: load + render closed projects**

In `src/components/WelcomeScreen.tsx`:
- Pull `closed` + `loadClosed` from the store: change the destructure to
```tsx
  const { open, loadRecent, recent, loading, error, closed, loadClosed } = useProjectStore();
```
- Load it alongside recent:
```tsx
  useEffect(() => {
    loadRecent();
    loadClosed();
  }, [loadRecent, loadClosed]);
```
- The "Recent" section is currently `absolute bottom-10`. To fit both, render a "Recently closed" row ABOVE "Recent" only when non-empty. Replace the single Recent block's positioning so the two stack. Wrap both in one bottom-anchored column:

Replace the existing `{recent.length > 0 && ( <div className="absolute bottom-10 ..."> ... </div> )}` block with:
```tsx
      {/* Recent + Recently closed, stacked at the foot */}
      {(recent.length > 0 || closed.length > 0) && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-5">
          {recent.length > 0 && (
            <div>
              <div className="mb-3 text-center font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
                Recent
              </div>
              <ul className="flex items-stretch gap-3">
                {recent.slice(0, 5).map((project: ProjectInfo) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => open(project.path)}
                      className="flex items-center gap-2.5 rounded-md px-3 py-2 transition hover:bg-octo-panel"
                      title={project.path}
                    >
                      <span
                        className="flex h-7 w-7 items-center justify-center rounded-md font-serif text-[14px] text-octo-brass"
                        style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
                      >
                        {project.name.charAt(0).toUpperCase() || "?"}
                      </span>
                      <span className="font-serif text-[13px] text-octo-ivory">{project.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {closed.length > 0 && (
            <div>
              <div className="mb-2 text-center font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
                ⟲ Recently closed
              </div>
              <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                {closed.slice(0, 5).map((project: ProjectInfo) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => open(project.path)}
                      className="font-mono text-[11px] text-octo-sage transition hover:text-octo-brass"
                      title={`Reopen ${project.path}`}
                    >
                      {project.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
```
(Keep the existing imports; `closed` is `ProjectInfo[]`. `open(path)` reopens because the backend `open_project` clears `closed_at`.)

- [ ] **Step 2: verify + commit**

Run `npm run typecheck` → clean. `npm test` → green (WelcomeScreen may have a test; if it mocks the store, ensure `closed`/`loadClosed` are present in the mock — add them if the test fails, note it). `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.
```bash
git add src/components/WelcomeScreen.tsx
git commit -m "feat(welcome): Recently closed projects section (B1 discoverability)"
```

---

## Task 4: Archived-workspaces modal + project-menu entry

**Why:** Give archived workspaces a browse/restore home. Opened from the project context menu; lists that project's archived workspaces with a Restore action.

**Files:**
- Create: `src/components/ArchivedWorkspacesModal.tsx`
- Modify: `src/components/ProjectContextMenu.tsx` (add an "Archived workspaces…" item)
- Modify: `src/App.tsx` (state + render + handler)

- [ ] **Step 1: create the modal**

`src/components/ArchivedWorkspacesModal.tsx`:
```tsx
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import type { Workspace } from "../lib/types";

interface Props {
  projectId: string;
  projectName: string;
  projectPath: string;
  /** Called after a successful restore so the parent can refresh the rail. */
  onRestored: (projectId: string) => void;
  onClose: () => void;
}

export function ArchivedWorkspacesModal({
  projectId,
  projectName,
  projectPath,
  onRestored,
  onClose,
}: Props) {
  const [items, setItems] = useState<Workspace[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ipc.listArchivedWorkspaces(projectId)
      .then((ws) => { if (alive) setItems(ws); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [projectId]);

  async function restore(w: Workspace) {
    setBusyId(w.id);
    try {
      await ipc.restoreWorkspace(w.id, projectPath, w.branch, w.worktreePath ?? null);
      setItems((prev) => (prev ?? []).filter((x) => x.id !== w.id));
      onRestored(projectId);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="w-[360px] rounded-xl border border-octo-hairline bg-octo-panel p-4 shadow-xl" aria-label="Archived workspaces">
      <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
        Archived · {projectName}
      </div>
      <div className="mt-3 max-h-[300px] overflow-y-auto">
        {items === null ? (
          <div className="py-4 text-center font-mono text-[11px] text-octo-mute">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-4 text-center font-mono text-[11px] text-octo-mute">No archived workspaces</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((w) => (
              <li key={w.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-octo-panel-2">
                <span className="flex-1 truncate text-[13px] text-octo-sage">{w.name}</span>
                <span className="truncate font-mono text-[10px] text-octo-mute">{w.branch}</span>
                <button
                  type="button"
                  onClick={() => void restore(w)}
                  disabled={busyId === w.id}
                  className="font-mono text-[10px] text-octo-brass disabled:opacity-40"
                >
                  {busyId === w.id ? "Restoring…" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 font-sans text-[12px] text-octo-mute hover:text-octo-sage">
          Close
        </button>
      </div>
    </div>
  );
}
```
(Uses `bg-octo-panel-2` which the rail already uses; if that token isn't valid, use `bg-octo-onyx`.)

- [ ] **Step 2: project-menu item**

In `src/components/ProjectContextMenu.tsx`:
- Add `Boxes` (or reuse `Archive`) to the lucide import for the icon.
- Add prop `onViewArchived: () => void;` to `Props` + destructure.
- In the edit band (after "Set Jira project key…", before the pin band's `<div className={SEP} />`), add:
```tsx
      <button type="button" role="menuitem" className={ITEM} onClick={run(onViewArchived)}>
        <Archive size={12} className="shrink-0" /> Archived workspaces…
      </button>
```
(Use the already-imported `Archive` icon.)

- [ ] **Step 3: wire in App.tsx**

- Import: `import { ArchivedWorkspacesModal } from "./components/ArchivedWorkspacesModal";`
- State: `const [archivedForProject, setArchivedForProject] = useState<{ id: string; name: string; path: string } | null>(null);`
- In the `<ProjectContextMenu>` JSX, add:
```tsx
            onViewArchived={() => {
              setArchivedForProject({ id: proj.id, name: proj.name, path: proj.path });
              setProjectContextMenu(null);
            }}
```
- Render the modal near the other overlay modals:
```tsx
      {archivedForProject && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 p-2"
          onClick={() => setArchivedForProject(null)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <ArchivedWorkspacesModal
              projectId={archivedForProject.id}
              projectName={archivedForProject.name}
              projectPath={archivedForProject.path}
              onRestored={(pid) => { void loadAllWorkspaces([pid]); }}
              onClose={() => setArchivedForProject(null)}
            />
          </div>
        </div>
      )}
```
(`loadAllWorkspaces` is already destructured from `useWorkspaceStore` in App and refreshes a project's group in `workspacesByProjectId` without disturbing the active workspace — exactly what we want so a restored workspace reappears in the rail. Confirm it's in scope; it is, used by the startup/project-set effect.)

- [ ] **Step 4: verify + commit**

Run `npm run typecheck` → clean. `npm test` → green (if ProjectContextMenu.test.tsx spreads baseProps, add `onViewArchived: vi.fn()`; note it). `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.
```bash
git add src/components/ArchivedWorkspacesModal.tsx src/components/ProjectContextMenu.tsx src/App.tsx
git commit -m "feat(rail): archived-workspaces browse + restore modal (§10)"
```

---

## Task 5: Full verification

- [ ] `npm run typecheck && npm test && (cd src-tauri && cargo test)` — all green.
- [ ] `git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo clean`.
- [ ] Manual: archive a workspace → right-click its project → "Archived workspaces…" → see it → Restore → it reappears in the rail with its branch's worktree recreated. Close a project → it appears under "Recently closed" on the welcome screen and reopens on click.

---

## Self-Review (during planning)

- **Coverage:** welcome recently-closed (T3), archive restore end-to-end (T1 backend, T2 ipc, T4 UI). `create_worktree` attaches to the existing branch (verified git_ops.rs:302-310), so restore needs no branch-reuse logic. `db.restore_workspace` already exists.
- **Placeholders:** none. T1 Step 1 says to copy the exact SELECT/mapping from `list_workspaces` (verification instruction, not a blank).
- **Consistency:** `restore_workspace(workspace_id, project_path, branch, worktree_path)` ↔ ipc `restoreWorkspace(workspaceId, projectPath, branch, worktreePath)` ↔ modal call. `list_archived_workspaces(project_id)` ↔ `listArchivedWorkspaces(projectId)`. Modal `onRestored` → `loadAllWorkspaces([pid])` refreshes the rail group. WelcomeScreen reuses `open(path)` (clears closed_at).
- **Calm/design:** Recently-closed on welcome is muted sage→brass-hover text (matches Recent); archived modal reuses overlay + tokens; project menu gains one item (hidden until right-click — no rail clutter).
