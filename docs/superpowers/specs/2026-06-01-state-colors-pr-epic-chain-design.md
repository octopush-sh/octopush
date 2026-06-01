# State colors + persistent PR + ticket chain — design

**Date:** 2026-06-01
**Status:** Approved (pending spec review)
**Extends:** `2026-06-01-active-ticket-header-design.md` — adds semantics to the colors and structure that header introduced.

## Motivation

The header shipped in v0.1.36 shows the active ticket but its color choices
are brand-leaning rather than semantic: `inProgress` uses the brass accent
(the same color as the ticket key and signature `◈`), `todo` uses generic
mute, and the ticket key always uses brass regardless of its own issue
type. A developer can't tell at a glance whether a ticket is an Epic,
Story, Task, or Bug from the chip alone — Jira and GitHub conditionally
color these in their native UIs because dev work patterns differ
meaningfully by type and state, and those signals are missed today.

Two more gaps emerge from daily use:

- The PR chip vanishes the moment a PR closes (whether merged or rejected),
  so the workspace's recent shipment context disappears.
- The ticket key shows in isolation. For a Story the user mentally maps it
  to the larger Epic; for a Sub-task they map it twice (story + epic).
  Today neither chain is visible.

This redesign adds semantic state-color tokens (within Atelier's
constraints), a persistent PR chip that colors by GitHub state, and a
ticket chip that surfaces the parent chain (with each link colored by its
own issue type).

## Goals (v1)

- Extend the design system with two new tokens: `--state-blue` and
  `--state-purple` + their alpha utilities (`-ghost`, `-dim`). Both
  desaturated and warm-shifted to match the existing Atelier hues.
- Replace the status color mapping in the header's chip:
  - `inProgress` → `--state-blue` (Jira's "active work" semantic).
  - `todo` → `--color-octo-mute` (unchanged).
  - `done` → `--color-octo-verdigris` (unchanged).
  - `unknown` → `--color-octo-sage` (unchanged).
- Color the ticket key (and each parent in the chain) by **issue type**:
  - Epic → `--state-purple`.
  - Story → `--color-octo-verdigris`.
  - Task → `--state-blue`.
  - Bug → `--color-octo-rouge`.
  - Sub-task → `--state-blue`.
  - Fallback (unmapped) → `--color-octo-brass` (brand accent).
- Display the parent chain in the chip:
  - Non-Sub-task with parent: `◈ <parent-key> · <ticket-key> · STATUS · summary`.
  - Non-Sub-task without parent: `◈ <ticket-key> · STATUS · summary`.
  - Sub-task with parent + grandparent: `◈ <grandparent-key> · <parent-key> · <ticket-key> · STATUS · summary`.
  - Sub-task with only parent (no grandparent loaded or none exists):
    `◈ <parent-key> · <ticket-key> · STATUS · summary`.
- Backend: replace the open-PR-only query with a "find any PR for branch"
  query. Extend the `Pr` type with a `state` field
  (`"open" | "draft" | "merged" | "closed"`).
- Frontend PR chip: persists after merge/close. Glyph + color per state.

## Non-goals (v1)

- Configurable / user-overridable color mappings.
- Showing parent summary inline in the chip (only the key; the existing
  `title` tooltip already carries the Epic summary when known).
- Three or more levels of ancestry beyond a Sub-task's grandparent.
- Multiple PRs per workspace (we display the most recent for the branch).
- Status color on the BacklogPanel rows changing — the rows keep
  `STATUS_DOT_COLOR` aligned with the header's new mapping (see Section
  "BacklogPanel parity" below) but no further row redesign.

## Architecture

### Design system extension

`src/styles.css` `@theme` block gains:

```css
  --color-state-blue:    #7a9cb8;
  --color-state-purple:  #a888b8;
```

And the `:root` alpha utilities block gains:

```css
  --state-blue-dim:   rgba(122, 156, 184, 0.4);
  --state-blue-ghost: rgba(122, 156, 184, 0.08);
  --state-purple-dim:   rgba(168, 136, 184, 0.4);
  --state-purple-ghost: rgba(168, 136, 184, 0.1);
```

These follow the existing brass/rouge alpha pattern exactly (a `dim`
border-strength variant and a `ghost` background-strength variant).

### Issue type detection (locale-independent)

