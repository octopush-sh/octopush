# State Colors + Persistent PR + Ticket Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic state-color tokens to Atelier, color the header's ticket key + status by issueType + statusCategory respectively, persist the PR chip after merge/close with state-conditional color, and surface the parent chain (Epic→Story or Epic→Story→Sub-task) in the chip.

**Architecture:** 2 new design tokens (`--state-blue`, `--state-purple`) feed token-based color maps for status and issueType. The Jira mapper grows `subtask` (boolean) and `hierarchyLevel` (number) to detect Epic/Sub-task locale-independently. A pure selector (`issueTypeToken`) picks a token per issue. The GitHub PR fetch broadens from `state=open` to `state=all` and returns a `state` enum so the chip can render `open/draft/merged/closed` colors. The parent chain uses `parentIssuesStore.loadAncestors(key, depth)`.

**Tech Stack:** Tailwind v4 with `@theme` CSS variables; Rust + reqwest backend (Tauri 2); React 19 + Zustand + Vitest frontend.

**Authoritative spec:** `docs/superpowers/specs/2026-06-01-state-colors-pr-epic-chain-design.md`

**Branch:** Create `feat/state-colors-pr-epic-chain` from `main` before T1. Commit on it; do NOT push between tasks.

---

## Task 1: Add design tokens to `styles.css`

**Files:**
- Modify: `src/styles.css` — the `@theme` block (around line 11-26 per the existing tokens) and the `:root` alpha block (around line 39-45).

- [ ] **Step 1: Add the 2 color tokens**

In `src/styles.css`, inside the `@theme` block, alongside the existing `--color-octo-verdigris` and `--color-octo-rouge` lines, add:

```css
  --color-state-blue:    #7a9cb8;
  --color-state-purple:  #a888b8;
```

- [ ] **Step 2: Add the 4 alpha utilities**

Inside the `:root` block where `--brass-dim`, `--brass-ghost`, etc. live, add:

```css
  --state-blue-dim:     rgba(122, 156, 184, 0.4);
  --state-blue-ghost:   rgba(122, 156, 184, 0.08);
  --state-purple-dim:   rgba(168, 136, 184, 0.4);
  --state-purple-ghost: rgba(168, 136, 184, 0.1);
```

- [ ] **Step 3: Verify Tailwind picks up the new color tokens**

Run: `npm run typecheck`
Expected: clean (tokens are CSS-only; typecheck doesn't reach them).

Run: `npx vitest run 2>&1 | tail -4`
Expected: full suite still passes (no JSX consumes the tokens yet; pure CSS addition).

Optionally, sanity-check the build picks the classes up: `npx vite build 2>&1 | tail -10`. Skip if vite build is slow — Tailwind v4 with `@theme` exposes any `--color-NAME` token as a utility (`text-state-blue`, `bg-state-blue`, `border-state-blue`) automatically.

- [ ] **Step 4: Commit**

```bash
git add src/styles.css
git commit -m "feat(theme): add --state-blue and --state-purple tokens + alphas"
```

---

## Task 2: Backend `Issue` extension — `subtask` + `hierarchy_level`

**Files:**
- Modify: `src-tauri/src/issue_tracker/mod.rs` — `Issue` struct (find via `grep -n "pub struct Issue" src-tauri/src/issue_tracker/mod.rs`).
- Modify: `src-tauri/src/issue_tracker/jira.rs` — `issue_from_json` mapper.
- Modify: `src-tauri/src/issue_tracker/jira.rs` tests — extend `maps_jira_issue_json` to assert the new fields.

- [ ] **Step 1: Update the failing test first**

In `src-tauri/src/issue_tracker/jira.rs`, locate the `maps_jira_issue_json` test (and any other JSON-mapping test). Update the seed JSON to include `subtask` and `hierarchyLevel` inside `issuetype`:

```rust
        let raw = serde_json::json!({
            "key": "PROJ-1",
            "fields": {
                "summary": "summary",
                "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                "issuetype": {
                    "name": "Story",
                    "subtask": false,
                    "hierarchyLevel": 0
                },
                "priority": { "name": "High" },
                "parent": { "key": "PROJ-0" }
            }
        });
        let issue = super::issue_from_json(&raw, "https://example.com/");
        assert_eq!(issue.key, "PROJ-1");
        assert_eq!(issue.subtask, false);
        assert_eq!(issue.hierarchy_level, 0);
```

If the existing test asserts on a specific struct literal that doesn't yet include `subtask` / `hierarchy_level`, those assertions will fail to compile — which is what we want.

Also add a NEW test in the same module for an Epic + Sub-task:

```rust
    #[test]
    fn maps_epic_issuetype_hierarchy() {
        let raw = serde_json::json!({
            "key": "EPIC-1",
            "fields": {
                "summary": "Epic summary",
                "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                "issuetype": { "name": "Epic", "subtask": false, "hierarchyLevel": 1 },
                "priority": null,
                "parent": null
            }
        });
        let issue = super::issue_from_json(&raw, "https://example.com/");
        assert_eq!(issue.hierarchy_level, 1);
        assert!(!issue.subtask);
    }

    #[test]
    fn maps_subtask_issuetype() {
        let raw = serde_json::json!({
            "key": "SUB-1",
            "fields": {
                "summary": "Sub-task summary",
                "status": { "name": "To Do", "statusCategory": { "key": "new" } },
                "issuetype": { "name": "Sub-task", "subtask": true, "hierarchyLevel": -1 },
                "priority": null,
                "parent": { "key": "STORY-1" }
            }
        });
        let issue = super::issue_from_json(&raw, "https://example.com/");
        assert_eq!(issue.hierarchy_level, -1);
        assert!(issue.subtask);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test issue_tracker 2>&1 | tail -10`
Expected: FAIL — `subtask` and `hierarchy_level` fields don't exist on `Issue`.

- [ ] **Step 3: Extend the `Issue` struct**

In `src-tauri/src/issue_tracker/mod.rs`, find `pub struct Issue` and add two fields:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub key: String,
    pub summary: String,
    pub status_name: String,
    pub status_category: StatusCategory,
    pub issue_type: String,
    pub priority: Option<String>,
    pub url: String,
    pub parent_key: Option<String>,
    pub subtask: bool,
    pub hierarchy_level: i32,
}
```

(If the struct uses additional fields, append the two new ones at the end of the field list and keep all existing fields intact.)

- [ ] **Step 4: Extend the `issue_from_json` mapper**

In `src-tauri/src/issue_tracker/jira.rs`, find `pub fn issue_from_json(...)`. After the existing field extractions, add:

```rust
    let subtask = v["fields"]["issuetype"]["subtask"]
        .as_bool()
        .unwrap_or(false);
    let hierarchy_level = v["fields"]["issuetype"]["hierarchyLevel"]
        .as_i64()
        .unwrap_or(0) as i32;
