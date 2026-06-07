# Loose Ends — name/tint source-of-truth, ContextHeader C5, dead-code cleanup — Plan 13

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Close the documented loose ends: (A1) make the backend the source of truth for project name/tint so customizations survive a localStorage clear; (A2) gate the ContextHeader's active-ticket detection on the project's Jira key (C5) so a branch like `fix/UTF-8` doesn't show a fake ticket; (B3) remove the now-dead `issueLinkDismissed`; (B4) remove the now-unused `touch_project`.

**Tech Stack:** Rust + rusqlite, React 19 + TS, Zustand, Vitest, cargo test.

---

## Task 1: Backend — expose `tint` on ProjectInfo (A1 part 1)

**Why:** The `projects.tint` column exists (Plan 5) but `ProjectInfo` / `list_projects` don't return it, so the rail can't read it. Add it (same pattern as `pinned` in Plan 4).

**Files:** `src-tauri/src/db.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/tests.rs`.

- [ ] **Step 1: db — select tint (list_projects → 7-tuple, get_project, list_closed_projects)**

In `db.rs`, `list_projects` currently returns `Vec<(String,String,String,String,Option<String>,bool)>` (id,name,path,last_opened,jira_project_key,pinned) with `SELECT id, name, path, last_opened, jira_project_key, pinned FROM projects WHERE closed_at IS NULL ORDER BY ...`. Add `tint` as a trailing column:
```rust
    pub fn list_projects(
        &self,
    ) -> AppResult<Vec<(String, String, String, String, Option<String>, bool, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened, jira_project_key, pinned, tint FROM projects \
             WHERE closed_at IS NULL \
             ORDER BY pinned DESC, sort_order IS NULL, sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, i64>(5)? != 0, r.get(6)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
```
Do the SAME for `list_closed_projects` (add `, tint` to SELECT + `r.get(6)?` + the 7-tuple return type).
In `get_project` (which builds `ProjectInfo` directly), add `tint` to its SELECT and the constructed struct: `tint: r.get(4)?` (read the actual column order — append tint after `pinned` in both the SELECT and the `get` index).

- [ ] **Step 2: commands — ProjectInfo.tint + every construction site**

In `commands.rs`, add to `ProjectInfo` (after `pinned`): `pub tint: Option<String>,`.
Update EVERY `ProjectInfo { ... }` construction (grep `ProjectInfo {` in commands.rs + db.rs):
- `list_recent_projects` mapper: destructure the 7-tuple `|(id, name, path, _, jira_project_key, pinned, tint)|` and set `tint`.
- `list_closed_projects` mapper: same.
- `open_project` (existing-row branch): `tint: existing.as_ref().and_then(|p| p.tint.clone())` (reuse the single `db.get_project` fetch already there from Plan 4 — it now returns tint). New-row branch: `tint: None`.
- `create_project`: `tint: None`.
- `clone_project`: `tint: None`.
- `db.get_project`: handled in Step 1.

- [ ] **Step 3: Rust test**

In `tests.rs`, add:
```rust
#[test]
fn list_projects_returns_tint() {
    let db = test_db();
    db.insert_project("p", "P", "/tmp/octo-tint-p").unwrap();
    db.update_project("p", None, Some("verdigris")).unwrap();
    let row = db.list_projects().unwrap().into_iter().find(|t| t.0 == "p").unwrap();
    assert_eq!(row.6, Some("verdigris".to_string())); // tint is the 7th tuple field
}
```

- [ ] **Step 4: build + test + commit**

`cd src-tauri && cargo build` (compiles) then `cargo test`.
```bash
git add src-tauri/src/db.rs src-tauri/src/commands.rs src-tauri/src/tests.rs
git commit -m "feat(project): expose tint on ProjectInfo (backend source of truth)"
```

---

## Task 2: Frontend — read name/tint from backend + migrate localStorage (A1 part 2)

**Files:** `src/lib/types.ts`, `src/App.tsx`.

- [ ] **Step 1: TS type**

In `src/lib/types.ts`, add to `ProjectInfo` (after `pinned`): `tint: string | null;`. Fix any ProjectInfo test factory that now lacks `tint` (add `tint: null`) — run typecheck to find them.

- [ ] **Step 2: one-time migration localStorage → backend**

