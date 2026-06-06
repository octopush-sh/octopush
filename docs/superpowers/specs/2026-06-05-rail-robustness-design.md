# Left Rail — Robustness Pass · Design

**Date:** 2026-06-05
**Status:** Approved design — ready for implementation planning
**Surface:** Left Rail (`src/components/WorkspaceRail.tsx` and its context menus), the project/workspace stores, and the supporting Rust backend.

---

## 1. Goal & philosophy

The Rail is where projects and their workspaces live. Today it is *basic*: a flat list, a leading `—` before each project name, no way to reach a project/workspace on disk, no signal about git state, and a "Close project" that silently destroys the record. This pass makes the Rail a genuinely useful daily driver **without** adding visual clutter or breaking the *Atelier in Onyx & Brass* identity.

Guiding constraints (from `CLAUDE.md` + user memory):
- **Calm, not busy.** One brass accent, used surgically. Most of the rail stays Onyx/Panel/Sage. New signal must be quiet and collapsible.
- **No italics anywhere** (house rule overrides the design system's italic-serif). Serif is used upright for "moments" only.
- **Tokens, never literals.** All colors/spacing via CSS variables / Tailwind theme tokens.
- **English-only UI copy.** Jira-returned data (status names, summaries) is the sole exception.
- **Distinctive over generic.** Avoid the Cursor/Linear/VS Code "file-explorer sidebar" cliché.

This is delivered as **one spec** (user's explicit choice) covering every approved item, organized into sections so implementation can proceed in coherent slices.

---

## 2. Scope

**In scope** — all approved in brainstorming:

*Visual / structure*
- Project icon (faceted-hex linework mark) replacing the `—` hyphen.
- Per-project git "pulse" summary (collapsible).
- Per-workspace status dots (uncommitted / ahead-behind / open PR) + linked ticket key.
- "Recently closed" drawer at the foot of the rail.
- Considered empty states (no projects / project with no workspaces).
- Persist per-project collapsed state across sessions.

*Project actions (context menu)*
- Reveal in Finder · Copy path.
- Open in editor · Open in terminal.
- Reorganized menu with a clear danger band; **Close** made safe + reversible; **Delete from disk** clearly destructive.
- Reorder (drag) + Pin projects.

*Workspace actions (context menu)*
- Reveal worktree in Finder · Copy path · Copy branch name.
- Open in editor · Open in terminal.
- Rename workspace.
- Archive workspace (keep branch, drop worktree + rail row).
- **Remove "Skip Jira here"** entirely.
- Hide "Delete" for the main workspace.

*Navigation*
- Quick filter / jump over projects + workspaces.

*Bugs (the two reported)*
- B1 — "Close" deletes the project record with no way back → soft-close + reopen.
- B2 — "Skip Jira" is redundant → removed.

*Correctness fixes (found during the bug hunt)* — see §11.

**Out of scope (future waves, documented for continuity):**
- Project-level "default agent model / tool permissions / workspace presets" (already stubbed as "coming soon" in `ProjectContextMenu.tsx`).
- Cross-project global search of file *contents* (this spec only filters rail entries).
- Real-time push of git state from a filesystem watcher (we poll/refresh on a schedule + on focus — see §6.3).

---

## 3. Design principles for the new signal

The rail gains three kinds of new information (project pulse, workspace dots, recently-closed). To keep it calm:

1. **Signal is monochrome by default; brass only for "needs you".** Uncommitted changes → brass dot. Clean/ahead → muted verdigris at low opacity. The eye is drawn only to what's actionable.
2. **Everything new is collapsible and remembers its state.** The pulse hides when a project is collapsed; "Recently closed" is a closed drawer by default.
3. **No row grows taller.** Status dots and ticket keys sit in the existing row's trailing space; we do not add a second line.
4. **Brass rules grow, they don't blink.** Any reveal animation uses the existing `brassgrow` / `--ease-octo` motion. No spinners in the rail.

---

## 4. Visual design

### 4.1 Project icon — faceted hex (approved: option A)

Replace the leading `—` (`WorkspaceRail.tsx:69`) with an 18–20px **faceted-hexagon mark in brass linework** (outline, ~1.3px stroke, with a small brass core dot). Rationale: a project is a *container*; rendering it as an outline mark while workspaces keep their **filled tinted monograms** creates an immediate visual hierarchy (outline = container, fill = leaf).

- Implemented as an inline SVG component, e.g. `src/components/icons/ProjectMark.tsx`, stroke = `var(--brass)`.
- One shared mark for all projects (color stays on workspaces). No per-project tint on the mark itself — but the existing project "Change tint" action continues to tint the project *name/accent*, not the hex.
- Sits in the project header row, replacing the hyphen span; name shifts from `text-octo-mute`/hyphen styling to `text-octo-ivory` mono uppercase (already the project name style) for stronger hierarchy.

### 4.2 Project git pulse

A compact, right-aligned summary on the project header row, visible only when the project is **expanded**:

- `●N` (brass dot + count) — number of workspaces with uncommitted changes.
- `▱N` (verdigris keyline square + count) — number of open PRs across the project's workspaces.
- When everything is clean and no PRs: a single low-opacity verdigris dot (quiet "all clear").
- The chevron (`⌄`/`›`) for collapse/expand sits at the far right.

Data source: derived in the frontend from each workspace's git status (§6.3), aggregated per project. No new dedicated backend aggregate command — the rail already needs per-workspace status for §4.3, and aggregates client-side.

### 4.3 Workspace status dots

In each workspace row's trailing area (right of the name), in this order when present:

- **Linked ticket key** (e.g. `OCT-214`) in mono `text-octo-sage`, when `resolveLinkage` yields a *manual* link or a *validated* detected key (see §11, B-detect).
- **`↑N` / `↓N`** ahead/behind counts in mono `text-octo-mute` (omitted when zero).
- **Brass dot** when the worktree has uncommitted changes.
- **Verdigris keyline square** when the workspace has an open PR.

All optional; a clean, unlinked workspace shows nothing (calm default). These reuse the data fetched in §6.3.

### 4.4 "Recently closed" drawer

A collapsed drawer pinned above the "Begin a new study" footer:

- Header: `⟲ Recently closed` (mono, muted), with a count and chevron.
- Each entry: project faceted-hex (dimmed) + name + a `Restore` affordance revealed on hover (brass).
- Lists projects closed via §7, most-recent first, capped at the **last 10**; older closed projects remain restorable only via "Open project…" (file picker). The drawer hides entirely when empty.
- Clicking an entry (or `Restore`) re-opens the project (§7).

### 4.5 Empty states

- **No projects at all:** centered, calm copy in the rail body in Octopush's voice — a serif (upright) line plus the brass `⟶` and the "Begin a new study" CTA. No illustration.
- **Project expanded with no workspaces:** a single muted line under the header ("No workspaces yet") above the existing "+ Open a new workspace" row.

### 4.6 Persist collapsed state

Per-project expanded/collapsed state persists across sessions via `localStorage` (same pattern as `lastActiveByProject`), keyed by project id. New projects default to expanded.

---

## 5. Context menus

Both menus are reorganized into bands separated by hairline rules: **Reach on disk → Edit → Integrations → Danger**. Destructive items sit alone at the bottom in `text-octo-rouge`.

### 5.1 Project menu (`ProjectContextMenu.tsx`)

```
<project name>            (section label, mono)
  ↗  Reveal in Finder
  ⧉  Copy path
  ⌥  Open in editor
  ›_ Open in terminal
  ──────────
  ✎  Rename project
  ◐  Change tint
  ◈  Set Jira project key…        (when issue tracker configured)
  ──────────
  📌 Pin to top / Unpin            (toggles; label reflects state)
  ──────────
  ⟲  Close project                 (danger-tinted but reversible)
        "Hides it — restore from Recently closed"
  ⌫  Delete from disk…             (rouge; destructive confirm)
        "Removes the folder permanently"
```

- "Close" and "Delete from disk" both live in the danger band but are visually distinct: Close carries a reassuring subtitle; Delete keeps the existing destructive confirmation modal.
- Remove the disabled "coming soon" stubs from the visible menu (Project settings / Default agent model / Tool permissions / Workspace presets) — they are out of scope and add noise. (Tracked for a future wave.)

### 5.2 Workspace menu (`WorkspaceContextMenu.tsx`)

```
<workspace name> · <ticket?>     (section label, mono)
  ↗  Reveal worktree in Finder
  ⧉  Copy path
  ⎇  Copy branch name
  ⌥  Open in editor
  ›_ Open in terminal
  ──────────
  ✎  Rename workspace
  ◐  Customize…                   (existing glyph/tint editor)
  ──────────
  ◈  Link Jira ticket… / Change Jira ticket… / Unlink   (state-dependent, as today minus Skip)
  ──────────
  ⊟  Archive workspace            (non-main only)
        "Keeps the branch; removes the worktree"
  ⌫  Delete workspace…            (rouge; non-main only)
        "Removes worktree + branch from disk"
```

- **"Skip Jira here" is removed** (B2). The `onSkipJira` prop, its handler in `App.tsx`, and the `dismissed` write path are deleted. See §8.
- For the **main** workspace (`worktreePath === project root`), both **Archive** and **Delete** are hidden — the root cannot be removed, so the menu never offers a lying action (B6).

### 5.3 Shared menu fixes (apply to both)

- **Viewport clamping:** clamp `left/top` so the menu never renders off-screen (B9).
- **Consistent dismissal:** remove `ProjectContextMenu`'s `onMouseLeave={onDismiss}` (B8); both menus dismiss on outside-click (ignoring right-button, as `WorkspaceContextMenu` already does) and on Escape.
- **Keyboard nav (a11y):** move focus into the menu on open, support ↑/↓ + Enter, restore focus to the trigger on close (B10).

---

## 6. Backend & data: new actions

### 6.1 Reach-on-disk actions

Reuse / extend existing commands:
- **Reveal in Finder** — `reveal_in_finder(path)` already exists (`commands.rs:655`). Wire it to both menus via `ipc.ts`.
- **Copy path / Copy branch name** — pure frontend (`navigator.clipboard`); no backend. Path = `ProjectInfo.path` or `Workspace.worktreePath`; branch = `Workspace.branch`. Toast on copy.
- **Open in terminal** — new command `open_in_terminal(path)`. macOS: `open -a Terminal <path>`; Linux: try `$TERMINAL`, then common emulators; Windows: `wt`/`cmd`. Cross-platform helper alongside the existing `open_file_in_system`.

### 6.2 Open in editor (approved: configurable command + autodetection)

- New `AppSettings.editor_command: Option<String>` in `settings.rs` (persisted to `~/.octopush/settings.json`).
- New command `detect_editors() -> Vec<EditorChoice>` that probes `PATH` for known CLIs (`code`, `cursor`, `subl`, `zed`, `idea`, `nvim`/`vim` in a terminal) and returns those found.
- New command `open_in_editor(path)`:
  1. If `editor_command` is set, run it with the path argument.
  2. Else, use the first autodetected editor.
  3. Else, fall back to `open_file_in_system(path)` (OS default for the folder) and surface a one-time hint toast suggesting the user set an editor command in Settings.
- A minimal Settings field ("Editor command") lets the user override; autodetection means it works out-of-the-box for most. Full editor-picker UI is out of scope — a single text field + the detected default is enough for v1.

### 6.3 Git status for the rail (pulse + dots)

The rail needs per-workspace: `dirty: bool`, `ahead: u32`, `behind: u32`, `prState`. PR state already flows in elsewhere (ContextHeader receives `pr`); reuse that source. Dirty/ahead/behind:
- New lightweight command `workspace_git_summary(worktree_path) -> { dirty, ahead, behind }` using `git status --porcelain` + `git rev-list --left-right --count @{u}...HEAD` (guarded when there is no upstream). There are already many `git` invocations in `commands.rs` to model this on.
- **Performance:** the rail fetches summaries lazily and cached: on project expand, on window focus, and after operations that change git state (commit, create/delete workspace). Results live in the workspace store keyed by workspace id with a short TTL; we do **not** poll on a tight timer. A batch command `workspaces_git_summary(project_id)` computes all of a project's worktrees in one call to avoid N IPC round-trips.

### 6.4 Schema changes (`db.rs`, via the established `ALTER TABLE` migration pattern)

- `projects.closed_at TEXT NULL` — soft-close timestamp (§7).
- `projects.pinned INTEGER NOT NULL DEFAULT 0` and `projects.sort_order INTEGER` — pin + manual order (§9).
- Workspaces already have a `status` column (default `'active'`) — **reuse it**: archive sets `status = 'archived'` (§10). No new workspace column needed for archive.

---

## 7. Soft-close & reopen (Bug B1)

Today `close_project` calls `delete_project` (`commands.rs:1078`) — it deletes the DB row; the folder survives but the app forgets it, with no way back.

**New behavior:**
- `close_project(id)` sets `projects.closed_at = now()` instead of deleting. The row, its workspaces, terminals, and chats are preserved.
- `list_recent_projects()` returns only rows with `closed_at IS NULL` for the main rail; a new `list_closed_projects()` (or a flag on the existing call) feeds the "Recently closed" drawer (last 10 by `closed_at DESC`).
- `reopen_project(id)` clears `closed_at` and bumps `last_opened`; the project returns to the rail in its prior place.
- If the **currently-open** project is closed, the frontend clears `current` and active workspace (fixing B2-close-desync, §11): `handleCloseProject` must mirror `handleConfirmDeleteProject`'s `useProjectStore.getState().close()` and pick a sensible next active project (or the empty state).
- `delete_project` (hard delete from disk) is unchanged in mechanism but is the **only** destructive path, reached exclusively via "Delete from disk…".

The store (`projectStore.ts`) gains `closed: ProjectInfo[]`, plus `closeProject`/`reopenProject` actions that call the backend and keep `recent`/`closed`/`current` consistent in a single place (no more split between local `close()` and `ipc.closeProject`).

---

## 8. Remove "Skip Jira" (Bug B2)

The bug hunt confirmed `issueLinkDismissed` suppresses **no** nudge anywhere — it only toggles which menu item shows. It is dead UX. Remove it:

- Delete the "Skip Jira here" item and `onSkipJira` from `WorkspaceContextMenu.tsx`.
- Delete the skip handler in `App.tsx` and stop writing `dismissed = true`.
- `resolveLinkage` (`issueTrackerSelectors.ts`) drops the `"dismissed"` branch; `LinkageState` becomes `linked | unlinked`. `linkageKind` in `App.tsx` collapses to two states.
- Keep the `issue_link_dismissed` **column** for now (harmless; avoids a destructive migration) but stop reading/writing it. Note it as removable in a later cleanup.

This also resolves the interaction noted in the hunt where, for a *detected* key, skip was a guaranteed no-op.

---

## 9. Reorder & pin projects

- **Pin:** `projects.pinned` toggled from the project menu. Pinned projects sort to the top of the rail, above unpinned, each group ordered by `sort_order` then `last_opened`.
- **Reorder:** drag a project header to set `sort_order`. Persist via a new `set_project_order(ids: Vec<String>)` command that rewrites `sort_order` in one transaction. Drag uses the existing motion tokens; no third-party DnD lib unless one is already present — prefer a minimal pointer-based reorder.
- Workspace reordering within a project is **out of scope** for this pass (workspaces stay sorted by `last_active`), to keep the surface focused.

---

## 10. Archive workspace

- New command `archive_workspace(id)` sets `status = 'archived'` and removes the **worktree** from disk (like delete) **but keeps the branch**. `list_workspaces` excludes archived rows from the rail by default.
- Distinct from delete: delete removes worktree **and** branch and the DB row; archive is recoverable (the branch still exists; re-creating a workspace from that branch restores work).
- An "Archived" affordance to browse/restore archived workspaces is **out of scope** for v1 (documented as a follow-up); archive simply tidies the rail and frees the worktree. *(If the user wants restore-from-archived in v1, it folds into the "Recently closed"-style drawer pattern.)*
- Hidden for the main workspace (§5.2).

---

## 11. Correctness fixes (from the bug hunt)

These ride along in the relevant sections above; listed here for tracking:

- **C1 (High) — customization desync.** `workspaceStore.updateCustomization` updates `workspaces` but not `workspacesByProjectId`, which is what the rail renders. Update both (the rail icon currently stays stale until a project switch). *(Folds into §4 work.)*
- **C2 (High) — closing active project leaves stale `current`.** `handleCloseProject` never clears `current` (unlike delete). Fixed by §7's single-source store action.
- **C3 (Med) — creating a workspace for a non-active project corrupts the active list.** `workspaceStore.create` unconditionally appends to `s.workspaces` and sets `activeId`. Make `create` project-aware: write into `workspacesByProjectId[projectId]`, and only touch `workspaces`/`activeId` when `projectId === current`. *(Touches the per-project "+" in §5.)*
- **C4 (Med) — hooks-after-return in `WorkspaceRow`.** Hooks are called after two `return null` paths; a throwing `resolveMonogram` changes hook count → crash. Move all hooks above the early returns.
- **C5 (Med) — `detectIssueKey` false positives** (`UTF-8`, `RFC-2616`, `V2-3`, …). Tighten the regex and/or gate detection on the configured Jira project key prefix so only plausible keys auto-link (§4.3 ticket display depends on this).
- **C6 (Med) — delete offered for main workspace with lying copy.** Hide Archive/Delete for main (§5.2); backend already refuses branch removal but still deletes the row — guard the row deletion too.
- **C7 (Low/Med) — project menu no-ops for a just-created active project.** Render guard checks only `recentProjects`; fall back to `current` (mirror the Jira modals).
- **C8 (Low) — `workspacesByProjectId` never pruned** for closed/deleted projects. Prune on close/delete.

---

## 12. Affected files (map)

*Frontend*
- `src/components/WorkspaceRail.tsx` — icon, pulse, status dots, recently-closed drawer, empty states, collapsed persistence, hooks fix (C4), reorder/pin.
- `src/components/ProjectContextMenu.tsx` — reorg, new actions, danger band, clamping, dismissal/a11y, pin.
- `src/components/WorkspaceContextMenu.tsx` — reorg, new actions, remove Skip (B2), hide delete for main (C6), clamping/a11y.
- `src/components/icons/ProjectMark.tsx` — new faceted-hex SVG.
- `src/stores/projectStore.ts` — `closed`, `closeProject`/`reopenProject`, pin/order, single source of truth (C2).
- `src/stores/workspaceStore.ts` — project-aware `create` (C3), customization to `workspacesByProjectId` (C1), git-summary cache, prune (C8), archive.
- `src/lib/ipc.ts` — new commands wired.
- `src/lib/issueTrackerSelectors.ts` — drop `dismissed` (B2).
- `src/lib/detectIssueKey.ts` — tighten (C5).
- `src/App.tsx` — close/reopen handlers, remove skip handler, render-guard fallback (C7), wire new menu actions.

*Backend*
- `src-tauri/src/commands.rs` — `close_project` (soft), `reopen_project`, `list_closed_projects`, `open_in_terminal`, `open_in_editor`, `detect_editors`, `workspaces_git_summary`, `archive_workspace`, `set_project_order`, pin update.
- `src-tauri/src/db.rs` — migrations (`closed_at`, `pinned`, `sort_order`), reuse `status` for archive, soft-close queries.
- `src-tauri/src/settings.rs` — `editor_command`.
- `src-tauri/src/lib.rs` — register new commands in the invoke handler.

---

## 13. Testing

- **Rust (`tests.rs`):** soft-close keeps row + reopen clears `closed_at`; `list_recent_projects` excludes closed; archive sets status + removes worktree but keeps branch; `set_project_order` persists; `detect_editors` returns sane results; git-summary parses dirty/ahead/behind.
- **Frontend (Vitest):** `detectIssueKey` rejects `UTF-8`/`RFC-2616`/`V2-3` and accepts real keys (C5); `workspaceStore.create` writes to the correct project and doesn't pollute `workspaces` when target ≠ current (C3); `updateCustomization` updates `workspacesByProjectId` (C1); `resolveLinkage` is now two-state (B2); store close/reopen keeps `recent`/`closed`/`current` consistent (C2).
- **Manual:** `npm run typecheck` clean; right-click menus clamp at screen edges and navigate by keyboard; rail density review against the design system before merge.

---

## 14. Rollout

Single spec, but implementation is sequenced low-risk → high-risk so each slice is independently shippable & reviewable:

1. **Foundations & quick wins:** project icon, empty states, collapsed persistence, copy path / copy branch, reveal, open in terminal/editor (+ settings field), context-menu reorg, remove Skip Jira, C4/C6/C7/C8/C1.
2. **Bugs with data model:** soft-close + reopen + Recently-closed drawer (B1, C2), project-aware create (C3).
3. **Signal:** git pulse + workspace status dots (+ `workspaces_git_summary`, C5 tightening).
4. **Scale:** pin + reorder, archive, quick filter/jump.

Each step ends green (`npm run typecheck`, `npm test`, `cargo test`) before the next begins.
