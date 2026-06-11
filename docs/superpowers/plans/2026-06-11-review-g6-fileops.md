# G6 Slice II · File Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Design basis: G6 spec (`docs/superpowers/specs/2026-06-09-review-g6-file-explorer-design.md`, slice II of the 3-slice plan) + design-system §9 doctrine (no italics, no arrow glyphs in buttons, icons + tooltips, calm motion, ConfirmDialog for destructive ops).

**Goal:** Rename / new file / new folder / delete from the Companion file tree's context menu, with safe path-contained backend commands and in-place tree refresh (no full reload).

**Architecture:** Four Rust commands with canonical path-containment guards (the `commands.rs:3260` `starts_with(ws_canon)` pattern): `fs_rename(workspace_path, from, to)`, `fs_create_file(workspace_path, parent, name)`, `fs_create_dir(...)`, `fs_delete(workspace_path, target)` (delete = permanent `remove_file`/`remove_dir_all`, gated by ConfirmDialog in the UI; refuse `.git` and the workspace root itself). Frontend: `FileTreeContextMenu` gains a mutating section (files: Rename/Delete; dirs: New file/New folder/Rename/Delete); names are captured with a small `ModalShell` prompt (`FileNameDialog`, shared for all four ops, validates: non-empty, no `/`, no leading `..`); after success the tree force-refetches the affected parent dir(s) via a new `refreshDir(path)` callback threaded from CompanionFileTree (reuses `fetchChildren(path, {force:true})` + gen guard) — no cache-wide invalidation needed.

**Branch:** `feat/review-g6-fileops` off main, worktree `octopus-sh-review`.

---

### Task 1: Backend — fs commands

**Files:** `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/tests.rs`, `src/lib/ipc.ts`

- [ ] Helper `fn contained_path(workspace_path: &str, rel_or_abs: &str) -> AppResult<std::path::PathBuf>`: expand_tilde both, canonicalize the workspace root; for the target canonicalize its PARENT (the leaf may not exist yet for creates) and verify `starts_with` the root canon (mirror commands.rs:3260); refuse any path whose file_name is `.git` or that equals the root. Return the joined absolute path.
- [ ] Commands (async, `AppResult`): `fs_rename(workspace_path, from, to)` — both contained; `to` must not exist (`AppError::Other("destination already exists")`); `std::fs::rename`. `fs_create_file(workspace_path, parent, name)` — contained parent + simple-name validation (`name` non-empty, no `/` or `\\`, not `.`/`..`); error if exists; `std::fs::write(p, "")`. `fs_create_dir` — same but `create_dir`. `fs_delete(workspace_path, target)` — contained; `remove_dir_all` for dirs, `remove_file` for files. Register all four in lib.rs; ipc bindings `fsRename/fsCreateFile/fsCreateDir/fsDelete`.
- [ ] Tests (tempdir): rename happy + dest-exists error; create file/dir happy + exists error + bad-name error; delete file + dir; CONTAINMENT: a `from`/`target` escaping via `../outside.txt` errors; `.git` refused; root refused. `cargo test` green + typecheck. Commit `feat(review/g6): contained fs commands — rename, create file/dir, delete`.

### Task 2: Frontend — menu ops + tree refresh

**Files:** `src/components/FileTreeContextMenu.tsx`, `src/components/FileNameDialog.tsx` (new), `src/components/CompanionFileTree.tsx`, + tests

- [ ] `CompanionFileTree`: thread a `refreshDir = (dirPath: string) => void fetchChildren(dirPath, { force: true })` into the menu render; after any op also refresh the PARENT of a renamed/deleted entry (compute from the path: `path.slice(0, path.lastIndexOf("/"))`, falling back to rootPath) and keep `treeStateCache` coherent (force-fetch writes through existing state effects — verify).
- [ ] `FileNameDialog` (ModalShell): props `{ title, label, initial?, confirmLabel, onSubmit, onClose }`; single input (autoFocus — ModalShell preserves it), mono text, inline rouge validation (`octo-rise-in`) for empty/`/`-containing names; Enter submits; quiet Cancel.
- [ ] `FileTreeContextMenu`: new section under a SEP — dirs: `FilePlus` "New file", `FolderPlus` "New folder", then both: `Pencil` "Rename", and a DANGER-styled `Trash2` "Delete" (uses the existing DANGER class from ProjectContextMenu). Flows: New → FileNameDialog → `fsCreateFile/Dir(workspacePath=rootPath, parent=path, name)` → toast + `refreshDir(path)`; Rename → dialog (initial = current name) → `fsRename(rootPath, path, parentDir + "/" + newName)` → toast + refresh parent; Delete → `ConfirmDialog` ("Delete {name}? This cannot be undone." destructive) → `fsDelete` → toast + refresh parent. Errors → error toasts. Menu dismisses before dialogs open (dialog state lives in CompanionFileTree alongside `menu`).
- [ ] Tests (ipc mocked): dirs show all four ops, files only Rename/Delete; create flow calls ipc with parent+name and refreshes (assert readDirectory re-called with force semantics — last call for the dir); rename passes computed `to`; delete confirms first; invalid name shows inline error and does NOT call ipc. Doctrine: icons + titles on every item, no glyphs, tokens only. Full suite + typecheck. Commit `feat(review/g6): file operations from the tree — new file/folder, rename, delete`.

---

## Done criteria
All four ops work from the tree with containment-guarded backends, the affected directory refreshes in place (rows rise in; no full-tree reload), delete is confirm-gated, validation inline, zero doctrine violations, suites green.