```

And include them in the `Issue { ... }` constructor at the end of the function:

```rust
    Issue {
        key,
        summary,
        status_name,
        status_category,
        issue_type,
        priority,
        url,
        parent_key,
        subtask,
        hierarchy_level,
    }
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd src-tauri && cargo test issue_tracker 2>&1 | tail -10`
Expected: all `issue_tracker` tests pass, including the two new ones.

Run: `cd src-tauri && cargo test --lib 2>&1 | tail -6`
Expected: all backend tests pass (the new fields default to false / 0 in cases that don't supply them — `.unwrap_or` covers it).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/issue_tracker/mod.rs src-tauri/src/issue_tracker/jira.rs
git commit -m "feat(jira): Issue.subtask + Issue.hierarchyLevel from Jira API"
```

---

## Task 3: Frontend `Issue` type extension + fixture updates

**Files:**
- Modify: `src/lib/types.ts` — extend the `Issue` interface.
- Modify: any test file that builds an `Issue` literal — append `subtask: false, hierarchyLevel: 0` (default for `Story`/`Bug`/`Task`-shaped fixtures).

- [ ] **Step 1: Extend the `Issue` interface**

In `src/lib/types.ts`, find the `Issue` interface. Append two fields:

```ts
export interface Issue {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: StatusCategory;
  issueType: string;
  priority: string | null;
  url: string;
  parentKey: string | null;
  subtask: boolean;
  hierarchyLevel: number;
}
```

- [ ] **Step 2: Find every test that builds an `Issue` literal**

Run: `grep -rln "summary:.*statusName:\\|statusCategory:.*issueType:" src/ --include="*.ts" --include="*.tsx"`

The grep finds files that build Issue literals inline. For each match, ensure the literal includes `subtask: false, hierarchyLevel: 0` (sensible defaults for `Story` / `Bug` / `Task` fixtures).

The known files that need updates (based on the codebase as of v0.1.36):
- `src/lib/issueTrackerSelectors.test.ts` — has an `issue(...)` helper; extend it.
- `src/components/InlineTicketPicker.test.tsx` — has an `issue(...)` helper.
- `src/components/BacklogPanel.test.tsx` — multiple inline literals.
- `src/components/ContextHeader.test.tsx` — multiple inline literals + a helper.
- `src/components/ActiveTicketPanel.test.tsx` — (deleted in v0.1.36; skip if not present).
- `src/components/ElsewhereFooter.test.tsx`, `ElsewhereModal.test.tsx`, `JiraTicketPickerModal.test.tsx`, `ProjectPickerModal.test.tsx`, `ExistingWorkspaceAlertModal.test.tsx`, `parentIssuesStore.test.ts`, `Settings.issuetracker.test.tsx` — check each.

For each helper function returning an Issue (e.g. `function issue(key, summary, …): Issue`), add the two new fields to the returned literal. For inline literals, add them inline.

Example mechanical change pattern: a fixture like

```ts
{ key: "X-1", summary: "...", statusName: "To Do", statusCategory: "todo", issueType: "Story", priority: null, url: "...", parentKey: null }
```

becomes

```ts
{ key: "X-1", summary: "...", statusName: "To Do", statusCategory: "todo", issueType: "Story", priority: null, url: "...", parentKey: null, subtask: false, hierarchyLevel: 0 }
```

- [ ] **Step 3: Run typecheck to catch any literal you missed**

Run: `npm run typecheck 2>&1 | tail -15`
Expected: clean. If TypeScript reports `Property 'subtask' is missing in type` errors, those point to the files left to update — fix them and re-run.

- [ ] **Step 4: Run full vitest suite**