Jira's `issuetype.name` is localized per the user's account (Spanish
accounts return "Historia"/"Tarea"/"Épica"/"Subtarea" — verified in
production by the user's instance). We can NOT branch on the `name`
string alone.

Two Jira API fields ARE locale-independent and we'll use both:

- `fields.issuetype.subtask` (boolean) — true exactly for sub-tasks.
- `fields.issuetype.hierarchyLevel` (number) — `-1` for sub-tasks, `0`
  for standard issues, `1` for Epics.

Backend `Issue` struct (`src-tauri/src/issue_tracker/mod.rs`) gains:

```rust
pub struct Issue {
    // …existing fields…
    pub subtask: bool,
    pub hierarchy_level: i32,
}
```

These map to `issueType.subtask` and `issueType.hierarchyLevel` in the TS
shape (`subtask: boolean`, `hierarchyLevel: number`).

The selector that picks a token (added to
`src/lib/issueTrackerSelectors.ts`):

```ts
export function issueTypeToken(issue: Issue): string {
  if (issue.hierarchyLevel === 1) return "text-state-purple";   // Epic
  if (issue.subtask) return "text-state-blue";                  // Sub-task
  // Standard level: differentiate by name with localized aliases.
  const name = issue.issueType.toLowerCase();
  if (name === "story" || name === "historia") return "text-octo-verdigris";
  if (name === "bug" || name === "error" || name === "incidencia") return "text-octo-rouge";
  if (name === "task" || name === "tarea") return "text-state-blue";
  return "text-octo-brass"; // fallback for custom or unmapped types
}
```

Story/Bug/Task aliases for Spanish are baked in because Spanish is the
user's confirmed locale. Custom types (e.g., "Improvement", "Epic Story")
fall through to brass — a safe brand-accent default that won't mislead.

### Status color mapping

Replaces the v0.1.36 `STATUS_TOKEN` in `ContextHeader.tsx`:

```ts
const STATUS_TOKEN: Record<StatusCategory, string> = {
  inProgress: "text-state-blue",
  todo: "text-octo-mute",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};
```

Brass leaves the status row entirely. It remains the brand accent on:
`◈`, the active rail row, eyebrow labels, picker `⟶`, refresh hover,
unmapped issue types (fallback only).

### Ticket chip layout (parent chain)

The active region in `ContextHeader.tsx` adds the chain. The current
v0.1.36 chip is:

```
◈ KEY · STATUS · summary
```

becomes:

```
◈ [grandparent-key]? · [parent-key]? · KEY · STATUS · summary
```

Concretely, for the four meaningful cases:

- **Top-level (no parent)**: `◈ CLPNSNS-92 · IN PROGRESS · summary`.
- **Story with Epic parent**:
  `◈ EPIC-50 · CLPNSNS-92 · IN PROGRESS · summary`.
- **Sub-task with Story parent + Epic grandparent**:
  `◈ EPIC-50 · CLPNSNS-92 · CLPNSNS-92.1 · TO DO · summary`.
- **Sub-task whose Story parent has no Epic loaded yet (or no Epic exists)**:
  `◈ CLPNSNS-92 · CLPNSNS-92.1 · TO DO · summary` (no synthesized
  ancestor; the chain renders what it has).

Each key segment uses `issueTypeToken(issue)` for its own color. The `·`
separators are mute mono (existing `text-octo-mute` token).

The status word respects `STATUS_TOKEN[activeIssue.statusCategory]`.

The `◈` glyph remains brass (signature detail).

### Parent chain loading

`useParentIssuesStore` (currently 1-level cache) extends to 2-level lookup:

- `loadParent(key)` keeps its existing behavior.
- New `loadAncestors(key, depth=2)` recursively loads parent → parent's
  parent up to the given depth. Used by `ContextHeader` when the active
  issue is a Sub-task.
- Cache keyed by issue key (existing). Concurrent calls coalesce.

`ContextHeader.tsx` calls:

```ts
useEffect(() => {
  if (!activeIssue?.parentKey) return;
  void loadAncestors(activeIssue.parentKey, activeIssue.subtask ? 2 : 1);
}, [activeIssue?.parentKey, activeIssue?.subtask, loadAncestors]);
```

The chip renders the chain progressively: parent appears when loaded,
grandparent appears when loaded (Sub-tasks only). Non-blocking — the
ticket key is always visible from the first render.

### PR persistence (backend)

**Locate the existing command:** the plan starts by grepping
`src-tauri/src/commands.rs` (and any related files like a `github.rs`
module) for `find_open_pr` or the equivalent name. The implementation
file holds the existing GitHub query. Rename the command + the
implementation function to `find_pr_for_branch(workspace_id) ->
AppResult<Option<Pr>>`, and update the Tauri `generate_handler![…]`
list in `lib.rs`. The frontend binding in `src/lib/ipc.ts` is renamed in
lockstep. The implementation queries GitHub for the most recent PR with
the workspace's branch as head, regardless of state.

The exact GitHub API change depends on what the existing implementation
uses:

- If `GET /repos/{owner}/{repo}/pulls?state=open&head=...` → switch to
  `?state=all&head=...&sort=updated&direction=desc&per_page=1`.
- If `gh pr list` CLI → change `--state open` to `--state all` and add
  `--limit 1`.

Backend `Pr` struct (likely in `src-tauri/src/github.rs` or similar) gains:

```rust
pub struct Pr {
    pub number: i32,
    pub url: String,
    pub title: String,
    pub is_draft: bool,
    pub state: PrState,  // NEW
}

pub enum PrState { Open, Draft, Merged, Closed }
```

Where `Draft` is derived from `is_draft && state === "open"` (GitHub
represents draft as an open PR with `draft: true`). Serialized
`#[serde(rename_all = "camelCase")]` so the TS shape is `state:
"open" | "draft" | "merged" | "closed"`.

### PR chip (frontend)

The chip is no longer gated on `openPr` truthy with an implicit open
assumption; it now gates on `pr` truthy and renders glyph + color by
`pr.state`:

```ts
const PR_STATE_TOKEN: Record<Pr["state"], { color: string; bg: string; border: string; glyph: string }> = {
  open:   { color: "text-octo-brass",     bg: "var(--brass-ghost)",         border: "var(--brass-dim)",         glyph: "●" },
  draft:  { color: "text-octo-mute",      bg: "rgba(109, 99, 84, 0.12)",    border: "rgba(109, 99, 84, 0.4)",   glyph: "◐" },
  merged: { color: "text-state-purple",   bg: "var(--state-purple-ghost)",  border: "var(--state-purple-dim)",  glyph: "✓" },
  closed: { color: "text-octo-rouge",     bg: "var(--rouge-active-bg)",     border: "var(--rouge-border)",      glyph: "✕" },
};
```

The chip text remains `PR · #N` with the trailing `↗`. Click behavior:
unchanged — `ipc.openFileInSystem(pr.url)`. The chip persists for the
lifetime of the branch's most-recent PR (even after merge/close).

### BacklogPanel parity

`BacklogPanel.tsx`'s `STATUS_DOT_COLOR` map updates in lockstep with the
header's `STATUS_TOKEN`:

```ts
const STATUS_DOT_COLOR: Record<StatusCategory, string> = {
  inProgress: "text-state-blue",
  todo: "text-octo-mute",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};
```

Reasoning: visual consistency. A row that's "In Progress" should color
the dot the same blue that the header's status word uses. No other
changes to the row.

## Data flow

- `list_my_issues` and `get_issue` already return the Jira `issuetype`
  object. The backend extension adds `subtask` and `hierarchy_level` to
  the response model from those calls. No new IPC; no new round-trips.
- `find_pr_for_branch` replaces the open-only query; called once per
  workspace switch (same trigger today).
- `parentIssuesStore.loadAncestors(key, depth)` calls `ipc.getIssue(key)`
  for the parent, then (if `depth > 1` and `parent.parentKey` exists)
  recursively calls `loadAncestors(parent.parentKey, depth - 1)`. Cache
  hits are immediate; misses are fire-and-forget; errors are quiet (the
  chip just won't show that segment).

## Edge cases

| Situation | Header renders |
|---|---|
| Active issue with no parentKey | `◈ KEY · STATUS · summary` (no chain). |
| Active issue is Sub-task; parent loaded; grandparent loading | `◈ PARENT · KEY · STATUS · summary` — grandparent fades in when loaded. |
| Active issue is Sub-task; parent has no parentKey itself | `◈ PARENT · KEY · STATUS · summary` (no synthesized ancestor). |
| Active issue with unmapped issueType (e.g., "Spike", "Improvement") | KEY colored brass (fallback). |
| PR exists with `state === "merged"` | Persistent chip in `state-purple` with `✓` glyph. |
| PR exists with `state === "closed"` (not merged) | Persistent chip in `rouge` with `✕` glyph. |
| No PR yet for the branch | Chip hidden (today's behavior preserved). |
| `find_pr_for_branch` 4xx (e.g. no GitHub access) | Chip hidden + quiet log (today's behavior preserved). |

## Design-system alignment (Atelier in Onyx & Brass)

This redesign **extends the palette**, which the system explicitly
permits via CLAUDE.md rule #7 ("No new colors without spec update"). This
document is the spec update. The two new tokens are added once, used
consistently, and do not create a precedent for unrestrained palette
growth.

- Brass remains the **brand accent**. It now appears in fewer places
  in the header (the `◈` glyph, fallback for unmapped issue types, the
  PR chip in `open` state). Outside the header, brass usage is
  unchanged: rail active row, eyebrow labels, picker glyph.
- The new `--state-blue` (#7a9cb8) and `--state-purple` (#a888b8) are
  intentionally desaturated and warm-shifted from Jira's literal hues
  (`#0052CC` blue, `#6554c0` purple). They sit in the same luminance
  band as `--color-octo-verdigris` (#8fc9a8) and `--color-octo-rouge`
  (#d18b8b), so the Atelier feel stays cohesive.
- Sub-task icon stays as today (`◈`). The chain reads left-to-right
  ancestor-to-descendant — convention in Jira's own breadcrumb.
- No italics, no `Spectral` font, no new top-level chrome.

## Testing

**`src/lib/issueTrackerSelectors.test.ts`** — extend with `issueTypeToken`:

- Epic (`hierarchyLevel: 1`) → `text-state-purple`.
- Sub-task (`subtask: true`) → `text-state-blue`.
- Story (English name `"Story"`) → `text-octo-verdigris`.
- Story (Spanish name `"Historia"`) → `text-octo-verdigris`.
- Bug (`"Bug"`) → `text-octo-rouge`.
- Bug (`"Error"`, `"Incidencia"`) → `text-octo-rouge`.
- Task (`"Task"`, `"Tarea"`) → `text-state-blue`.
- Unmapped (e.g., `"Spike"`) → `text-octo-brass`.

**`src/stores/parentIssuesStore.test.ts`** — extend:

- `loadAncestors(key, 2)` calls `getIssue` for parent, then for
  grandparent (when parent has its own `parentKey`).
- Depth limit honored: `loadAncestors(key, 1)` only fetches parent.
- Concurrent calls coalesce (same as existing).
- Failures quiet, don't cache absent values, leave `loading` cleared.

**`src/components/ContextHeader.test.tsx`** — extend:

- Story with Epic parent: chip renders `EPIC-KEY` (purple) + `STORY-KEY`
  (verdigris) + status.
- Sub-task with Story + Epic chain: chip renders 3 keys with their
  respective colors.
- Status `inProgress` uses `text-state-blue` (replaces the previous
  brass assertion).
- IssueType fallback (`"Spike"`) renders brass.

**Backend tests** (`src-tauri/src/tests.rs`):

- `find_pr_for_branch` returns a `merged` PR when GitHub mock returns
  `{ state: "closed", merged_at: "<timestamp>" }`.
- `find_pr_for_branch` returns a `closed` PR when GitHub mock returns
  `{ state: "closed", merged_at: null }`.
- `find_pr_for_branch` returns a `draft` PR when GitHub mock returns
  `{ state: "open", draft: true }`.
- `find_pr_for_branch` returns an `open` PR when GitHub mock returns
  `{ state: "open", draft: false }`.
- `Issue` JSON mapping picks up `subtask` and `hierarchy_level` from
  `fields.issuetype.subtask` and `fields.issuetype.hierarchyLevel`.

## Out of scope / future

- A "type icon" in front of each key (Jira shows tiny SVG icons per
  type). The color change should be enough signal for v1.
- Multiple PRs per branch / showing the entire PR history.
- PR action affordances (e.g., a "Mark ready for review" button when
  draft).
- User-configurable color preferences.
- Parent chain for stories with custom hierarchies (e.g., Theme → Epic
  → Story); v1 only handles the standard 0/1/-1 hierarchy levels.
