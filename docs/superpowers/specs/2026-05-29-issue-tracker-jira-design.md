# Issue Tracker Integration (Jira Cloud) — design

**Date:** 2026-05-29
**Status:** Approved (pending spec review)

## Motivation

Octopush's workspaces are git worktrees, one per task — which maps almost 1:1 to
an issue-tracker ticket. Today a developer must leave the IDE to check Jira for
their assigned backlog, ticket status, and how a ticket relates to the work in a
workspace/PR. Bringing that visibility into Octopush reduces context-switching
and gives traceability between code (branch/PR) and the ticket.

This is also deliberately the **first** step toward an Octopush MCP server: the
normalized `Issue` shape and the per-workspace ticket linkage defined here are
exactly what the MCP will later expose to the terminal agent. Building the
in-IDE visibility first tells us what context is worth surfacing to the agent.

## Goals (v1)

- A **generic `IssueTracker` seam** with a normalized `Issue` type, and a **Jira
  Cloud** adapter as the first (and only, for now) implementation.
- **Read-only** visibility:
  - A **Backlog** list of the user's assigned, not-done tickets with status.
  - **Auto-link** the active workspace to its ticket by parsing the branch for a
    Jira key (e.g. `feat/PROJ-123-login` → `PROJ-123`), showing that ticket's
    key + status as context.
  - Surface the active workspace's **open PR** (via the existing `find_open_pr`)
    alongside its ticket.
- Jira Cloud auth via **email + API token** (Basic), stored on-device in
  `~/.octopush/settings.json` like provider keys.

## Non-goals (v1)

- Any **writes** to Jira (status transitions, comments).
- A **dependency graph** (blocks / blocked-by).
- **Manual** workspace↔ticket linking (auto-detection from the branch only).
- Additional trackers (Linear, GitHub Issues) — the seam allows them later.
- OAuth 2.0 (3LO) — the API-token path covers Jira Cloud for a single user.
- Sprint/board views, JQL customization UI.

## Architecture

Jira HTTP calls live in the **Rust backend** (using `reqwest`, like the
`providers/*` adapters), behind a generic trait. The frontend only calls Tauri
commands. This keeps the API token off the WebView, and the trait + normalized
types are reusable by the future MCP (also backend).

### `src-tauri/src/issue_tracker/mod.rs` — the seam

```rust
/// Where a ticket sits in its workflow, normalized across trackers from the
/// provider's status category.
pub enum StatusCategory { Todo, InProgress, Done, Unknown }

/// A tracker-agnostic ticket. Adapters map their native shape onto this.
pub struct Issue {
    pub key: String,            // e.g. "PROJ-123"
    pub summary: String,
    pub status_name: String,    // provider's display status, e.g. "In Review"
    pub status_category: StatusCategory,
    pub issue_type: String,     // "Story", "Bug", ...
    pub priority: Option<String>,
    pub url: String,            // deep link to the ticket
    pub parent_key: Option<String>,
}

/// One method per read capability v1 needs. Implemented per tracker.
pub trait IssueTracker {
    /// The current user's assigned, not-done issues (the backlog).
    fn list_my_issues(&self) -> AppResult<Vec<Issue>>;
    /// A single issue by key (for the active workspace's linked ticket).
    fn get_issue(&self, key: &str) -> AppResult<Issue>;
}

/// Extract the first Jira-style key from a branch name. Pure + unit-tested.
/// Regex: `\b[A-Z][A-Z0-9]+-\d+\b` (first match), else None.
pub fn detect_issue_key(branch: &str) -> Option<String>;
```

### `src-tauri/src/issue_tracker/jira.rs` — Jira Cloud adapter

- Config: `{ base_url (https://X.atlassian.net), email, api_token }`.
- Auth: `Authorization: Basic base64(email:api_token)`.
- `list_my_issues`: `POST {base}/rest/api/3/search/jql` with body
  `{ jql: "assignee = currentUser() AND statusCategory != Done ORDER BY status, priority", fields: ["summary","status","issuetype","priority","parent"], maxResults: 50 }`.
  (Atlassian sunset `/rest/api/3/search` in Jira Cloud; `/search/jql` is the
  current endpoint. Same body shape and same `{issues: [...]}` response.)
- `get_issue(key)`: `GET {base}/rest/api/3/issue/{key}?fields=summary,status,issuetype,priority,parent`.
- Mapping (pure fn `issue_from_json(&serde_json::Value) -> Issue`, unit-tested):
  - `key` ← `.key`; `summary` ← `.fields.summary`; `status_name` ←
    `.fields.status.name`; `status_category` ← map `.fields.status.statusCategory.key`
    (`new`→Todo, `indeterminate`→InProgress, `done`→Done, else Unknown);
    `issue_type` ← `.fields.issuetype.name`; `priority` ←
    `.fields.priority.name` (optional); `parent_key` ← `.fields.parent.key`
    (optional); `url` ← `{base}/browse/{key}`.
- JQL builder is a small pure fn so it's unit-testable and adjustable later.

### Credentials — `settings.rs`

Add an `issue_tracker: Option<IssueTrackerConfig>` to `AppSettings` (camelCase
`issueTracker`), with `{ base_url, email, api_token }`. Persisted in
`~/.octopush/settings.json` (same on-device store as provider keys / git creds).
Getter `get_issue_tracker_config()` mirrors `get_provider_key`.

### Commands — `commands.rs`

- `list_my_issues() -> AppResult<Vec<Issue>>` — builds the Jira adapter from
  settings; errors clearly if unconfigured.
- `get_issue(key: String) -> AppResult<Issue>`.
- `save_issue_tracker_config(cfg)` / `get_issue_tracker_config() -> Option<…>`
  (token write-only-ish, same pattern as provider keys).