Run: `npx vitest run 2>&1 | tail -5`
Expected: all suites pass (no new tests yet; we just defaulted the fields).

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/**/*.test.ts src/components/*.test.tsx src/stores/*.test.ts
git commit -m "feat(types): extend Issue with subtask + hierarchyLevel; update fixtures"
```

(Use `git add -u` or list the specific touched files — avoid `git add -A` to keep the commit scoped.)

---

## Task 4: `issueTypeToken` selector + tests

**Files:**
- Modify: `src/lib/issueTrackerSelectors.ts` — append the selector.
- Modify: `src/lib/issueTrackerSelectors.test.ts` — add 8 tests for the selector.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe(…)` block in `src/lib/issueTrackerSelectors.test.ts`:

```ts
describe("issueTypeToken", () => {
  it("Epic by hierarchyLevel maps to text-state-purple", () => {
    expect(issueTypeToken(issue("E-1", "Epic", { hierarchyLevel: 1 }))).toBe("text-state-purple");
  });

  it("Sub-task by subtask flag maps to text-state-blue", () => {
    expect(issueTypeToken(issue("S-1", "Sub-task", { subtask: true, hierarchyLevel: -1 }))).toBe("text-state-blue");
  });

  it("Story (English) maps to text-octo-verdigris", () => {
    expect(issueTypeToken(issue("X-1", "Story"))).toBe("text-octo-verdigris");
  });

  it("Story (Spanish 'Historia') maps to text-octo-verdigris", () => {
    expect(issueTypeToken(issue("X-1", "Historia"))).toBe("text-octo-verdigris");
  });

  it("Bug (English) maps to text-octo-rouge", () => {
    expect(issueTypeToken(issue("X-1", "Bug"))).toBe("text-octo-rouge");
  });

  it("Bug (Spanish 'Error' / 'Incidencia') maps to text-octo-rouge", () => {
    expect(issueTypeToken(issue("X-1", "Error"))).toBe("text-octo-rouge");
    expect(issueTypeToken(issue("X-1", "Incidencia"))).toBe("text-octo-rouge");
  });

  it("Task (English / Spanish 'Tarea') maps to text-state-blue", () => {
    expect(issueTypeToken(issue("X-1", "Task"))).toBe("text-state-blue");
    expect(issueTypeToken(issue("X-1", "Tarea"))).toBe("text-state-blue");
  });

  it("Unmapped types fall back to text-octo-brass", () => {
    expect(issueTypeToken(issue("X-1", "Spike"))).toBe("text-octo-brass");
    expect(issueTypeToken(issue("X-1", "Improvement"))).toBe("text-octo-brass");
  });
});
```

The `issue(...)` helper in this test file builds an Issue; verify it accepts an `issueType` argument (it does, per the existing tests). If the helper signature is positional `(key, statusCategory, priority)`, extend it to accept `issueType` and the optional `{ subtask?, hierarchyLevel? }` overrides:

```ts
function issue(
  key: string,
  issueType: string,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    key,
    summary: "summary " + key,
    statusName: "To Do",
    statusCategory: "todo",
    issueType,
    priority: null,
    url: "https://x/browse/" + key,
    parentKey: null,
    subtask: false,
    hierarchyLevel: 0,
    ...overrides,
  };
}
```

Also import `issueTypeToken` at the top of the test file.

- [ ] **Step 2: Run tests to verify FAIL**

Run: `npx vitest run src/lib/issueTrackerSelectors.test.ts 2>&1 | tail -10`
Expected: FAIL — `issueTypeToken` not exported yet.

- [ ] **Step 3: Implement the selector**

In `src/lib/issueTrackerSelectors.ts`, append at the bottom:

```ts
/** Map an Issue to a Tailwind text-color class based on its issue type.
 *  Locale-independent for Epic (hierarchyLevel) and Sub-task (boolean);
 *  falls back to localized-name matching for Story / Bug / Task with
 *  English + Spanish aliases. Unmapped types use brass (brand fallback).
 *
 *  Used by the ticket chip in `ContextHeader` to color each key in the
 *  parent chain by its own type. */
export function issueTypeToken(issue: Issue): string {
  if (issue.hierarchyLevel === 1) return "text-state-purple";   // Epic
  if (issue.subtask) return "text-state-blue";                  // Sub-task
  const name = issue.issueType.toLowerCase();
  if (name === "story" || name === "historia") return "text-octo-verdigris";
  if (name === "bug" || name === "error" || name === "incidencia") return "text-octo-rouge";
  if (name === "task" || name === "tarea") return "text-state-blue";
  return "text-octo-brass";
}
```

- [ ] **Step 4: Run tests to verify PASS**

Run: `npx vitest run src/lib/issueTrackerSelectors.test.ts 2>&1 | tail -8`
Expected: all selector tests pass (the 8 new + existing).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run 2>&1 | tail -5`
Expected: clean + full suite pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/issueTrackerSelectors.ts src/lib/issueTrackerSelectors.test.ts
git commit -m "feat(selectors): issueTypeToken — locale-independent issue-type → token"
```

---

## Task 5: Status token mapping + BacklogPanel parity

**Files:**
- Modify: `src/components/ContextHeader.tsx` — `STATUS_TOKEN` map (line ~27 in v0.1.36).
- Modify: `src/components/BacklogPanel.tsx` — `STATUS_DOT_COLOR` map (line ~7 in v0.1.36).
- Modify: `src/components/ContextHeader.test.tsx` — adjust the existing status-color test.

- [ ] **Step 1: Update the existing ContextHeader status-color test**

In `src/components/ContextHeader.test.tsx`, find the test that loops over status categories asserting their token classes. Update the `inProgress` expectation:

```ts
const cases: Array<["todo" | "inProgress" | "done" | "unknown", string]> = [
  ["inProgress", "text-state-blue"],   // changed from text-octo-brass
  ["todo", "text-octo-mute"],
  ["done", "text-octo-verdigris"],
  ["unknown", "text-octo-sage"],
];
```

- [ ] **Step 2: Run the test → expect it to FAIL**

Run: `npx vitest run src/components/ContextHeader.test.tsx 2>&1 | tail -10`
Expected: the status-color test fails for `inProgress` (still receives `text-octo-brass`).

- [ ] **Step 3: Update `STATUS_TOKEN` in `ContextHeader.tsx`**

In `src/components/ContextHeader.tsx`, find `const STATUS_TOKEN`:

```ts
const STATUS_TOKEN: Record<StatusCategory, string> = {
  inProgress: "text-state-blue",
  todo: "text-octo-mute",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};
```

- [ ] **Step 4: Update `STATUS_DOT_COLOR` in `BacklogPanel.tsx` (parity)**

In `src/components/BacklogPanel.tsx`:

```ts
const STATUS_DOT_COLOR: Record<StatusCategory, string> = {
  inProgress: "text-state-blue",
  todo: "text-octo-mute",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};
```

- [ ] **Step 5: Run ContextHeader tests + full suite**

Run: `npx vitest run src/components/ContextHeader.test.tsx 2>&1 | tail -10`
Expected: all pass (the status test now sees `text-state-blue` for inProgress).

Run: `npx vitest run src/components/BacklogPanel.test.tsx 2>&1 | tail -8`
Expected: all pass. The existing rows test doesn't assert on the dot color class directly, so the change is invisible to existing assertions. (Optional: add a new test asserting the inProgress dot's class — minor coverage but not required.)

Run: `npx vitest run 2>&1 | tail -4`
Expected: full suite pass.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/ContextHeader.tsx src/components/ContextHeader.test.tsx src/components/BacklogPanel.tsx
git commit -m "feat(header,backlog): status inProgress → text-state-blue (semantic)"
```

