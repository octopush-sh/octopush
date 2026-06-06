# Gap-Closing 3 — PR Indicators in the Rail (batch) — Plan 7

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Show an open-PR indicator in the rail — a verdigris keyline square on workspaces with an open PR, and a PR count in the per-project pulse — backed by a single batch `gh pr list` per project (event-driven, no polling), degrading silently when `gh` is unavailable.

**Architecture:** A new `open_prs_for_project(project_path)` command runs `gh pr list --state open --json ...,headRefName` once in the user's login shell (gh resolves the repo from cwd; non-GitHub / no-gh → empty, no error). The frontend maps `headRefName → workspace.branch → workspaceId` into a `workspaceStore.prByWs` cache, fetched on the same triggers as git summaries (project-set change + window focus — no timer). The rail reads `prByWs`. The ContextHeader's existing per-active poll (gh + API, all states) is left untouched, so the active-workspace PR display is unchanged.

**Tech Stack:** Rust + tokio (shell) + serde_json, Tauri 2; React 19 + TS, Zustand, Tailwind tokens, Vitest, cargo test.

**Scope decision (documented):** rail PR indicator is **gh-CLI-based**; the GitHub-API-batch fallback is deferred (dual JSON shape + pagination complexity). Active-workspace PR (ContextHeader) keeps full gh+API coverage via the unchanged `find_pr_for_branch` poll. Spec §4.2 (pulse PR count) / §4.3 (PR square) — the previously-deferred PR parts of Plan 3.

---

## Task 1: Backend — `open_prs_for_project` (gh batch) + pure parser

**Files:**
- Modify: `src-tauri/src/commands.rs` (struct + parser + command, near `find_pr_for_branch`/`try_gh_cli`)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `src-tauri/src/tests.rs` (parser unit test)

Context: `try_gh_cli` (commands.rs ~2023) shows the pattern: `tokio::process::Command::new($SHELL).arg("-l").arg("-c").arg(cmd).current_dir(path)`, gh returns a JSON array with uppercase `state` + `isDraft`. `crate::github::pr_from_json(&value)` builds a `Pr` from a json value with fields `number,title,url,state,isDraft,merged_at` (state lowercased). The `Pr` type is `crate::github::Pr`.

- [ ] **Step 1: struct + pure parser**

In `commands.rs`, near `try_gh_cli`, add:

```rust
/// A branch and its open PR, for the rail's per-workspace PR indicator.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPr {
    pub branch: String,
    pub pr: crate::github::Pr,
}

/// Parse `gh pr list --json number,title,url,state,isDraft,headRefName` output
/// (a JSON array) into branch→PR pairs. Pure (no IO) so it's unit-testable.
/// Skips entries without a headRefName. Normalises gh's UPPERCASE `state`.
pub(crate) fn parse_open_pr_list(values: &[serde_json::Value]) -> Vec<BranchPr> {
    values
        .iter()
        .filter_map(|v| {
            let branch = v.get("headRefName")?.as_str()?.to_string();
            let mut pr_val = v.clone();
            if let Some(s) = pr_val.get("state").and_then(|x| x.as_str()) {
                pr_val["state"] = serde_json::Value::String(s.to_lowercase());
            }
            Some(BranchPr {
                branch,
                pr: crate::github::pr_from_json(&pr_val),
            })
        })
        .collect()
}
```

- [ ] **Step 2: the command**

```rust
/// Batch: all OPEN pull requests for the project's GitHub repo, keyed by head
/// branch, for the rail's PR indicator. Uses the `gh` CLI in the user's login
/// shell (gh resolves owner/repo from the project's origin). Returns an empty
/// list — never an error — when gh is missing, unauthenticated, the repo isn't
/// on GitHub, or there are no open PRs. (API-batch fallback is intentionally
/// out of scope; the active-workspace PR still uses find_pr_for_branch.)
#[tauri::command]
pub async fn open_prs_for_project(project_path: String) -> AppResult<Vec<BranchPr>> {
    let project_path = expand_tilde(&project_path);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let cmd =
        "gh pr list --state open --json number,title,url,state,isDraft,headRefName --limit 200";

    let output = match tokio::process::Command::new(&shell)
        .arg("-l")
        .arg("-c")
        .arg(cmd)
        .current_dir(&project_path)
        .output()
        .await
    {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let values: Vec<serde_json::Value> = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(parse_open_pr_list(&values))
}
```

