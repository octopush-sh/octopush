# Rail Soft-Close, Reopen & Recently-Closed — Implementation Plan (Plan 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Close project" safe and reversible (soft-close instead of delete), add a "Recently closed" drawer to reopen projects, persist per-project collapse, add considered empty states, and fix the close/create correctness bugs (C2, C3, C8) — fixing the reported bug B1 ("once I close a project there's no way to reopen it").

**Architecture:** Data-model first. A `projects.closed_at` column (added via the established `add_column_if_missing` migration) turns `close_project` from a destructive `DELETE` into a reversible `UPDATE`. `list_recent_projects` excludes closed rows; a new `list_closed_projects` feeds the drawer; `reopen_project` clears `closed_at`. `open_project` also clears `closed_at` so the welcome-screen file picker reopens a closed project even when the rail isn't visible (the sole-project case). The frontend `projectStore` becomes the single source of truth for close/reopen (clearing `current` on close — C2), and `workspaceStore` gains a `pruneProject` action (C8) plus a project-aware `create` (C3). The rail renders a collapsible `RecentlyClosedDrawer` and persists per-project collapse to `localStorage`.

**Tech Stack:** React 19 + TypeScript, Zustand, Tailwind v4 (theme tokens), Tauri 2 / Rust + rusqlite, Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-05-rail-robustness-design.md` — this plan covers §4.4 (Recently-closed drawer), §4.5 (empty states), §4.6 (persist per-project collapse), §6.4 (`closed_at` migration), §7 (soft-close & reopen / B1), and correctness fixes C2, C3, and C8.

**Note on C8:** the spec's rollout (§14) tentatively listed C8 (prune `workspacesByProjectId`) under wave 3, but pruning is an intrinsic part of the close/delete flow built here, so it is folded into this plan rather than left as a known stale-map leak in code we are actively rewriting.

**Deferred to later plans (noted so nothing is lost):** git pulse + workspace status dots + `workspaces_git_summary` + C5 `detectIssueKey` prefix-gating (Plan 3); pin/reorder + archive workspace + rename workspace + quick filter (Plan 4).

---

## File Structure

**New files**
- `src/components/RecentlyClosedDrawer.tsx` — collapsible drawer listing closed projects with a Restore affordance (§4.4).
- `src/stores/projectStore.test.ts` — unit tests for `closeProject`/`reopenProject` keeping `recent`/`closed`/`current` consistent (C2).

**Modified — backend**
- `src-tauri/src/db.rs` — `closed_at` migration; `close_project`/`reopen_project`/`list_closed_projects` methods; `list_projects` excludes closed rows.
- `src-tauri/src/commands.rs` — `close_project` becomes soft; new `reopen_project` + `list_closed_projects` commands; `open_project` clears `closed_at`.
- `src-tauri/src/lib.rs` — register the two new commands.
- `src-tauri/src/tests.rs` — soft-close/reopen/list-closed DB test.

**Modified — frontend**
- `src/lib/ipc.ts` — wire `reopenProject`, `listClosedProjects`.
- `src/stores/projectStore.ts` — `closed` state + `loadClosed`/`closeProject`/`reopenProject` (single source of truth; clears `current` on close — C2).
- `src/stores/workspaceStore.ts` — `pruneProject` action (C8); project-aware `create` (C3).
- `src/stores/workspaceStore.test.ts` — update the existing `create` test + add the non-active-project case (C3); add `pruneProject` tests (C8).
- `src/App.tsx` — route close/reopen through the store; prune on close/delete; load closed on startup; pass `closedProjects` + `onReopenProject` to the rail.
- `src/components/WorkspaceRail.tsx` — render the drawer; per-project collapse with `localStorage` persistence (§4.6); empty states (§4.5).

---

## Task 1: Backend — `closed_at` column + soft-close/reopen/list-closed DB methods (§6.4, §7)

**Why:** `close_project` currently calls `db.delete_project` (hard delete of the row). To make it reversible we need a nullable `closed_at` timestamp and queries that partition projects into open vs closed.

**Files:**
- Modify: `src-tauri/src/db.rs` (migration block ~line 169; `list_projects` ~line 551; add methods near `delete_project` ~line 634)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Add the migration**

In `src-tauri/src/db.rs`, in the migration block, directly after the existing `jira_project_key` migration (the `add_column_if_missing(... "ALTER TABLE projects ADD COLUMN jira_project_key TEXT")?;` call), add:

```rust
        // ── v3 soft-close: a non-null timestamp means the project is hidden
        // from the rail but its row, workspaces, terminals and chats survive,
        // so it can be reopened later (Plan 2 / bug B1).
        add_column_if_missing(
            &self.conn,
            "ALTER TABLE projects ADD COLUMN closed_at TEXT",
        )?;