---

## Task 6: `parentIssuesStore.loadAncestors`

**Files:**
- Modify: `src/stores/parentIssuesStore.ts` — add `loadAncestors`.
- Modify: `src/stores/parentIssuesStore.test.ts` — add 3 tests.

- [ ] **Step 1: Write the failing tests**

In `src/stores/parentIssuesStore.test.ts`, append:

```ts
describe("loadAncestors", () => {
  it("loads parent only when depth === 1", async () => {
    const parent = {
      key: "STORY-1", summary: "story", statusName: "x", statusCategory: "todo" as const,
      issueType: "Story", priority: null, url: "u", parentKey: "EPIC-1",
      subtask: false, hierarchyLevel: 0,
    };
    vi.mocked(ipc.getIssue).mockResolvedValueOnce(parent);

    await useParentIssuesStore.getState().loadAncestors("STORY-1", 1);

    expect(useParentIssuesStore.getState().parents["STORY-1"]).toEqual(parent);
    expect(useParentIssuesStore.getState().parents["EPIC-1"]).toBeUndefined();
    expect(ipc.getIssue).toHaveBeenCalledTimes(1);
  });

  it("loads parent + grandparent when depth === 2 and parent has parentKey", async () => {
    const parent = {
      key: "STORY-1", summary: "story", statusName: "x", statusCategory: "todo" as const,
      issueType: "Story", priority: null, url: "u", parentKey: "EPIC-1",
      subtask: false, hierarchyLevel: 0,
    };
    const grandparent = {
      key: "EPIC-1", summary: "epic", statusName: "x", statusCategory: "inProgress" as const,
      issueType: "Epic", priority: null, url: "u", parentKey: null,
      subtask: false, hierarchyLevel: 1,
    };
    vi.mocked(ipc.getIssue)
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(grandparent);

    await useParentIssuesStore.getState().loadAncestors("STORY-1", 2);

    expect(useParentIssuesStore.getState().parents["STORY-1"]).toEqual(parent);
    expect(useParentIssuesStore.getState().parents["EPIC-1"]).toEqual(grandparent);
    expect(ipc.getIssue).toHaveBeenCalledTimes(2);
  });

  it("stops at parent when parent has no parentKey (no further lookup)", async () => {
    const orphan = {
      key: "ORPHAN-1", summary: "x", statusName: "x", statusCategory: "todo" as const,
      issueType: "Story", priority: null, url: "u", parentKey: null,
      subtask: false, hierarchyLevel: 0,
    };
    vi.mocked(ipc.getIssue).mockResolvedValueOnce(orphan);

    await useParentIssuesStore.getState().loadAncestors("ORPHAN-1", 2);

    expect(useParentIssuesStore.getState().parents["ORPHAN-1"]).toEqual(orphan);
    expect(ipc.getIssue).toHaveBeenCalledTimes(1);
  });
});
```

The test file already has `vi.mock("../lib/ipc", …)` and the `useParentIssuesStore` reset in `beforeEach`. Reuse them.

- [ ] **Step 2: Run tests to verify they FAIL**

Run: `npx vitest run src/stores/parentIssuesStore.test.ts 2>&1 | tail -10`
Expected: FAIL — `loadAncestors` does not exist on the store.

- [ ] **Step 3: Implement `loadAncestors`**

In `src/stores/parentIssuesStore.ts`, replace the existing `loadParent` implementation block with:

```ts
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Issue } from "../lib/types";

interface State {
  parents: Record<string, Issue>;
  loading: Record<string, boolean>;
  loadParent: (key: string) => Promise<void>;
  loadAncestors: (key: string, depth: number) => Promise<void>;
}

export const useParentIssuesStore = create<State>((set, get) => ({
  parents: {},
  loading: {},
  async loadParent(key) {
    const s = get();
    if (s.parents[key] || s.loading[key]) return;
    set((c) => ({ loading: { ...c.loading, [key]: true } }));
    try {
      const issue = await ipc.getIssue(key);
      set((c) => ({
        parents: { ...c.parents, [key]: issue },
        loading: { ...c.loading, [key]: false },
      }));
    } catch {
      set((c) => ({ loading: { ...c.loading, [key]: false } }));
    }
  },
  async loadAncestors(key, depth) {
    if (depth <= 0) return;
    await get().loadParent(key);
    if (depth <= 1) return;
    const issue = get().parents[key];
    if (!issue?.parentKey) return;
    await get().loadAncestors(issue.parentKey, depth - 1);
  },
}));
```

This preserves `loadParent` and adds `loadAncestors` as a recursive walker that decrements depth at each level and stops when there's no further parent.

- [ ] **Step 4: Run tests to verify PASS**