- All `async` (network) so they run off the UI thread.

## Frontend

### Types / ipc

- `Issue`, `StatusCategory` (string union), `IssueTrackerConfig` in `types.ts`.
- `ipc.listMyIssues()`, `ipc.getIssue(key)`, `ipc.getIssueTrackerConfig()`,
  `ipc.saveIssueTrackerConfig(cfg)`.

### `issuesStore` (Zustand)

- State: `{ issues: Issue[] | null, loading, error, lastFetched }`.
- `load()` calls `listMyIssues`; called when the RUN companion mounts and on a
  manual refresh. **No aggressive polling** (avoid hammering Jira / rate limits);
  a manual "refresh" affordance + on-mount fetch is enough for v1.

### Companion (RUN) — `BacklogPanel`

- Rendered **below** `CompanionTerminals` as a second **stacked, collapsible**
  section (matching the chosen layout). Eyebrow `BACKLOG`.
- Each row: status dot + key (mono) + summary (truncated) + status label. The
  active workspace's linked ticket is highlighted (brass left-border, like the
  active terminal row).
- States: not-configured → "Connect Jira in Settings"; loading → quiet
  "loading…"; empty → "No assigned tickets"; error → quiet "couldn't reach
  Jira"; a small refresh affordance.
- Clicking a ticket opens its `url` (deep link) via the shell opener.

### ContextHeader — ticket chip

- For the active workspace, `detect_issue_key(branch)` → if a key is found,
  fetch/lookup the issue and show a chip `◈ PROJ-123 · In Progress` next to the
  existing branch + PR chips. Clicking opens the ticket URL.

### Settings — Jira section

- Its **own "Issue Tracker" section** in Settings (a sibling of Models &
  Providers, not crammed into it) to enter base URL, email, and API token;
  "Save" persists via `saveIssueTrackerConfig`. Same input + secret-field recipe
  (show/hide token) as the provider-key fields.

### Ticket-key detection (frontend mirror)

- A `detectIssueKey(branch)` util (same regex) for the header chip, OR call the
  backend; pick one source of truth — the backend `detect_issue_key` is
  canonical and the header can derive the key from the issue list / a small
  shared util. (Implementation: a single TS util `detectIssueKey` used by the
  header; backend keeps its own for command-side use. The regex is trivial and
  duplicating it is cheaper than a round-trip; documented to stay in sync.)

## Data flow

Enter RUN → `issuesStore.load()` → `list_my_issues` → BacklogPanel renders. The
active workspace's `branch` → `detectIssueKey` → that ticket is highlighted in
the list and shown as the ContextHeader chip (its detail via `get_issue` or the
already-loaded list). The workspace's open PR (existing `find_open_pr`) is shown
beside the ticket. Manual refresh re-fetches.

## Error handling

- Unconfigured (no creds) → the panel shows a "Connect Jira in Settings" prompt;
  the header chip is hidden. No errors thrown into the UI.
- Network/API error → the panel shows a quiet error line; the rest of RUN is
  unaffected. The store keeps the last good list.
- A branch with no detectable key → no chip, no highlight (normal).
- Rate limits → mitigated by on-mount + manual fetch only (no polling) and
  caching the last result.

## Design-system alignment (Atelier in Onyx & Brass)

- Lives entirely inside the existing RUN Companion + ContextHeader — **no new
  top-level chrome**. The Backlog section mirrors `CompanionTerminals`' styling.
- **Tokens only**; **no italics**; calm motion (collapse/expand ≤280ms ease).
- Status is shown with a small dot + label mapped to existing tokens — **no new
  colors**: `Todo`→`text-octo-mute`, `InProgress`→`text-octo-brass`,
  `Done`→`text-octo-verdigris`, `Unknown`→`text-octo-sage`.
- Ticket **key** in `font-mono`; the eyebrow `BACKLOG` in `font-mono text-[9-10px]
  uppercase tracking-[0.25em] text-octo-mute`; summary in sans `text-octo-sage`.
- The ContextHeader ticket chip matches the existing PR chip's treatment (mono,
  hairline/brass-ghost, brass accent on the key). Brass stays surgical.
- Active-workspace ticket highlight reuses the brass left-border used for the
  active terminal/workspace row.

## Testing

**Backend (Rust):**
- `detect_issue_key`: `feat/PROJ-123-login`→`PROJ-123`; `main`→None;
  `ABC-9`→`ABC-9`; lowercase/no-number → None; picks the first key.
- `issue_from_json`: a sample Jira issue JSON → correct `Issue`, incl. each
  `statusCategory` → `StatusCategory` mapping and the `{base}/browse/{key}` url;
  missing optional fields (priority/parent) → None.
- JQL builder returns the expected string.

**Frontend (Vitest):**
- `issuesStore.load()` sets issues on success, error on failure (ipc mocked).
- `BacklogPanel`: not-configured / loading / empty / error / list states; active
  ticket highlighted; clicking opens the url.
- `detectIssueKey` util parity with the backend cases.
- ContextHeader renders the ticket chip when the branch has a key, none otherwise.

## MCP synergy (why this is first)

The `IssueTracker` trait, the normalized `Issue`, and `get_issue` /
`list_my_issues` are tracker-agnostic and backend-resident. When we build the
Octopush MCP server, it exposes these (the active workspace's ticket as a
resource, the backlog as a tool) to the terminal agent with no rework — the
in-IDE visibility we build now defines that contract.

## Out of scope / future

- Jira writes (transitions, comments); dependency graph; manual linking; Linear
  / GitHub Issues adapters; OAuth; board/sprint views; JQL customization.