```

- [ ] **Step 2: Exclude closed projects from `list_projects`**

In `src-tauri/src/db.rs`, change the `list_projects` query (line ~552) to filter out closed rows:

```rust
    pub fn list_projects(&self) -> AppResult<Vec<(String, String, String, String, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened, jira_project_key FROM projects \
             WHERE closed_at IS NULL ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
```

- [ ] **Step 3: Add the soft-close / reopen / list-closed methods**

In `src-tauri/src/db.rs`, directly above the existing `delete_project` method (line ~634), add:

```rust
    /// Soft-close: hide the project from the rail without deleting anything.
    pub fn close_project(&self, id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE projects SET closed_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    /// Reopen a soft-closed project: clear `closed_at` and bump `last_opened`
    /// so it returns to the rail in its prior (creation-order) place.
    pub fn reopen_project(&self, id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE projects SET closed_at = NULL, last_opened = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    /// The most recently closed projects (for the "Recently closed" drawer),
    /// newest first, capped at 10. Same tuple shape as `list_projects`.
    pub fn list_closed_projects(
        &self,
    ) -> AppResult<Vec<(String, String, String, String, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, last_opened, jira_project_key FROM projects \
             WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 10",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
```

(`Utc` and `params!` are already in scope in `db.rs` — both are used by `touch_project` immediately above.)

- [ ] **Step 4: Write the failing Rust test**

In `src-tauri/src/tests.rs`, add:

```rust
#[test]
fn soft_close_hides_then_reopen_restores_project() {
    let db = test_db();
    db.insert_project("p1", "Proj One", "/tmp/octo-p1").unwrap();

    // Open by default: in list_projects, absent from closed list.
    assert!(db.list_projects().unwrap().iter().any(|(id, ..)| id == "p1"));
    assert!(db.list_closed_projects().unwrap().is_empty());

    // Soft-close: gone from the rail list, present in closed list, row survives.
    db.close_project("p1").unwrap();
    assert!(!db.list_projects().unwrap().iter().any(|(id, ..)| id == "p1"));
    assert!(db.list_closed_projects().unwrap().iter().any(|(id, ..)| id == "p1"));
    assert!(db.get_project_by_id("p1").unwrap().is_some());

    // Reopen: back in the rail list, gone from closed list.
    db.reopen_project("p1").unwrap();
    assert!(db.list_projects().unwrap().iter().any(|(id, ..)| id == "p1"));
    assert!(db.list_closed_projects().unwrap().is_empty());
}
```

- [ ] **Step 5: Run the test to verify it fails, then passes**

Run: `cd src-tauri && cargo test soft_close_hides_then_reopen_restores_project`
Expected: FAILS to compile first (methods missing) until Steps 1-3 are in; then PASS. Then run `cargo test` (full) to confirm nothing else regressed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(backend): soft-close projects via closed_at; list_closed_projects (B1)"
```

---

## Task 2: Backend — soft `close_project` command, `reopen_project`, `list_closed_projects`, and reopen-on-open (§7)

**Why:** Wire the new DB methods to the frontend, and make `open_project` clear `closed_at` so reopening a closed project from the welcome-screen file picker works even when the rail isn't visible (the sole-project case).

**Files:**
- Modify: `src-tauri/src/commands.rs` (`close_project` ~line 1213; `open_project` line 409; add new commands near `list_recent_projects` ~line 430)
- Modify: `src-tauri/src/lib.rs` (invoke handler)
- Test: covered by Task 1's DB test (commands are thin wrappers)

- [ ] **Step 1: Make `close_project` soft**

In `src-tauri/src/commands.rs`, change the `close_project` command body from `delete_project` to the soft-close method:

```rust
#[tauri::command]
pub async fn close_project(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<()> {
    // Soft-close: the row, its workspaces, terminals and chats are preserved
    // so the project can be reopened from "Recently closed" (B1).
    state.db.lock().close_project(&project_id)
}
```

- [ ] **Step 2: Add `reopen_project` and `list_closed_projects` commands**

In `src-tauri/src/commands.rs`, directly after the `list_recent_projects` command (ends ~line 434), add:

```rust
#[tauri::command]
pub async fn list_closed_projects(state: State<'_, AppState>) -> AppResult<Vec<ProjectInfo>> {
    let rows = state.db.lock().list_closed_projects()?;
    Ok(rows
        .into_iter()
        .map(|(id, name, path, _, jira_project_key)| ProjectInfo {
            id,
            name,
            path,
            jira_project_key,
        })
        .collect())
}

#[tauri::command]
pub async fn reopen_project(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<()> {
    state.db.lock().reopen_project(&project_id)
}
```

- [ ] **Step 3: Clear `closed_at` when opening an existing project**

In `src-tauri/src/commands.rs`, in `open_project`, replace the existing-row branch's `db.touch_project(&id)?;` (line 409) with a reopen so that opening a closed project via the file picker un-closes it:

```rust
        // Opening a project always un-closes it (clears closed_at) and bumps
        // last_opened — this is the welcome-screen path back for a closed
        // sole project, when the rail's "Recently closed" drawer isn't visible.
        db.reopen_project(&id)?;
```

(For a project that was never closed, `closed_at` is already NULL, so this is equivalent to the old `touch_project` — it just also bumps `last_opened`.)

- [ ] **Step 4: Register the two new commands**

In `src-tauri/src/lib.rs`, in the `invoke_handler` list, after `commands::close_project,` (and `commands::delete_project,`) add:

```rust
            commands::list_closed_projects,
            commands::reopen_project,
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds clean. Then `cargo test` (full) — all green (the Task 1 test still passes).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(backend): soft close_project command + reopen_project/list_closed_projects; reopen on open (B1)"
```

---

## Task 3: Frontend IPC — `reopenProject` + `listClosedProjects`

**Why:** Expose the new backend commands to the frontend. `ProjectInfo` is reused as-is (no new type).

**Files:**
- Modify: `src/lib/ipc.ts` (after `deleteProject`, line ~149)

- [ ] **Step 1: Wire the IPC methods**

In `src/lib/ipc.ts`, directly after the `deleteProject` entry (line ~148-149), add:

```ts
  reopenProject: (projectId: string) =>
    invoke<void>("reopen_project", { projectId }),
  listClosedProjects: () => invoke<ProjectInfo[]>("list_closed_projects"),
```

(`ProjectInfo` is already imported at the top of `ipc.ts`.)

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ipc.ts
git commit -m "feat(ipc): reopenProject + listClosedProjects"
```

---

## Task 4: projectStore — `closed` state + close/reopen single source of truth (C2)

**Why:** Today `handleCloseProject` calls `ipc.closeProject` + `loadRecentProjects` in App.tsx and never clears `current` (C2 — closing the active project leaves a stale `current`). Move close/reopen into the store so `recent`, `closed`, and `current` stay consistent in one place.

**Files:**
- Modify: `src/stores/projectStore.ts`
- Test: `src/stores/projectStore.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/stores/projectStore.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectInfo } from "../lib/types";

function proj(id: string): ProjectInfo {
  return { id, name: id.toUpperCase(), path: `/repo/${id}`, jiraProjectKey: null };
}

const mockIpc = {
  closeProject: vi.fn<(id: string) => Promise<void>>(),
  reopenProject: vi.fn<(id: string) => Promise<void>>(),
  listRecentProjects: vi.fn<() => Promise<ProjectInfo[]>>(),
  listClosedProjects: vi.fn<() => Promise<ProjectInfo[]>>(),
};

vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useProjectStore } = await import("./projectStore");

function resetStore() {
  useProjectStore.setState({ current: null, recent: [], closed: [], loading: false, error: null });
  vi.clearAllMocks();
}

describe("projectStore — closeProject", () => {
  beforeEach(() => resetStore());

  it("reloads recent + closed and clears current when the active project is closed (C2)", async () => {
    const a = proj("a");
    useProjectStore.setState({ current: a, recent: [a], closed: [] });
    mockIpc.closeProject.mockResolvedValueOnce(undefined);
    mockIpc.listRecentProjects.mockResolvedValueOnce([]);
    mockIpc.listClosedProjects.mockResolvedValueOnce([a]);

    await useProjectStore.getState().closeProject("a");

    const s = useProjectStore.getState();
    expect(mockIpc.closeProject).toHaveBeenCalledWith("a");
    expect(s.recent).toEqual([]);
    expect(s.closed.map((p) => p.id)).toEqual(["a"]);
    expect(s.current).toBeNull();
  });

  it("leaves current intact when a different (non-active) project is closed", async () => {
    const a = proj("a");
    const b = proj("b");
    useProjectStore.setState({ current: a, recent: [a, b], closed: [] });
    mockIpc.closeProject.mockResolvedValueOnce(undefined);
    mockIpc.listRecentProjects.mockResolvedValueOnce([a]);
    mockIpc.listClosedProjects.mockResolvedValueOnce([b]);

    await useProjectStore.getState().closeProject("b");

    expect(useProjectStore.getState().current?.id).toBe("a");
  });
});

describe("projectStore — reopenProject", () => {
  beforeEach(() => resetStore());

  it("reloads recent + closed after reopening", async () => {
    const a = proj("a");
    useProjectStore.setState({ current: null, recent: [], closed: [a] });
    mockIpc.reopenProject.mockResolvedValueOnce(undefined);
    mockIpc.listRecentProjects.mockResolvedValueOnce([a]);
    mockIpc.listClosedProjects.mockResolvedValueOnce([]);

    await useProjectStore.getState().reopenProject("a");

    const s = useProjectStore.getState();
    expect(mockIpc.reopenProject).toHaveBeenCalledWith("a");
    expect(s.recent.map((p) => p.id)).toEqual(["a"]);
    expect(s.closed).toEqual([]);
  });
});

describe("projectStore — loadClosed", () => {
  beforeEach(() => resetStore());

  it("populates the closed list from ipc", async () => {
    const a = proj("a");
    mockIpc.listClosedProjects.mockResolvedValueOnce([a]);
    await useProjectStore.getState().loadClosed();
    expect(useProjectStore.getState().closed.map((p) => p.id)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/stores/projectStore.test.ts`
Expected: FAIL — `closed`, `closeProject`, `reopenProject`, `loadClosed` don't exist yet.

- [ ] **Step 3: Implement the store changes**

In `src/stores/projectStore.ts`, add `closed` to the `ProjectState` interface (after `recent`):

```ts
  recent: ProjectInfo[];
  closed: ProjectInfo[];
```

Add the three action signatures to the interface (after `loadRecent`):

```ts
  loadRecent: () => Promise<void>;
  loadClosed: () => Promise<void>;
  closeProject: (id: string) => Promise<void>;
  reopenProject: (id: string) => Promise<void>;
```

Add `closed: [],` to the initial state (after `recent: [],`):

```ts
  current: null,
  recent: [],
  closed: [],
```

Add the three actions to the store body. Insert them directly after the `loadRecent` action (after its closing `},` ~line 58):

```ts
  loadClosed: async () => {
    try {
      const closed = await ipc.listClosedProjects();
      set({ closed });
    } catch {
      // Ignore — closed list is non-critical.
    }
  },

  closeProject: async (id) => {
    await ipc.closeProject(id);
    const [recent, closed] = await Promise.all([
      ipc.listRecentProjects(),
      ipc.listClosedProjects(),
    ]);
    set((s) => ({
      recent,
      closed,
      // Closing the currently-open project drops the app to the empty state
      // instead of leaving a stale `current` pointing at a hidden project (C2).
      current: s.current?.id === id ? null : s.current,
    }));
  },

  reopenProject: async (id) => {
    await ipc.reopenProject(id);
    const [recent, closed] = await Promise.all([
      ipc.listRecentProjects(),
      ipc.listClosedProjects(),
    ]);
    set({ recent, closed });
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/stores/projectStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/projectStore.ts src/stores/projectStore.test.ts
git commit -m "feat(rail): projectStore close/reopen single source of truth; clear current on close (C2)"
```

---

## Task 5: workspaceStore — `pruneProject` (C8) + project-aware `create` (C3)

**Why:**
- **C8:** `workspacesByProjectId` is never pruned when a project is closed/deleted, leaking its workspaces in the rail map.
- **C3:** `create` unconditionally appends to the flat `workspaces` and sets `activeId`. When you create a workspace for a *non-active* project (rail "+" while another project is open), this pollutes the active project's list and points `activeId` at a workspace that isn't in it. `create` must be project-aware: always write into `workspacesByProjectId[projectId]`, but only touch the flat `workspaces`/`activeId` when the target project is the currently-open one.

**Files:**
- Modify: `src/stores/workspaceStore.ts` (import projectStore; `create` lines 103-126; add `pruneProject`)
- Test: `src/stores/workspaceStore.test.ts`

- [ ] **Step 1: Update the existing `create` test + add the non-active case + `pruneProject` tests**

In `src/stores/workspaceStore.test.ts`:

First, import the project store and a project factory at the top, after the existing imports (line ~14):

```ts
import { useProjectStore } from "./projectStore";
import type { ProjectInfo } from "../lib/types";

function makeProject(id: string): ProjectInfo {
  return { id, name: id.toUpperCase(), path: `/repo/${id}`, jiraProjectKey: null };
}
```

In `resetStore()`, also reset the project store so `create` sees a known `current` (add inside `resetStore`, before `vi.clearAllMocks()`):

```ts
  useProjectStore.setState({ current: null, recent: [], closed: [], loading: false, error: null });
```

Replace the entire `describe("workspaceStore — create", ...)` block (lines 146-172) with one that sets the active project and adds the non-active case:

```ts
describe("workspaceStore — create (project-aware, C3)", () => {
  beforeEach(() => resetStore());

  it("appends + activates when creating for the currently-open project", async () => {
    useProjectStore.setState({ current: makeProject("proj-1") });
    const existing = makeWorkspace("proj-1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [existing],
      activeId: existing.id,
      workspacesByProjectId: { "proj-1": [existing] },
    });
    const created = makeWorkspace("proj-1", "beta");
    mockIpc.createWorkspace.mockResolvedValueOnce(created);

    await useWorkspaceStore
      .getState()
      .create("proj-1", "/repo", "beta", "", created.branch, "main", "");

    const s = useWorkspaceStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual([existing.id, created.id]);
    expect(s.workspacesByProjectId["proj-1"].map((w) => w.id)).toEqual([
      existing.id,
      created.id,
    ]);
    expect(s.activeId).toBe(created.id);
  });

  it("does NOT pollute the flat list or activeId when creating for a non-active project", async () => {
    useProjectStore.setState({ current: makeProject("proj-1") });
    const activeWs = makeWorkspace("proj-1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [activeWs],
      activeId: activeWs.id,
      workspacesByProjectId: { "proj-1": [activeWs] },
    });
    const created = makeWorkspace("proj-2", "gamma");
    mockIpc.createWorkspace.mockResolvedValueOnce(created);

    await useWorkspaceStore
      .getState()
      .create("proj-2", "/repo2", "gamma", "", created.branch, "main", "");

    const s = useWorkspaceStore.getState();
    // Flat list + active untouched — still proj-1's.
    expect(s.workspaces.map((w) => w.id)).toEqual([activeWs.id]);
    expect(s.activeId).toBe(activeWs.id);
    // But the new workspace is recorded in its own project's group for the rail.
    expect(s.workspacesByProjectId["proj-2"].map((w) => w.id)).toEqual([created.id]);
  });
});

describe("workspaceStore — pruneProject (C8)", () => {
  beforeEach(() => resetStore());

  it("removes the project's group and clears active when the pruned project was active", async () => {
    const a = makeWorkspace("proj-1", "alpha");
    useWorkspaceStore.setState({
      workspaces: [a],
      activeId: a.id,
      workspacesByProjectId: { "proj-1": [a] },
    });

    useWorkspaceStore.getState().pruneProject("proj-1");

    const s = useWorkspaceStore.getState();
    expect(s.workspacesByProjectId["proj-1"]).toBeUndefined();
    expect(s.workspaces).toEqual([]);
    expect(s.activeId).toBeNull();
  });

  it("leaves the flat list + active intact when pruning a non-active project", async () => {
    const a = makeWorkspace("proj-1", "alpha");
    const b = makeWorkspace("proj-2", "beta");
    useWorkspaceStore.setState({
      workspaces: [a],
      activeId: a.id,
      workspacesByProjectId: { "proj-1": [a], "proj-2": [b] },
    });

    useWorkspaceStore.getState().pruneProject("proj-2");

    const s = useWorkspaceStore.getState();
    expect(s.workspacesByProjectId["proj-2"]).toBeUndefined();
    expect(s.workspacesByProjectId["proj-1"].map((w) => w.id)).toEqual([a.id]);
    expect(s.workspaces.map((w) => w.id)).toEqual([a.id]);
    expect(s.activeId).toBe(a.id);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/stores/workspaceStore.test.ts`
Expected: FAIL — `pruneProject` is undefined; the non-active `create` test fails because `create` still appends/activates unconditionally.

- [ ] **Step 3: Implement the changes**

In `src/stores/workspaceStore.ts`, add the project-store import at the top (after the `ipc` import, line ~2):

```ts
import { useProjectStore } from "./projectStore";
```

Add the `pruneProject` signature to the `WorkspaceState` interface (after `remove`, line ~30):

```ts
  /** Drop a whole project's workspaces from the rail map; clears the active
   *  workspace too if it belonged to that project. Used on project close/delete. */
  pruneProject: (projectId: string) => void;
```

Replace the `create` action body (lines 103-126) with the project-aware version:

```ts
  create: async (projectId, projectPath, name, task, branch, fromBranch, setupScript) => {
    const ws = await ipc.createWorkspace(projectId, projectPath, name, task, branch, fromBranch, setupScript);
    // Only the currently-open project owns the flat `workspaces`/`activeId`.
    // Creating for any other project must not steal focus or corrupt that
    // list — it just lands in the per-project map for the rail (C3).
    const isActiveProject = useProjectStore.getState().current?.id === projectId;
    set((s) => {
      const updated = { ...s.lastActiveByProject, [projectId]: ws.id };
      try {
        localStorage.setItem("lastActiveWorkspacePerProject", JSON.stringify(updated));
      } catch (err) {
        console.error("Failed to persist lastActiveByProject:", err);
      }
      return {
        // New workspaces sit at the end of their project's list (matching the
        // backend's created_at ASC ordering).
        workspaces: isActiveProject ? [...s.workspaces, ws] : s.workspaces,
        activeId: isActiveProject ? ws.id : s.activeId,
        lastActiveByProject: updated,
        workspacesByProjectId: {
          ...s.workspacesByProjectId,
          [projectId]: [...(s.workspacesByProjectId[projectId] || []), ws],
        },
      };
    });
    return ws;
  },
```

Add the `pruneProject` action. Insert it directly after the `remove` action (after its closing `},` ~line 179):

```ts
  pruneProject: (projectId) =>
    set((s) => {
      const removed = s.workspacesByProjectId[projectId] ?? [];
      const removedIds = new Set(removed.map((w) => w.id));
      const { [projectId]: _dropped, ...restByProject } = s.workspacesByProjectId;
      // If the active workspace belonged to the pruned project, the flat list
      // is now that project's — clear it so the app falls to the empty state.
      const activeWasPruned = !!s.activeId && removedIds.has(s.activeId);
      return {
        workspacesByProjectId: restByProject,
        workspaces: activeWasPruned ? [] : s.workspaces,
        activeId: activeWasPruned ? null : s.activeId,
      };
    }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/stores/workspaceStore.test.ts`
Expected: PASS (all describe blocks, including the unchanged `remove`/`load`/`updateCustomization` ones).

- [ ] **Step 5: Commit**

```bash
git add src/stores/workspaceStore.ts src/stores/workspaceStore.test.ts
git commit -m "fix(rail): project-aware create (C3) + pruneProject on close/delete (C8)"
```

---

## Task 6: App.tsx — route close/reopen through the store, prune, load closed, pass props

**Why:** Wire the new store actions into the app: soft-close via `closeProject` (+ prune), restore via `reopenProject`, prune on hard-delete too, load the closed list on startup, and feed the rail the closed projects + a reopen handler.

**Files:**
- Modify: `src/App.tsx` — selectors (~line 80, ~117), startup (~273-288), close handler (958-977), confirm-delete handler (986-1012), rail render (1142-1155)

- [ ] **Step 1: Add the store selectors**

In `src/App.tsx`, add `pruneProject` to the workspace-store destructure (after `workspacesByProjectId,` line 80):

```ts
    workspacesByProjectId,
    pruneProject,
  } = useWorkspaceStore();
```

In the project-store selector block (after `loadRecentProjects` line 117), add:

```ts
  const closedProjects = useProjectStore((s) => s.closed);
  const loadClosedProjects = useProjectStore((s) => s.loadClosed);
  const closeProjectAction = useProjectStore((s) => s.closeProject);
  const reopenProjectAction = useProjectStore((s) => s.reopenProject);
```

- [ ] **Step 2: Load the closed list on startup**

In the startup effect (line ~273), after `await loadRecentProjects();`, add:

```ts
      await loadRecentProjects();
      void loadClosedProjects();
```

And add `loadClosedProjects` to that effect's dependency array (line 288):

```ts
  }, [loadRecentProjects, loadClosedProjects, openProject, getLastOpenedPath]);
```

- [ ] **Step 3: Rewrite `handleCloseProject` (soft-close + prune)**

Replace the `handleCloseProject` `useCallback` (lines 958-977) with:

```tsx
  // ── Project close handler (soft-close: reversible from Recently closed) ──
  const handleCloseProject = useCallback(
    async (projectId: string) => {
      try {
        await closeProjectAction(projectId); // soft-close; clears current if active (C2)
        pruneProject(projectId); // drop its workspaces from the rail map (C8)
        pushToast({
          level: "success",
          title: "Project closed",
          body: "Restore it from Recently closed.",
        });
      } catch (err) {
        pushToast({
          level: "error",
          title: "Failed to close project",
          body: String(err),
        });
      }
      setProjectContextMenu(null);
    },
    [closeProjectAction, pruneProject]
  );

  // ── Project reopen handler (from the Recently closed drawer) ──
  const handleReopenProject = useCallback(
    async (projectId: string) => {
      try {
        await reopenProjectAction(projectId);
        pushToast({ level: "success", title: "Project restored" });
      } catch (err) {
        pushToast({
          level: "error",
          title: "Failed to restore project",
          body: String(err),
        });
      }
    },
    [reopenProjectAction]
  );
```

- [ ] **Step 4: Update `handleConfirmDeleteProject` (prune + refresh closed)**

In `handleConfirmDeleteProject` (lines 986-1012), after `await loadRecentProjects();` add a closed-list refresh and a prune, and keep the existing current-clear:

```tsx
      try {
        await ipc.deleteProject(projectId);
        await loadRecentProjects();
        await loadClosedProjects();
        pruneProject(projectId);

        // If current project was deleted, go to welcome screen
        if (project?.id === projectId) {
          useProjectStore.getState().close();
        }
```

Update that callback's dependency array (line 1011) to include the new deps:

```tsx
    [project?.id, loadRecentProjects, loadClosedProjects, pruneProject]
```

- [ ] **Step 5: Pass the new props to the rail**

In the `<WorkspaceRail ... />` render (lines 1142-1155), add two props (e.g. after `onProjectContextMenu={handleProjectContextMenu}`):

```tsx
        onProjectContextMenu={handleProjectContextMenu}
        closedProjects={closedProjects}
        onReopenProject={handleReopenProject}
        isCollapsed={isRailCollapsed}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck`
Expected: FAILS until Task 7 adds the new props to `WorkspaceRail`'s `Props`. That's expected — Task 7 closes the loop. (If you prefer a green checkpoint, do Step 7's commit after Task 7's Step 1.)

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(rail): wire soft-close/reopen + prune; load closed list (B1, C2, C8)"
```

---

## Task 7: RecentlyClosedDrawer component + render in the rail (§4.4)

**Why:** Give closed projects a visible, reversible home at the foot of the rail.

**Files:**
- Create: `src/components/RecentlyClosedDrawer.tsx`
- Modify: `src/components/WorkspaceRail.tsx` (import type + props; render the drawer above the Add-project footer)

- [ ] **Step 1: Create the drawer component**

`src/components/RecentlyClosedDrawer.tsx`:

```tsx
import { useState } from "react";
import { ProjectMark } from "./icons/ProjectMark";
import type { ProjectInfo } from "../lib/types";

interface Props {
  projects: ProjectInfo[];
  onReopen: (id: string) => void;
}

/** Collapsed-by-default drawer of soft-closed projects, pinned above the
 *  rail's Add-project footer. Hidden entirely when nothing is closed (§4.4). */
export function RecentlyClosedDrawer({ projects, onReopen }: Props) {
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return null;

  return (
    <div className="w-full border-t border-octo-hairline pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute transition hover:text-octo-sage"
      >
        <span>⟲ Recently closed · {projects.length}</span>
        <span className="text-[10px] leading-none">{open ? "⌄" : "›"}</span>
      </button>
      {open && (
        <div className="mt-1 flex flex-col">
          {projects.map((p) => (
            <div key={p.id} className="group flex items-center gap-2 px-3 py-1.5">
              <ProjectMark size={13} className="shrink-0 opacity-50" />
              <span className="flex-1 truncate font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage">
                {p.name}
              </span>
              <button
                type="button"
                onClick={() => onReopen(p.id)}
                className="opacity-0 transition-opacity group-hover:opacity-100 font-mono text-[10px] text-octo-brass"
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add props to WorkspaceRail and render the drawer**

In `src/components/WorkspaceRail.tsx`:

Change the type import (line 3) to also bring in `ProjectInfo`, and import the drawer (after the `ProjectMark` import, line 5):

```tsx
import type { Workspace, ProjectInfo } from "../lib/types";
import { useAttentionStore } from "../stores/attentionStore";
import { ProjectMark } from "./icons/ProjectMark";
import { RecentlyClosedDrawer } from "./RecentlyClosedDrawer";
```

Add the two props to the `Props` interface (after `onProjectContextMenu`, line 27):

```tsx
  /** Called when user right-clicks on a project header. */
  onProjectContextMenu?: (projectId: string, x: number, y: number) => void;
  /** Soft-closed projects, for the Recently-closed drawer (§4.4). */
  closedProjects?: ProjectInfo[];
  /** Called when the user restores a closed project. */
  onReopenProject?: (projectId: string) => void;
  /** Collapsed state is owned by the parent — the toggle lives in the footer. */
  isCollapsed: boolean;
```

Add them to the destructured params (after `onProjectContextMenu,` line 40):

```tsx
  onProjectContextMenu,
  closedProjects,
  onReopenProject,
  isCollapsed,
}: Props) {
```

Render the drawer between the scroll container's closing `</div>` (line 113) and the Add-project button (line 116), only when the rail is expanded:

```tsx
      </div>

      {/* Recently closed (expanded rail only) */}
      {!isCollapsed && onReopenProject && (
        <RecentlyClosedDrawer
          projects={closedProjects ?? []}
          onReopen={onReopenProject}
        />
      )}

      {/* Add project button */}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: no errors (this also resolves Task 6's pending props).

- [ ] **Step 4: Commit**

```bash
git add src/components/RecentlyClosedDrawer.tsx src/components/WorkspaceRail.tsx
git commit -m "feat(rail): Recently closed drawer (B1, §4.4)"
```

---

## Task 8: Per-project collapse with localStorage persistence (§4.6)

**Why:** A long rail with several projects needs to fold projects away, and that state should survive restarts. New projects default to expanded.

**Files:**
- Modify: `src/components/WorkspaceRail.tsx` (module-level storage helpers; collapse state + toggle; chevron in the header; gate the workspace list)

- [ ] **Step 1: Add the storage helpers + collapse state**

In `src/components/WorkspaceRail.tsx`, add a module-level helper (above the `WorkspaceRail` function, after the `Props` interface ~line 33):

```tsx
const COLLAPSE_KEY = "railProjectCollapsed";

/** Per-project collapsed map from localStorage. Absent id ⇒ expanded (§4.6). */
function loadCollapsedFromStorage(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}
```

Inside the `WorkspaceRail` function body, before the `return (` (line ~42), add the state + toggle:

```tsx
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(
    loadCollapsedFromStorage,
  );
  const toggleProjectCollapsed = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch (err) {
        console.error("Failed to persist railProjectCollapsed:", err);
      }
      return next;
    });
  };
```

(`useState` is already imported on line 1.)

- [ ] **Step 2: Add a chevron toggle to the project header**

In the project header (the `!isCollapsed && project?.name` block), wrap the trailing "+" button together with a new chevron in a right-aligned group. Replace the existing `onNewWorkspaceForProject && (...)` button (lines 74-83) with:

```tsx
                <div className="flex items-center gap-1">
                  {onNewWorkspaceForProject && (
                    <button
                      type="button"
                      onClick={() => onNewWorkspaceForProject(project.id)}
                      title={`New workspace in ${project.name}`}
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center h-5 w-5 text-xs text-octo-mute hover:text-octo-brass"
                    >
                      +
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleProjectCollapsed(project.id)}
                    aria-expanded={!collapsedProjects[project.id]}
                    aria-label={
                      collapsedProjects[project.id]
                        ? `Expand ${project.name}`
                        : `Collapse ${project.name}`
                    }
                    className="flex items-center justify-center h-5 w-5 text-[10px] text-octo-mute hover:text-octo-brass transition"
                  >
                    {collapsedProjects[project.id] ? "›" : "⌄"}
                  </button>
                </div>
```

- [ ] **Step 3: Gate the workspace list on the per-project collapse**

Wrap the workspaces `.map(...)` (lines 95-110) so it (and, in Task 9, the empty-state line) only render when the rail is collapsed (monograms always show) OR the project is expanded:

```tsx
            {/* Workspaces in this project (respect per-project collapse when
                the rail is expanded; always show monograms when collapsed). */}
            {(isCollapsed || !collapsedProjects[project.id]) &&
              (project?.workspaces || []).map((ws) => (
                <WorkspaceRow
                  key={ws?.id || `ws-${projectIndex}`}
                  workspace={ws}
                  active={ws?.id === activeWorkspaceId}
                  isCollapsed={isCollapsed}
                  onSelect={() => ws?.id && onSelect(ws.id)}
                  onCustomize={() => ws?.id && onCustomize(ws.id)}
                  onContextMenu={
                    onContextMenu && ws?.id
                      ? (x, y) => onContextMenu(ws.id, x, y)
                      : undefined
                  }
                />
              ))}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/WorkspaceRail.tsx
git commit -m "feat(rail): per-project collapse persisted to localStorage (§4.6)"
```

---

## Task 9: Empty states (§4.5)

**Why:** A project with no workspaces should say so (calm, one muted line), rather than rendering an empty gap. A rail with no projects should offer the way forward.

**Files:**
- Modify: `src/components/WorkspaceRail.tsx`

- [ ] **Step 1: "No workspaces yet" line for an expanded, empty project**

In `src/components/WorkspaceRail.tsx`, directly after the gated workspaces `.map(...)` from Task 8 Step 3 (inside the per-project `<div>`, before its closing `</div>` at line ~111), add:

```tsx
            {/* Empty project (expanded rail, expanded project, no workspaces). */}
            {!isCollapsed &&
              !collapsedProjects[project.id] &&
              (project?.workspaces || []).length === 0 && (
                <div className="px-3 py-1.5 font-mono text-[10px] tracking-[0.15em] text-octo-mute">
                  No workspaces yet
                </div>
              )}
```

- [ ] **Step 2: "No projects" rail empty state**

In `src/components/WorkspaceRail.tsx`, inside the scroll container `<div>` (the one opened on line 50), render a calm empty state when there are no project groups and the rail is expanded. Add it as the first child of that container, before the `{(projects || []).map(...)}`:

```tsx
      <div className={`flex-1 flex flex-col w-full overflow-y-auto ${isCollapsed ? "gap-0.5" : "gap-2"}`}>
        {!isCollapsed && (projects || []).length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="font-serif text-[15px] leading-snug text-octo-sage">
              No projects open yet.
            </p>
            <p className="font-mono text-[11px] text-octo-mute">
              <span className="text-octo-brass">⟶</span> Add a project to begin.
            </p>
          </div>
        )}
        {(projects || []).map((project, projectIndex) => (
```

(The serif line is upright — the house rule forbids italics. The existing `em,i{font-style:normal}` rule in `styles.css` enforces this even on `font-serif`.)

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/WorkspaceRail.tsx
git commit -m "feat(rail): empty states for no-projects and no-workspaces (§4.5)"
```

---

## Task 10: Full-plan verification

- [ ] **Step 1: Typecheck + tests + Rust**

Run, expecting all green:
```bash
npm run typecheck
npm test
cd src-tauri && cargo test && cd ..
```

- [ ] **Step 2: Manual smoke test (`npm run tauri:dev`)**

Verify:
- **Close is reversible (B1):** right-click a project → Close project. It vanishes from the rail; "⟲ Recently closed" appears at the foot with a count. Expand it → Restore → the project returns to the rail with its workspaces.
- **Closing the active project (C2):** closing the currently-open project drops to the empty/welcome state (no stale canvas), and the project is in Recently closed.
- **Sole-project recovery:** with only one project, close it (→ welcome screen). Use "Open project" / the file picker on that same folder → it reopens (its `closed_at` is cleared) and is no longer in the closed list.
- **Per-project collapse (§4.6):** collapse a project with the chevron; its workspaces hide. Restart the app (`npm run tauri:dev` again) — the collapse state persists.
- **Empty states (§4.5):** a project with no workspaces shows "No workspaces yet".
- **Create for non-active project (C3):** with project A open, use a different project B's "+" to create a workspace. You stay on A (A's active workspace unchanged); B's new workspace shows under B in the rail. No broken/empty canvas.
- **Delete still works:** "Delete from disk…" removes the project entirely (not in rail, not in Recently closed).

- [ ] **Step 3: Design-system check**

Grep the diff for hardcoded hex colors (should be empty):
```bash
git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo "clean"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §4.4 Recently-closed drawer ✓ (T7), §4.5 empty states ✓ (T9), §4.6 persist per-project collapse ✓ (T8), §6.4 `closed_at` migration ✓ (T1), §7 soft-close & reopen / B1 ✓ (T1/T2/T3/T4/T6/T7) including the welcome-screen file-picker recovery path (T2 Step 3), C2 clear-current-on-close ✓ (T4/T6), C3 project-aware create ✓ (T5), C8 prune ✓ (T5/T6). Deferred items (git pulse/dots, C5, pin/reorder/archive/rename/filter) listed in the header.
- **Placeholder scan:** none — every step has concrete code/commands. Task 6 Step 6 documents an intentional transient typecheck failure that Task 7 resolves (cross-file prop loop), with a green-checkpoint alternative noted.
- **Type consistency:** `closed: ProjectInfo[]` and the `closeProject(id)`/`reopenProject(id)`/`loadClosed()` signatures match across `projectStore.ts`, its test, and the App selectors. `pruneProject(projectId: string): void` matches the interface, the App call, and both tests. The new IPC `reopenProject`/`listClosedProjects` names match the Rust `reopen_project`/`list_closed_projects` `#[tauri::command]`s. `RecentlyClosedDrawer` props (`projects`, `onReopen`) match the rail's `closedProjects`/`onReopenProject` wiring. The DB `close_project`/`reopen_project`/`list_closed_projects` methods return the same 5-tuple shape as `list_projects`.
- **Ordering caveat verified:** `list_projects` orders by `created_at ASC`, so a reopened project returns to its prior place automatically; `list_closed_projects` orders by `closed_at DESC LIMIT 10` (newest first, capped at 10) per §4.4.