In `src/App.tsx`, add a startup effect (near the existing startup effect) that, ONCE, seeds the backend from `localStorage.projectCustomizations` so pre-existing custom names/tints become durable, then reloads recent:
```tsx
  // One-time: migrate legacy localStorage project customizations into the
  // backend (durable). Idempotent; guarded by a flag so it runs once.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    migratedRef.current = true;
    if (localStorage.getItem("projectCustomizationsMigrated") === "1") return;
    (async () => {
      try {
        const customizations = JSON.parse(localStorage.getItem("projectCustomizations") || "{}");
        const entries = Object.entries(customizations) as Array<[string, { name?: string; tint?: string }]>;
        for (const [id, c] of entries) {
          if (c && (c.name || c.tint)) {
            await ipc.updateProjectCustomization(id, c.name ?? null, c.tint ?? null);
          }
        }
        localStorage.setItem("projectCustomizationsMigrated", "1");
        if (entries.length > 0) await loadRecentProjects();
      } catch {
        /* non-critical */
      }
    })();
  }, [loadRecentProjects]);
```
(`loadRecentProjects` is already a selector in App. `ipc.updateProjectCustomization(id, name, tint)` exists.)

- [ ] **Step 3: projectGroups reads backend name/tint first**

In `projectGroups` (App.tsx ~1209-1232), change the precedence so backend wins, localStorage is fallback. Build a backend lookup and use it:
```tsx
    const byId: Record<string, { name: string; tint: string | null }> = {};
    recentProjects.forEach((p) => { byId[p.id] = { name: p.name, tint: p.tint }; });
    if (project) byId[project.id] = { name: project.name, tint: project.tint };

    const ordered: { id: string; name: string; tint?: string }[] = [];
    const seen = new Set<string>();
    const pushProject = (id: string, fallbackName: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const backend = byId[id];
      const custom = customizations[id];
      ordered.push({
        id,
        name: backend?.name || custom?.name || fallbackName,
        tint: backend?.tint ?? custom?.tint,
      });
    };
```
(Keep the rest — `recentProjects.forEach(pushProject)`, `pushProject(project.id, project.name)`, the jiraKeyById block, and the final `.map`. Backend name/tint now win; localStorage remains a fallback for the brief pre-migration window. `project.tint` requires the TS type change from Step 1.)

- [ ] **Step 4: verify + commit**

`npm run typecheck` → clean. `npm test` → green. `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.
```bash
git add src/lib/types.ts src/App.tsx
git commit -m "feat(project): rail reads name/tint from backend; migrate legacy localStorage (A1)"
```

---

## Task 3: ContextHeader — gate active-ticket detection on the Jira key (A2 / C5)

**Why:** `ContextHeader` calls `resolveLinkage(workspace, branch)` (raw detection), so a branch like `fix/UTF-8` shows a fake ticket. Gate it on the project's Jira key, like the rail does (`detectIssueKeyForProject`).

**Files:** `src/components/ContextHeader.tsx`, `src/App.tsx` (where ContextHeader is rendered).

- [ ] **Step 1: add a prop + use the gated detector**

In `ContextHeader.tsx`:
- Add a prop `jiraProjectKey?: string | null;` to `Props`.
- It currently does `const linkage = workspace ? resolveLinkage(workspace, branch) : { kind: "unlinked" as const };` and `const activeKey = linkage.kind === "linked" && issueTrackerConfigured ? linkage.key : null;`. Change the detected-key path to be gated: a manual `workspace.linkedIssueKey` still wins; a branch-DETECTED key must match the project's Jira key. Use `detectIssueKeyForProject` (import from `../lib/detectIssueKey`):
```tsx
  const manualKey = workspace?.linkedIssueKey ?? null;
  const detectedKey = detectIssueKeyForProject(branch, jiraProjectKey ?? null);
  const resolvedKey = manualKey ?? detectedKey;
  const activeKey = resolvedKey && issueTrackerConfigured ? resolvedKey : null;