- [ ] **Step 3: register** — in `lib.rs`, near `commands::find_pr_for_branch,` add `commands::open_prs_for_project,`.

- [ ] **Step 4: parser test**

In `tests.rs`, add (verify `crate::commands::parse_open_pr_list` is reachable — it's `pub(crate)`; and `crate::github::Pr` fields: confirm `number`/`url`/`is_draft`/`state` field names by reading `src-tauri/src/github.rs`):

```rust
#[test]
fn parse_open_pr_list_maps_branch_and_normalises_state() {
    use crate::commands::parse_open_pr_list;
    let json = serde_json::json!([
        { "number": 7, "title": "Feat", "url": "https://x/7", "state": "OPEN", "isDraft": false, "headRefName": "feat/a" },
        { "number": 8, "title": "WIP",  "url": "https://x/8", "state": "OPEN", "isDraft": true,  "headRefName": "feat/b" },
        { "number": 9, "title": "no-branch", "url": "https://x/9", "state": "OPEN", "isDraft": false }
    ]);
    let arr = json.as_array().unwrap();
    let out = parse_open_pr_list(arr);
    assert_eq!(out.len(), 2, "entry without headRefName is skipped");
    assert_eq!(out[0].branch, "feat/a");
    assert_eq!(out[0].pr.number, 7);
    assert_eq!(out[1].branch, "feat/b");
}
```
(If `pr_from_json` requires a `merged_at` key or panics on its absence, add `"mergedAt": null` / `"merged_at": null` to the test objects and, if needed, map it in `parse_open_pr_list` like `try_gh_cli` does — read `pr_from_json` first and adapt. Open PRs have no merge date, so this must be handled gracefully.)

- [ ] **Step 5: run + commit**

Run `cd src-tauri && cargo test parse_open_pr_list_maps_branch_and_normalises_state` then full `cargo test` and `cargo build`.
```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs
git commit -m "feat(backend): open_prs_for_project (gh batch) for rail PR indicator"
```

---

## Task 2: Frontend types + IPC

**Files:**
- Modify: `src/lib/types.ts` (BranchPr)
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: type**

In `src/lib/types.ts` (near `Pr`):
```ts
/** A branch and its open PR, from open_prs_for_project (rail PR indicator). */
export interface BranchPr {
  branch: string;
  pr: Pr;
}
```

- [ ] **Step 2: ipc**

In `src/lib/ipc.ts` (near `findPrForBranch`):
```ts
  openPrsForProject: (projectPath: string) =>
    invoke<BranchPr[]>("open_prs_for_project", { projectPath }),
```
Add `BranchPr` to the `./types` import.

- [ ] **Step 3: verify + commit**

`npm run typecheck` → clean.
```bash
git add src/lib/types.ts src/lib/ipc.ts
git commit -m "feat(ipc): openPrsForProject + BranchPr type"
```

---

## Task 3: workspaceStore — `prByWs` cache + `loadProjectPrs`

**Files:**
- Modify: `src/stores/workspaceStore.ts`
- Test: `src/stores/workspaceStore.test.ts`

- [ ] **Step 1: failing tests**

In `workspaceStore.test.ts`, add `openPrsForProject: vi.fn()` to `mockIpc`, `prByWs: {}` to the `resetStore` state, and:
```ts
describe("workspaceStore — prByWs", () => {
  beforeEach(() => resetStore());

  it("maps open PRs onto workspaces by branch", async () => {
    const a = makeWorkspace("p1", "alpha"); // branch feat/alpha
    const b = makeWorkspace("p1", "beta");  // branch feat/beta
    useWorkspaceStore.setState({ workspacesByProjectId: { p1: [a, b] } });
    mockIpc.openPrsForProject.mockResolvedValueOnce([
      { branch: a.branch, pr: { number: 1, title: "A", url: "u1", isDraft: false, state: "open" } },
    ]);

    await useWorkspaceStore.getState().loadProjectPrs("p1", "/repo/p1");

    const map = useWorkspaceStore.getState().prByWs;
    expect(map[a.id]?.number).toBe(1);
    expect(map[b.id]).toBeNull(); // no PR for beta → explicitly null
  });
});
```
(`makeWorkspace(projectId, name)` sets `branch: feat/<name>`.) Run `npm test -- src/stores/workspaceStore.test.ts` → FAIL.

- [ ] **Step 2: implement**

In `workspaceStore.ts`:
- Import `Pr` + `BranchPr` types: extend the `../lib/types` import to include `Pr` (and `BranchPr` if you reference it; the action can type the ipc result inline).
- Interface: add
```ts
  /** Open PR per workspace id (null = no open PR), for the rail indicator. */
  prByWs: Record<string, Pr | null>;
  /** Fetch a project's open PRs (gh batch) and map them onto its workspaces. */
  loadProjectPrs: (projectId: string, projectPath: string) => Promise<void>;
```
- Initial state: `prByWs: {},`.
- Action (after `loadGitSummaries`):
```ts
  loadProjectPrs: async (projectId, projectPath) => {
    try {
      const branchPrs = await ipc.openPrsForProject(projectPath);
      const byBranch = new Map(branchPrs.map((bp) => [bp.branch, bp.pr]));
      set((s) => {
        const wss = s.workspacesByProjectId[projectId] ?? [];
        const next = { ...s.prByWs };
        for (const w of wss) next[w.id] = byBranch.get(w.branch) ?? null;
        return { prByWs: next };
      });
    } catch {
      // Non-critical — no PR indicators for this project.
    }
  },
```

- [ ] **Step 3: run + commit**

`npm test -- src/stores/workspaceStore.test.ts` → PASS. `npm run typecheck` → clean.
```bash
git add src/stores/workspaceStore.ts src/stores/workspaceStore.test.ts
git commit -m "feat(rail): workspaceStore prByWs cache + loadProjectPrs"
```

---

## Task 4: App — batch-fetch PRs (event-driven) + pass to rail

**Files:**
- Modify: `src/App.tsx`

Context (from Plan 3): App has an effect that builds `projectIds` and calls `loadAllWorkspaces` + `loadGitSummaries(id)`, and a window-focus effect that re-runs `loadGitSummaries` for `project` + `recentProjects`. `recentProjects` (and `project`) carry `.path`. `prByWs` + `loadProjectPrs` come from `useWorkspaceStore`.

- [ ] **Step 1: selectors**

Add to the `useWorkspaceStore()` destructure: `prByWs,` and `loadProjectPrs,`.

- [ ] **Step 2: fetch PRs where summaries are fetched**

In the project-set effect, alongside `ids.forEach((id) => void loadGitSummaries(id));`, also fetch PRs. But `loadProjectPrs` needs each project's PATH, not just id. Build an id→path lookup from `recentProjects` (+ current `project`) and iterate:
```tsx
    const pathById = new Map<string, string>();
    recentProjects.forEach((p) => pathById.set(p.id, p.path));
    if (project) pathById.set(project.id, project.path);
    ids.forEach((id) => {
      void loadGitSummaries(id);
      const p = pathById.get(id);
      if (p) void loadProjectPrs(id, p);
    });
```
Add `loadProjectPrs` to that effect's dep array.

- [ ] **Step 3: fetch PRs on window focus too**

In the focus effect (which already reloads git summaries for `project` + `recentProjects`), also call `loadProjectPrs(id, path)`:
```tsx
    const onFocus = () => {
      const byId = new Map<string, string>();
      if (project) byId.set(project.id, project.path);
      recentProjects.forEach((p) => byId.set(p.id, p.path));
      byId.forEach((path, id) => {
        void loadGitSummaries(id);
        void loadProjectPrs(id, path);
      });
    };
```
Add `loadProjectPrs` to that effect's dep array. (Read the actual focus effect and adapt — it currently builds a `Set<string>` of ids; switch to an id→path map as above.)

- [ ] **Step 4: pass prByWs to the rail**

In `<WorkspaceRail ... />`, add `prByWs={prByWs}` (next to `gitSummaryByWs={gitSummaryByWs}`).

- [ ] **Step 5: verify**

`npm run typecheck` → FAILS until Task 5 adds the `prByWs` prop to the rail. Expected (cross-file). Run `npm test` to confirm logic doesn't regress; commit after Task 5 for a green checkpoint, OR commit now and let Task 5 green it.

- [ ] **Step 6: commit**

```bash
git add src/App.tsx
git commit -m "feat(rail): batch-fetch open PRs (project-set + focus); pass to rail"
```

---

## Task 5: Rail — PR square (workspace row) + PR count (pulse)

**Files:**
- Modify: `src/components/WorkspaceRail.tsx`

Context (Plan 3): the rail has `gitSummaryByWs?` prop, a project header pulse computing `dirtyCount`, and a `WorkspaceRow` trailing cluster (ticket key, ↑/↓, dirty dot, active dot). The design calls for a **verdigris keyline square** for an open PR (§4.3) and a PR count in the pulse (§4.2).

- [ ] **Step 1: add the prop + type import**

- Add `Pr` to the `../lib/types` import.
- Add an optional rail prop:
```tsx
  /** Open PR per workspace id (null = none), for the PR indicator (§4.3). */
  prByWs?: Record<string, Pr | null>;
```
and destructure `prByWs,`.

- [ ] **Step 2: pulse PR count**

In the header IIFE where `dirtyCount` is computed, also compute:
```tsx
              const openPrCount = (project.workspaces || []).filter(
                (w) => prByWs?.[w.id],
              ).length;
```
In the pulse render, after the dirty `● N` / all-clear dot, add a PR count when > 0 (verdigris keyline square + count):
```tsx
                  {openPrCount > 0 && (
                    <span
                      className="flex items-center gap-1 font-mono text-[10px] text-octo-verdigris"
                      title={`${openPrCount} open PR${openPrCount === 1 ? "" : "s"}`}
                    >
                      <span className="h-1.5 w-1.5 border border-octo-verdigris" />
                      {openPrCount}
                    </span>
                  )}
```
(The `border` square — a keyline, not filled — distinguishes it from the filled dirty dot. Place it right after the dirty/all-clear span, before the `+`/chevron buttons.)

- [ ] **Step 3: per-row PR square**

Extend `WorkspaceRowProps` with `hasOpenPr?: boolean;` and destructure it. In the `.map(...)`, pass:
```tsx
                  hasOpenPr={!!prByWs?.[ws?.id ?? ""]}
```
In the expanded `WorkspaceRow` trailing cluster (where the dirty dot / active dot live), add a verdigris keyline square when `hasOpenPr` (place it before the dirty dot):
```tsx
      {hasOpenPr && (
        <span
          className="h-1.5 w-1.5 flex-shrink-0 border border-octo-verdigris"
          title="Open pull request"
        />
      )}
```
(Do NOT add it to the collapsed icon-only row.)

- [ ] **Step 4: verify**

`npm run typecheck` → clean (resolves Task 4). `npm test` → green (the WorkspaceRail button-count test is unaffected — squares are spans). `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.

- [ ] **Step 5: commit**

```bash
git add src/components/WorkspaceRail.tsx
git commit -m "feat(rail): open-PR square + pulse PR count (§4.2/§4.3)"
```

---

## Task 6: Full verification

- [ ] `npm run typecheck && npm test && (cd src-tauri && cargo test)` — all green.
- [ ] `git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo clean`.
- [ ] Manual (needs `gh` authed + a repo with an open PR): a workspace on a branch with an open PR shows a verdigris keyline square; its project pulse shows `▱N`. No gh / no PRs → nothing shows, no errors.

---

## Self-Review (during planning)

- **Coverage:** §4.3 PR square (T5), §4.2 pulse PR count (T5), batch source (T1), cache (T3), event-driven fetch (T4, no timer — matches git-summary cadence). gh-only (API-batch deferred, documented); ContextHeader untouched (no regression to active-workspace PR).
- **Placeholders:** none. T1 Step 4 flags `pr_from_json`/`Pr` field verification (read github.rs) — verification instruction, not a blank. T4 Step 5 documents the intentional transient typecheck failure resolved by T5 (same cross-file pattern as prior plans).
- **Type consistency:** Rust `BranchPr {branch, pr: Pr}` (camelCase) ↔ TS `BranchPr {branch, pr}` ↔ ipc `openPrsForProject(projectPath): BranchPr[]` ↔ command `open_prs_for_project(project_path)`. Store `prByWs: Record<string, Pr|null>` + `loadProjectPrs(projectId, projectPath)`; App passes `prByWs` to rail; rail `WorkspaceRowProps.hasOpenPr`. `loadProjectPrs` reads `workspacesByProjectId[projectId]` to map branch→ws.
- **Calm/perf:** event-driven only (no polling timer); one gh call per visible project on focus/project-change; verdigris keyline (not brass) keeps PR informational vs the brass "needs-you" dirty/active; graceful empty on no-gh.