Run: `npx vitest run src/stores/parentIssuesStore.test.ts 2>&1 | tail -8`
Expected: 6/6 pass (3 existing + 3 new).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run 2>&1 | tail -5`
Expected: clean + full suite pass.

- [ ] **Step 6: Commit**

```bash
git add src/stores/parentIssuesStore.ts src/stores/parentIssuesStore.test.ts
git commit -m "feat(parentIssuesStore): loadAncestors(key, depth) for 2-level chain"
```

---

## Task 7: ContextHeader chain rendering — colored keys per type

**Files:**
- Modify: `src/components/ContextHeader.tsx` — the ticket render branch.
- Modify: `src/components/ContextHeader.test.tsx` — add 4 chain tests + adjust the existing "renders KEY in brass" assertion to "renders KEY in issue-type token".

- [ ] **Step 1: Write the failing tests for the chain**

Append inside the existing `describe("ContextHeader", …)` block in `src/components/ContextHeader.test.tsx`:

```tsx
  it("Story with Epic parent: chip shows EPIC-KEY (purple) · STORY-KEY (verdigris)", async () => {
    const workspace = makeWorkspace({ branch: "feat/CLPNSNS-92" });
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92", summary: "Story summary",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: null,
          url: "u", parentKey: "EPIC-50",
          subtask: false, hierarchyLevel: 0,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    useParentIssuesStore.setState({
      parents: {
        "EPIC-50": {
          key: "EPIC-50", summary: "Epic summary",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Epic", priority: null, url: "u", parentKey: null,
          subtask: false, hierarchyLevel: 1,
        },
      },
      loading: {},
    });

    renderHeader({ workspace, issueTrackerConfigured: true });

    const epicKey = await screen.findByText("EPIC-50");
    expect(epicKey).toHaveClass("text-state-purple");
    const storyKey = screen.getByText("CLPNSNS-92");
    expect(storyKey).toHaveClass("text-octo-verdigris");
  });

  it("Sub-task with Story + Epic chain: chip shows all 3 keys colored per type", async () => {
    const workspace = makeWorkspace({ branch: "main" });
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-92.1", summary: "Sub-task",
          statusName: "To Do", statusCategory: "todo",
          issueType: "Sub-task", priority: null,
          url: "u", parentKey: "CLPNSNS-92",
          subtask: true, hierarchyLevel: -1,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    useParentIssuesStore.setState({
      parents: {
        "CLPNSNS-92": {
          key: "CLPNSNS-92", summary: "Story",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Story", priority: null, url: "u", parentKey: "EPIC-50",
          subtask: false, hierarchyLevel: 0,
        },
        "EPIC-50": {
          key: "EPIC-50", summary: "Epic",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Epic", priority: null, url: "u", parentKey: null,
          subtask: false, hierarchyLevel: 1,
        },
      },
      loading: {},
    });
    const workspaceWithLink = { ...workspace, linkedIssueKey: "CLPNSNS-92.1" };
    renderHeader({ workspace: workspaceWithLink, issueTrackerConfigured: true });

    expect(await screen.findByText("EPIC-50")).toHaveClass("text-state-purple");
    expect(screen.getByText("CLPNSNS-92")).toHaveClass("text-octo-verdigris");
    expect(screen.getByText("CLPNSNS-92.1")).toHaveClass("text-state-blue");
  });

  it("Bug with Epic parent: ticket key uses rouge", async () => {
    const workspace = makeWorkspace({ branch: "feat/CLPNSNS-101" });
    useIssuesStore.setState({
      issues: [
        {
          key: "CLPNSNS-101", summary: "Notif duplicada",
          statusName: "Done", statusCategory: "done",
          issueType: "Bug", priority: null,
          url: "u", parentKey: "EPIC-50",
          subtask: false, hierarchyLevel: 0,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });
    useParentIssuesStore.setState({
      parents: {
        "EPIC-50": {
          key: "EPIC-50", summary: "Epic",
          statusName: "x", statusCategory: "inProgress",
          issueType: "Epic", priority: null, url: "u", parentKey: null,
          subtask: false, hierarchyLevel: 1,
        },
      },
      loading: {},
    });

    renderHeader({ workspace, issueTrackerConfigured: true });

    expect(await screen.findByText("CLPNSNS-101")).toHaveClass("text-octo-rouge");
    expect(screen.getByText("EPIC-50")).toHaveClass("text-state-purple");
  });

  it("Unmapped issueType falls back to brass on the ticket key", async () => {
    const workspace = makeWorkspace({ branch: "feat/SPIKE-1" });
    useIssuesStore.setState({
      issues: [
        {
          key: "SPIKE-1", summary: "Investigar perf",
          statusName: "In Progress", statusCategory: "inProgress",
          issueType: "Spike", priority: null,
          url: "u", parentKey: null,
          subtask: false, hierarchyLevel: 0,
        },
      ],
      loading: false, error: null, load: vi.fn().mockResolvedValue(undefined),
    });

    renderHeader({ workspace, issueTrackerConfigured: true });

    expect(await screen.findByText("SPIKE-1")).toHaveClass("text-octo-brass");
  });
```

If the existing test "Click on the ticket area calls ipc.openFileInSystem" asserts the KEY span has the class `text-octo-brass`, update that one to use `text-octo-verdigris` (or whichever type the test fixture sets) OR (cleaner) leave the existing assertion to the role/name, and let these new tests cover the color.

If the existing "renders the ticket layout" test asserts `text-octo-brass` on the key, change that fixture's `issueType` to "Spike" (unmapped → brass), OR change the assertion to `text-octo-verdigris` and the fixture issueType to "Story". Pick whichever is less intrusive.

- [ ] **Step 2: Run tests to verify FAIL**

Run: `npx vitest run src/components/ContextHeader.test.tsx 2>&1 | tail -10`
Expected: the 4 new chain tests FAIL (the parent chain isn't rendered yet; the keys all render in brass).

- [ ] **Step 3: Refactor the ticket render branch in `ContextHeader.tsx`**

In `src/components/ContextHeader.tsx`, find the existing ticket-button render:

```tsx
{activeIssue ? (
  <button … >
    <span className="text-octo-brass">◈</span>
    <span className="font-mono text-[12px] text-octo-brass">{activeIssue.key}</span>
    <span className={`… ${STATUS_TOKEN[activeIssue.statusCategory]}`}>…</span>
    <span className="h-[14px] w-px bg-octo-hairline" />
    <span className="… text-octo-ivory">{activeIssue.summary}</span>
  </button>
) : (…)}
```

Replace it with the chain-aware version. Add helper imports at top:

```tsx
import { resolveLinkage, issueTypeToken } from "../lib/issueTrackerSelectors";
```

(Both already in `issueTrackerSelectors`; `issueTypeToken` was added in Task 4.)

Inside the component, BEFORE the return, derive the chain:

```tsx
  // Active ticket parent chain: [grandparent?, parent?] then activeIssue.
  // Sub-tasks get 2 levels (depth 2); non-sub-tasks 1 level.
  useEffect(() => {
    if (!activeIssue?.parentKey) return;
    const depth = activeIssue.subtask ? 2 : 1;
    void loadAncestors(activeIssue.parentKey, depth);
  }, [activeIssue?.parentKey, activeIssue?.subtask, loadAncestors]);

  const parentIssue =
    activeIssue?.parentKey ? parents[activeIssue.parentKey] : undefined;
  const grandparentIssue =
    activeIssue?.subtask && parentIssue?.parentKey
      ? parents[parentIssue.parentKey]
      : undefined;
```

Replace the previous `useEffect([activeIssue?.parentKey, loadParent])` (which called `loadParent`) with the new one that calls `loadAncestors`.

Now update the ticket-button render:

```tsx
{activeIssue ? (
  <button
    type="button"
    aria-label="Open ticket in Jira"
    title={
      `${activeIssue.key} · ${activeIssue.issueType.toUpperCase()}` +
      (activeIssue.priority ? ` · ${activeIssue.priority.toUpperCase()}` : "") +
      (parentIssue?.summary ? ` · Epic: ${parentIssue.summary}` : "") +
      ` · ${activeIssue.summary}`
    }
    onClick={() => { void ipc.openFileInSystem(activeIssue.url).catch(() => {}); }}
    className="-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded px-1 transition hover:bg-[var(--brass-ghost)]"
  >
    <span className="text-octo-brass" aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>◈</span>
    {grandparentIssue && (
      <>
        <span className={`font-mono text-[12px] ${issueTypeToken(grandparentIssue)}`}>
          {grandparentIssue.key}
        </span>
        <span className="font-mono text-[12px] text-octo-mute" aria-hidden>·</span>
      </>
    )}
    {parentIssue && (
      <>
        <span className={`font-mono text-[12px] ${issueTypeToken(parentIssue)}`}>
          {parentIssue.key}
        </span>
        <span className="font-mono text-[12px] text-octo-mute" aria-hidden>·</span>
      </>
    )}
    <span className={`font-mono text-[12px] ${issueTypeToken(activeIssue)}`}>
      {activeIssue.key}
    </span>
    <span className={`font-mono text-[10px] uppercase tracking-[0.15em] ${STATUS_TOKEN[activeIssue.statusCategory]}`}>
      {activeIssue.statusName}
    </span>
    <span aria-hidden className="h-[14px] w-px bg-octo-hairline" />
    <span className="min-w-0 truncate font-serif text-[15px] leading-tight text-octo-ivory">
      {activeIssue.summary}
    </span>
  </button>
) : (
  // unchanged degraded WORKSPACE block
)}
```

Note the bullet separators `·` are mute mono and `aria-hidden` (screen readers shouldn't announce them).

`parents` and `loadAncestors` must be destructured from `useParentIssuesStore` near the top of the component:

```tsx
  const parents = useParentIssuesStore((s) => s.parents);
  const loadAncestors = useParentIssuesStore((s) => s.loadAncestors);
```

(Replace the existing `loadParent` selector if it was destructured separately.)

The tooltip's `Epic: <name>` uses `parentIssue?.summary` instead of the previous `parents[activeIssue.parentKey]?.summary` — semantically identical but consistent with the new derivation.

- [ ] **Step 4: Run ContextHeader tests**

Run: `npx vitest run src/components/ContextHeader.test.tsx 2>&1 | tail -10`
Expected: all pass — the 4 new chain tests + existing tests.

- [ ] **Step 5: Run full suite + typecheck**

Run: `npm run typecheck && npx vitest run 2>&1 | tail -5`
Expected: clean + full suite pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/ContextHeader.tsx src/components/ContextHeader.test.tsx
git commit -m "feat(header): render parent chain in ticket chip with per-type colors"
```

---

## Task 8: Backend — find_pr_for_branch + Pr.state

**Files:**
- Locate: `grep -rln "find_open_pr\\|fn.*pr.*branch" src-tauri/src/` to find the existing PR command's home (likely `commands.rs` and/or a `github.rs` module).
- Modify: the file holding the `Pr` struct — add `state: PrState` field; add `PrState` enum.
- Modify: the file with the GitHub query — switch to `state=all`, derive `state` from the response.
- Modify: `src-tauri/src/commands.rs` — rename the command to `find_pr_for_branch`.
- Modify: `src-tauri/src/lib.rs` — update the `generate_handler![…]` entry.
- Modify: `src-tauri/src/tests.rs` — add 4 tests for state mapping (open/draft/merged/closed).

- [ ] **Step 1: Locate the existing implementation**

Run: `grep -rln "find_open_pr\\|pub struct Pr\\|fn find_open" src-tauri/src/`

Read the file(s) the grep finds, especially:
- The `Pr` struct definition (fields, derive macros).
- The function that queries GitHub (`reqwest::get` or `gh` CLI call).
- The Tauri `#[tauri::command]` wrapper.

Take note of the exact existing names and signatures before editing.

- [ ] **Step 2: Write failing tests for the 4 state mappings**

In `src-tauri/src/tests.rs`, append (adapt struct/enum names to whatever you find in Step 1):

```rust
    #[test]
    fn pr_state_open_when_open_not_draft() {
        let raw = serde_json::json!({
            "number": 42, "html_url": "https://x/pr/42", "title": "Add",
            "state": "open", "draft": false, "merged_at": null
        });
        let pr = crate::github::pr_from_json(&raw); // adapt path
        assert_eq!(pr.state, crate::github::PrState::Open);
    }

    #[test]
    fn pr_state_draft_when_open_and_draft() {
        let raw = serde_json::json!({
            "number": 43, "html_url": "https://x/pr/43", "title": "WIP",
            "state": "open", "draft": true, "merged_at": null
        });
        let pr = crate::github::pr_from_json(&raw);
        assert_eq!(pr.state, crate::github::PrState::Draft);
    }

    #[test]
    fn pr_state_merged_when_closed_and_merged_at_set() {
        let raw = serde_json::json!({
            "number": 41, "html_url": "https://x/pr/41", "title": "Ship",
            "state": "closed", "draft": false, "merged_at": "2026-05-30T15:00:00Z"
        });
        let pr = crate::github::pr_from_json(&raw);
        assert_eq!(pr.state, crate::github::PrState::Merged);
    }

    #[test]
    fn pr_state_closed_when_closed_and_merged_at_null() {
        let raw = serde_json::json!({
            "number": 40, "html_url": "https://x/pr/40", "title": "Nope",
            "state": "closed", "draft": false, "merged_at": null
        });
        let pr = crate::github::pr_from_json(&raw);
        assert_eq!(pr.state, crate::github::PrState::Closed);
    }
```

If the existing implementation doesn't expose a pure `pr_from_json` function, extract one as part of Step 4 (refactoring the GitHub query handler to call into a pure mapper makes testing tractable).

- [ ] **Step 3: Run tests to verify FAIL**

Run: `cd src-tauri && cargo test pr_state 2>&1 | tail -10`
Expected: FAIL — `PrState` doesn't exist, neither does `pr_from_json`.

- [ ] **Step 4: Extend the `Pr` struct + add `PrState` enum**

In the file holding the `Pr` struct (likely `src-tauri/src/github.rs`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub number: i32,
    pub url: String,
    pub title: String,
    pub is_draft: bool,
    pub state: PrState,
}

/// Map the raw GitHub PR JSON into our `Pr` shape. The `state` is derived:
///   draft  ← state="open" and draft=true
///   open   ← state="open" and draft=false
///   merged ← state="closed" and merged_at is not null
///   closed ← state="closed" and merged_at is null
pub fn pr_from_json(v: &serde_json::Value) -> Pr {
    let number = v["number"].as_i64().unwrap_or(0) as i32;
    let url = v["html_url"].as_str().unwrap_or("").to_string();
    let title = v["title"].as_str().unwrap_or("").to_string();
    let is_draft = v["draft"].as_bool().unwrap_or(false);
    let gh_state = v["state"].as_str().unwrap_or("open");
    let merged_at = v["merged_at"].as_str();

    let state = match (gh_state, is_draft, merged_at) {
        ("open", true, _) => PrState::Draft,
        ("open", false, _) => PrState::Open,
        ("closed", _, Some(_)) => PrState::Merged,
        ("closed", _, None) => PrState::Closed,
        _ => PrState::Open,
    };

    Pr { number, url, title, is_draft, state }
}
```

- [ ] **Step 5: Run the state-mapping tests**

Run: `cd src-tauri && cargo test pr_state 2>&1 | tail -10`
Expected: 4/4 pass.

- [ ] **Step 6: Broaden the GitHub query to `state=all`**

In the file with the GitHub query (the function that calls `reqwest` or `gh`), change the query parameter to fetch any-state PRs:

- For REST API: change `?state=open&head={branch}` to `?state=all&head={branch}&sort=updated&direction=desc&per_page=1`.
- For `gh pr list`: change `--state open` to `--state all` and add `--limit 1`.

The response JSON should be filtered to the FIRST PR (most recent) and mapped via `pr_from_json`.

- [ ] **Step 7: Rename the Tauri command**

In `src-tauri/src/commands.rs` (or wherever it is), rename `find_open_pr` → `find_pr_for_branch` (same signature: workspace_id → Option<Pr>).

In `src-tauri/src/lib.rs`, update the `generate_handler![…]` macro entry:
- Before: `commands::find_open_pr,`
- After: `commands::find_pr_for_branch,`

- [ ] **Step 8: Run full backend tests**

Run: `cd src-tauri && cargo test --lib 2>&1 | tail -6`
Expected: all tests pass (153 baseline + 4 new + any extension count).

Run: `cd src-tauri && cargo build 2>&1 | tail -6`
Expected: clean build, no new warnings beyond the 5+1 baseline.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/
git commit -m "feat(pr): find_pr_for_branch returns Pr with state (open/draft/merged/closed)"
```

---

## Task 9: Frontend PR refactor — rename, persist, color by state

**Files:**
- Modify: `src/lib/types.ts` — rename `OpenPr` → `Pr` (or add the state field to the existing type); add `PrState` union.
- Modify: `src/lib/ipc.ts` — rename binding `findOpenPr` → `findPrForBranch`.
- Modify: `src/components/ContextHeader.tsx` — refactor PR chip render.
- Modify: `src/App.tsx` — update `openPrByWs` callers + the binding name + the prop pass to ContextHeader.
- Modify: any test fixtures that build a `Pr` literal.

- [ ] **Step 1: Update the Pr type**

In `src/lib/types.ts`, find `OpenPr` (or whatever it's named) and add a `state` field + rename if appropriate:

```ts
export type PrState = "open" | "draft" | "merged" | "closed";

export interface Pr {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
  state: PrState;
}

// If the previous type was `OpenPr`, keep a type alias for backward compat:
// export type OpenPr = Pr;
```

Remove the alias once all callers are updated (Step 4).

- [ ] **Step 2: Rename the ipc binding**

In `src/lib/ipc.ts`, find `findOpenPr` (likely `invoke<OpenPr | null>("find_open_pr", { workspaceId })`). Rename:

```ts
findPrForBranch: (workspaceId: string) =>
  invoke<Pr | null>("find_pr_for_branch", { workspaceId }),
```

Drop the old `findOpenPr` definition.

- [ ] **Step 3: Refactor the PR chip render in `ContextHeader.tsx`**

In `src/components/ContextHeader.tsx`, find the PR chip block (likely starts with `{openPr && (`). Add a state-token map at module scope (alongside `STATUS_TOKEN`):

```ts
const PR_STATE_STYLE: Record<PrState, {
  color: string;
  bg: string;
  border: string;
  glyph: string;
}> = {
  open: {
    color: "text-octo-brass",
    bg: "var(--brass-ghost)",
    border: "var(--brass-dim)",
    glyph: "●",
  },
  draft: {
    color: "text-octo-mute",
    bg: "rgba(109, 99, 84, 0.12)",
    border: "rgba(109, 99, 84, 0.4)",
    glyph: "◐",
  },
  merged: {
    color: "text-state-purple",
    bg: "var(--state-purple-ghost)",
    border: "var(--state-purple-dim)",
    glyph: "✓",
  },
  closed: {
    color: "text-octo-rouge",
    bg: "var(--rouge-active-bg)",
    border: "var(--rouge-border)",
    glyph: "✕",
  },
};
```

Rename the prop `openPr` → `pr` in the Props interface + destructure. Update the chip JSX:

```tsx
{pr && (() => {
  const style = PR_STATE_STYLE[pr.state];
  return (
    <button
      type="button"
      onClick={() => onOpenPr?.(pr.url)}
      title={`${pr.state.charAt(0).toUpperCase() + pr.state.slice(1)} pull request — ${pr.title}`}
      className={`flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] ${style.color} transition-colors`}
      style={{ background: style.bg, border: `1px solid ${style.border}` }}
    >
      <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>
        {style.glyph}
      </span>
      <span>PR · #{pr.number}</span>
      <span aria-hidden style={{ fontSize: 9, opacity: 0.6 }}>↗</span>
    </button>
  );
})()}
```

Import `PrState` from `../lib/types` at the top of the file.

- [ ] **Step 4: Update `src/App.tsx`**

Find all callers of `findOpenPr` (likely a `useEffect` populating `openPrByWs`). Rename:

```ts
// Before:
ipc.findOpenPr(activeWorkspaceId).then((pr) => setOpenPrByWs((m) => ({ ...m, [activeWorkspaceId]: pr })));

// After:
ipc.findPrForBranch(activeWorkspaceId).then((pr) => setOpenPrByWs((m) => ({ ...m, [activeWorkspaceId]: pr })));
```

Also rename the state map `openPrByWs` → `prByWs` (or leave it — cosmetic).

In the `<ContextHeader …>` call site, rename the prop:

```tsx
// Before:  openPr={openPrByWs[activeWorkspace.id] ?? null}
// After:   pr={openPrByWs[activeWorkspace.id] ?? null}
```

- [ ] **Step 5: Update test fixtures**

Search for any test that builds a PR literal:

```bash
grep -rn "isDraft:\\|find_open_pr\\|findOpenPr" src/ --include="*.ts" --include="*.tsx"
```

For each Pr literal, add `state: "open"` (default for previously-open PRs in fixtures). Example:

```ts
// Before:
{ number: 42, url: "https://x", title: "Add", isDraft: false }
// After:
{ number: 42, url: "https://x", title: "Add", isDraft: false, state: "open" }
```

In ContextHeader.test.tsx — add 4 new tests for the chip colors per state:

```tsx
  it("PR chip in open state uses brass", () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    renderHeader({
      workspace,
      openPr: { number: 1, url: "u", title: "t", isDraft: false, state: "open" } as any,
    });
    expect(screen.getByText("PR · #1")).toHaveClass("text-octo-brass");
  });

  it("PR chip in draft state uses mute", () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    renderHeader({
      workspace,
      openPr: { number: 2, url: "u", title: "t", isDraft: true, state: "draft" } as any,
    });
    expect(screen.getByText("PR · #2")).toHaveClass("text-octo-mute");
  });

  it("PR chip in merged state uses state-purple", () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    renderHeader({
      workspace,
      openPr: { number: 3, url: "u", title: "t", isDraft: false, state: "merged" } as any,
    });
    expect(screen.getByText("PR · #3")).toHaveClass("text-state-purple");
  });

  it("PR chip in closed state uses rouge", () => {
    const workspace = makeWorkspace({ branch: "feat/x" });
    renderHeader({
      workspace,
      openPr: { number: 4, url: "u", title: "t", isDraft: false, state: "closed" } as any,
    });
    expect(screen.getByText("PR · #4")).toHaveClass("text-octo-rouge");
  });
```

(Adjust the prop name from `openPr` to `pr` per Step 3's rename if you also updated the `renderHeader` helper to accept `pr` instead of `openPr`. Pick one name and use it consistently.)

- [ ] **Step 6: Typecheck + run tests**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: clean. If TypeScript reports `Property 'state' is missing` errors on PR literals, update those fixtures.

Run: `npx vitest run 2>&1 | tail -5`
Expected: all suites pass — existing + 4 new PR chip tests.

- [ ] **Step 7: Commit**

```bash
git add src/
git commit -m "feat(header): persistent PR chip colored by state (open/draft/merged/closed)"
```

---

## Task 10: Holistic review + ship v0.1.37

**Files:** none modified beyond review notes and the build.

- [ ] **Step 1: Run the full backend + frontend suites**

```bash
npm run typecheck
npx vitest run
cd src-tauri && cargo test --lib && cd ..
```

Expected: all green.

- [ ] **Step 2: Visual verification on a real workspace**

Build the .app with the cache-busting recipe:

```bash
rm -rf src-tauri/target/release/bundle
touch src-tauri/src/lib.rs
npm run tauri:build
```

Launch and verify:
- Workspace whose ticket is a Story under an Epic: chip renders `◈ EPIC-50 · CLPNSNS-92 · IN PROGRESS · summary` with EPIC purple, CLPNSNS green, IN PROGRESS blue.
- Workspace whose ticket is a Sub-task: chain shows all 3 keys colored by type.
- Workspace whose ticket is a Bug: ticket key is rouge.
- Workspace whose ticket is type "Spike" or custom: ticket key falls back to brass.
- BacklogPanel inProgress dot is blue (matches header status word).
- PR chip stays visible after a PR merges, colored purple.
- PR chip after closed-without-merge: rouge with `✕` glyph.

- [ ] **Step 3: Merge + release v0.1.37**

```bash
git checkout main
git merge feat/state-colors-pr-epic-chain --no-edit
# Verify the merge landed before proceeding (per the v0.1.34 ghost-release lesson):
git log --oneline -3
# Then ship:
rm -rf src-tauri/target/release/bundle
touch src-tauri/src/lib.rs
npm run release -- 0.1.37
```