```
Then use `activeKey` where the component currently used `linkage.key`/`activeKey` (read the component to splice this cleanly — keep the rest of the rendering that depends on `activeKey`/the linked state). If other code paths read `linkage`, derive a small `isLinked = !!resolvedKey` to replace them. Do NOT change the degraded WORKSPACE block behavior when there's no key.

- [ ] **Step 2: pass jiraProjectKey from App**

Where `<ContextHeader ... />` is rendered in `App.tsx`, add `jiraProjectKey={project?.jiraProjectKey ?? null}` (the active project's Jira key; `project` is the current project in scope).

- [ ] **Step 3: verify + commit**

`npm run typecheck` → clean. `npm test` → green. If `ContextHeader.test.tsx` exercises ticket detection, confirm it still passes; a test that relied on raw detection without a project key now needs `jiraProjectKey` set OR a manual `linkedIssueKey` — update the test inputs to reflect the gated behavior (note it).
```bash
git add src/components/ContextHeader.tsx src/App.tsx
git commit -m "fix(header): gate active-ticket detection on project Jira key (C5)"
```

---

## Task 4: Remove dead `issueLinkDismissed` (B3)

**Why:** After "Skip Jira" was removed (Plan 1), `issueLinkDismissed` is written (always false) but never read. Remove the field/plumbing; leave the DB column in place (non-destructive).

**Files:** `src/lib/types.ts`, `src/lib/ipc.ts`, `src/App.tsx`, `src-tauri/src/db.rs`, `src-tauri/src/commands.rs`, test factories.

- [ ] **Step 1: confirm it's dead**

`grep -rn "issueLinkDismissed\|issue_link_dismissed" src/ src-tauri/src/`. Expect: the TS `Workspace` field, test factories setting it `false`, the Rust `WorkspaceRow` field, `list_workspaces`/`list_archived_workspaces` SELECT + mapping, and `update_workspace_link` (db + command + ipc + callers) passing `dismissed`. NO logic reads it. If something DOES read it for behavior, STOP and report.

- [ ] **Step 2: remove it**

- TS `src/lib/types.ts`: remove `issueLinkDismissed: boolean;` from the `Workspace` interface.
- `src/lib/ipc.ts`: `updateWorkspaceLink(workspaceId, jiraProjectKey, dismissed)` → drop the `dismissed` param: `updateWorkspaceLink: (workspaceId: string, jiraProjectKey: string | null) => invoke<void>("update_workspace_link", { workspaceId, jiraProjectKey })`.
- `src/App.tsx`: callers `ipc.updateWorkspaceLink(id, key, false)` → drop the 3rd arg.
- `src-tauri/src/commands.rs`: `update_workspace_link` command — drop the `dismissed` param; call `db.update_workspace_link(&workspace_id, jira_project_key)`.
- `src-tauri/src/db.rs`: `update_workspace_link` — drop the `dismissed` param + remove `issue_link_dismissed` from the `UPDATE` (set only `linked_issue_key`). In `WorkspaceRow` struct remove `pub issue_link_dismissed: bool,`. In `list_workspaces` AND `list_archived_workspaces`, remove `issue_link_dismissed` from the SELECT and from the row mapping (drop the `r.get::<_, i64>(14)? != 0` line — it's the LAST selected column, so other indices are unaffected). Leave the DB **column** in the CREATE/migration (dead but harmless — document with a one-line comment).
- Test factories: `src/stores/workspaceStore.test.ts` `makeWorkspace` and any other Workspace factory — remove `issueLinkDismissed: false`.

- [ ] **Step 3: verify + commit**

`cargo build` + `cargo test` (Rust) green. `npm run typecheck` → clean. `npm test` → green.
```bash
git add -A
git commit -m "chore: remove dead issueLinkDismissed field/plumbing (column left in place)"
```

---

## Task 5: Remove unused `touch_project` (B4)

**Files:** `src-tauri/src/db.rs`, `src-tauri/src/tests.rs`.

- [ ] **Step 1:** Confirm `touch_project` has no production caller (`grep -rn touch_project src-tauri/src/` → only db.rs definition + a test). Remove the `touch_project` method from `db.rs`. In `tests.rs`, remove the `db.touch_project(...)` usage — if that line is part of a broader test, replace it with the equivalent durable behavior (the test likely asserts `last_opened` changes; `reopen_project` now does that — use `db.reopen_project` if the test still needs to bump last_opened, OR delete the assertion if it was solely about touch_project). Read the test and adapt so it still passes and remains meaningful; report what you did.

- [ ] **Step 2: verify + commit**

`cd src-tauri && cargo test` → green.
```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "chore: remove unused touch_project (superseded by reopen_project)"
```

---

## Task 6: Full verification

- [ ] `npm run typecheck && npm test && (cd src-tauri && cargo test)` — all green.
- [ ] `git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo clean`.
- [ ] Manual: customize a project's name+tint, then clear `localStorage.projectCustomizations` and reload → name+tint persist (now from backend). A branch like `fix/UTF-8` shows NO ticket in the ContextHeader. Linking/unlinking a Jira ticket still works.

---

## Self-Review (during planning)

- **A1:** tint exposed on ProjectInfo (7-tuple, same pattern as `pinned`), one-time idempotent localStorage→backend migration, projectGroups reads backend-first with localStorage fallback. Survives a localStorage clear.
- **A2/C5:** ContextHeader uses `detectIssueKeyForProject` gated on the project key (manual link still wins); App passes the active project's key.
- **B3:** dead field removed end-to-end (TS+Rust+ipc+callers); DB column left in place (non-destructive). Verified no logic reads it first.
- **B4:** dead method removed; its test adapted.
- **Risk:** the 7-tuple change (T1) mirrors Plan 4's `pinned` addition (known-good). B3 touches the linkage plumbing — TDD/tests guard it. Each task independently committed + reviewed.
```
