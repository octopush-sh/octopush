# Issue Tracker (Jira Cloud) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read-only, in-IDE visibility of a developer's Jira backlog + the active workspace's linked ticket, behind a tracker-agnostic seam (Jira Cloud first).

**Architecture:** Backend (Rust + `reqwest`) holds the Jira API token and exposes a normalized `Issue` type via an `IssueTracker` trait (Jira adapter = first impl). The frontend calls Tauri commands and renders a Backlog section under the terminals in the RUN Companion + a ticket chip in the ContextHeader. Auth (base URL + email + API token) is stored on-device in `~/.octopush/settings.json` like provider keys.

**Tech Stack:** Rust (Tauri 2, `reqwest`, `base64`, `serde`), React 19 + TS, Zustand, Tailwind v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-29-issue-tracker-jira-design.md`

**Design-system:** No new top-level chrome (lives in RUN Companion + ContextHeader + a Settings section). Tokens only, NO italics, status mapped to existing octo tokens (no new colors), mono for ticket keys, brass surgical. See the spec's "Design-system alignment".

---

## File Structure

**Backend (`src-tauri/`):**
- Create `src/issue_tracker/mod.rs` — `StatusCategory`, `Issue`, `IssueTracker` trait, `detect_issue_key`, `status_category_from_key`, `my_issues_jql`. Pure + tested.
- Create `src/issue_tracker/jira.rs` — `JiraConfig`, `JiraClient`, `issue_from_json` (pure, tested), async `list_my_issues`/`get_issue` (reqwest).
- Modify `src/lib.rs` — `mod issue_tracker;` + register commands.
- Modify `src/settings.rs` — `issue_tracker` config field + getter.
- Modify `src/commands.rs` — `list_my_issues`, `get_issue`, `get_issue_tracker_config`, `save_issue_tracker_config`.

**Frontend (`src/`):**
- Modify `lib/types.ts` — `Issue`, `StatusCategory`, `IssueTrackerConfig`.
- Modify `lib/ipc.ts` — bindings.
- Create `lib/detectIssueKey.ts` + `lib/detectIssueKey.test.ts`.
- Create `stores/issuesStore.ts` + `stores/issuesStore.test.ts`.
- Create `components/BacklogPanel.tsx` + `components/BacklogPanel.test.tsx`.
- Modify `components/Companion.tsx` — mount `BacklogPanel` under terminals in RUN.
- Modify `components/ContextHeader.tsx` — ticket chip.
- Modify `components/Settings.tsx` — Issue Tracker section.

---

## Task 1: Backend seam — types, key detection, status mapping, JQL

**Files:**
- Create: `src-tauri/src/issue_tracker/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `src-tauri/src/issue_tracker/mod.rs`** with the types + pure helpers + inline tests:

```rust
//! Tracker-agnostic issue model + helpers. Jira is the first adapter
//! (`jira.rs`); the normalized `Issue` here is what the UI and (later) the
//! Octopush MCP consume, independent of the provider.

pub mod jira;

use serde::Serialize;

/// Where a ticket sits in its workflow, normalized from the provider's status
/// category so the UI can color it without knowing provider specifics.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StatusCategory {
    Todo,
    InProgress,
    Done,
    Unknown,
}

/// A tracker-agnostic ticket.
#[derive(Debug, Clone, Serialize, PartialEq)]
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
}

/// Read capabilities v1 needs. Implemented per tracker (native async-in-trait;
/// callers hold a concrete client, so no `async_trait` crate / no `dyn`).
pub trait IssueTracker {
    async fn list_my_issues(&self) -> crate::error::AppResult<Vec<Issue>>;
    async fn get_issue(&self, key: &str) -> crate::error::AppResult<Issue>;
}

/// Map a Jira-style `statusCategory.key` to our normalized category.
pub fn status_category_from_key(key: &str) -> StatusCategory {
    match key {
        "new" => StatusCategory::Todo,
        "indeterminate" => StatusCategory::InProgress,
        "done" => StatusCategory::Done,
        _ => StatusCategory::Unknown,
    }
}

/// JQL for "my open assigned tickets".
pub fn my_issues_jql() -> &'static str {
    "assignee = currentUser() AND statusCategory != Done ORDER BY status, priority"
}

/// Extract the first Jira-style key (`[A-Z][A-Z0-9]+-<digits>`) from a branch
/// name, e.g. `feat/PROJ-123-login` → `PROJ-123`. No regex dependency.
pub fn detect_issue_key(branch: &str) -> Option<String> {
    let b = branch.as_bytes();
    let n = b.len();
    let mut i = 0;
    while i < n {
        let boundary = i == 0 || !b[i - 1].is_ascii_alphanumeric();
        if boundary && b[i].is_ascii_uppercase() {
            let start = i;
            let mut j = i;
            while j < n && (b[j].is_ascii_uppercase() || b[j].is_ascii_digit()) {
                j += 1;
            }
            // Jira project keys are ≥ 2 chars (letter + ≥1 alnum), matching the
            // TS `detectIssueKey` regex `[A-Z][A-Z0-9]+-\d+`.
            if (j - start) >= 2 && j < n && b[j] == b'-' {
                let num_start = j + 1;
                let mut k = num_start;
                while k < n && b[k].is_ascii_digit() {
                    k += 1;
                }
                if k > num_start {
                    return Some(branch[start..k].to_string());
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_key_in_branch() {
        assert_eq!(detect_issue_key("feat/PROJ-123-login").as_deref(), Some("PROJ-123"));
        assert_eq!(detect_issue_key("ABC-9").as_deref(), Some("ABC-9"));
        assert_eq!(detect_issue_key("PROJ-123").as_deref(), Some("PROJ-123"));
        assert_eq!(detect_issue_key("bugfix/AB12-7-x").as_deref(), Some("AB12-7"));
    }

    #[test]
    fn no_key_when_absent() {
        assert_eq!(detect_issue_key("main"), None);
        assert_eq!(detect_issue_key("feature/login"), None);
        assert_eq!(detect_issue_key("proj-123"), None); // lowercase project
        assert_eq!(detect_issue_key("PROJ-"), None);    // no number
        assert_eq!(detect_issue_key("A-1"), None);      // 1-char project (Jira keys are ≥2)
    }

    #[test]
    fn status_category_mapping() {
        assert_eq!(status_category_from_key("new"), StatusCategory::Todo);
        assert_eq!(status_category_from_key("indeterminate"), StatusCategory::InProgress);
        assert_eq!(status_category_from_key("done"), StatusCategory::Done);
        assert_eq!(status_category_from_key("weird"), StatusCategory::Unknown);
    }

    #[test]
    fn status_category_serializes_camel_case() {
        let j = serde_json::to_string(&StatusCategory::InProgress).unwrap();
        assert_eq!(j, "\"inProgress\"");
    }
}
```

- [ ] **Step 2: Register the module in `src-tauri/src/lib.rs`** — add `mod issue_tracker;` with the other `mod` declarations.

- [ ] **Step 3: Run the tests** — `cd src-tauri && cargo test issue_tracker::tests`. Expect 4 pass. (If the native `async fn` in `IssueTracker` triggers a hard error rather than the usual dyn-compat warning, confirm the crate's Rust edition is 2021+/toolchain ≥1.75 — it is for Tauri 2; the warning is benign since we never use `dyn IssueTracker`.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/issue_tracker/mod.rs src-tauri/src/lib.rs
git commit -m "feat(jira): tracker-agnostic Issue model + key detection + status mapping"
```

---

## Task 2: Backend — Jira Cloud adapter

**Files:**
- Create: `src-tauri/src/issue_tracker/jira.rs`

- [ ] **Step 1: Create `src-tauri/src/issue_tracker/jira.rs`** with config, the pure JSON mapper (tested), and the async client:

```rust
//! Jira Cloud adapter. Auth: HTTP Basic with `email:api_token`.

use super::{status_category_from_key, Issue, IssueTracker, StatusCategory};
use crate::error::{AppError, AppResult};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraConfig {
    pub base_url: String, // e.g. https://acme.atlassian.net
    pub email: String,
    pub api_token: String,
}

pub struct JiraClient {
    cfg: JiraConfig,
    http: reqwest::Client,
}

impl JiraClient {
    pub fn new(cfg: JiraConfig) -> Self {
        Self { cfg, http: reqwest::Client::new() }
    }

    fn auth_header(&self) -> String {
        let raw = format!("{}:{}", self.cfg.email, self.cfg.api_token);
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
    }

    fn base(&self) -> &str {
        self.cfg.base_url.trim_end_matches('/')
    }
}

/// Map one Jira issue JSON object onto our normalized `Issue`. Pure +
/// unit-tested. `base_url` is used to build the browse URL.
pub fn issue_from_json(v: &serde_json::Value, base_url: &str) -> Issue {
    let key = v["key"].as_str().unwrap_or("").to_string();
    let f = &v["fields"];
    let status_name = f["status"]["name"].as_str().unwrap_or("").to_string();
    let cat_key = f["status"]["statusCategory"]["key"].as_str().unwrap_or("");
    Issue {
        url: format!("{}/browse/{}", base_url.trim_end_matches('/'), key),
        key,
        summary: f["summary"].as_str().unwrap_or("").to_string(),
        status_name,
        status_category: status_category_from_key(cat_key),
        issue_type: f["issuetype"]["name"].as_str().unwrap_or("").to_string(),
        priority: f["priority"]["name"].as_str().map(|s| s.to_string()),
        parent_key: f["parent"]["key"].as_str().map(|s| s.to_string()),
    }
}

const FIELDS: &str = "summary,status,issuetype,priority,parent";

impl IssueTracker for JiraClient {
    async fn list_my_issues(&self) -> AppResult<Vec<Issue>> {
        let url = format!("{}/rest/api/3/search", self.base());
        let body = serde_json::json!({
            "jql": super::my_issues_jql(),
            "fields": FIELDS.split(',').collect::<Vec<_>>(),
            "maxResults": 50,
        });
        let resp = self
            .http
            .post(&url)
            .header("Authorization", self.auth_header())
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Other(format!("jira search: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!("jira search HTTP {}", resp.status())));
        }
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Other(format!("jira search parse: {e}")))?;
        let issues = v["issues"]
            .as_array()
            .map(|arr| arr.iter().map(|i| issue_from_json(i, &self.cfg.base_url)).collect())
            .unwrap_or_default();
        Ok(issues)
    }

    async fn get_issue(&self, key: &str) -> AppResult<Issue> {
        let url = format!("{}/rest/api/3/issue/{}?fields={}", self.base(), key, FIELDS);
        let resp = self
            .http
            .get(&url)
            .header("Authorization", self.auth_header())
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| AppError::Other(format!("jira issue: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!("jira issue HTTP {}", resp.status())));
        }
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Other(format!("jira issue parse: {e}")))?;
        Ok(issue_from_json(&v, &self.cfg.base_url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_jira_issue_json() {
        let v = serde_json::json!({
            "key": "PROJ-123",
            "fields": {
                "summary": "Login page",
                "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                "issuetype": { "name": "Story" },
                "priority": { "name": "High" },
                "parent": { "key": "PROJ-100" }
            }
        });
        let issue = issue_from_json(&v, "https://acme.atlassian.net/");
        assert_eq!(issue.key, "PROJ-123");
        assert_eq!(issue.summary, "Login page");
        assert_eq!(issue.status_name, "In Progress");
        assert_eq!(issue.status_category, StatusCategory::InProgress);
        assert_eq!(issue.issue_type, "Story");
        assert_eq!(issue.priority.as_deref(), Some("High"));
        assert_eq!(issue.parent_key.as_deref(), Some("PROJ-100"));
        assert_eq!(issue.url, "https://acme.atlassian.net/browse/PROJ-123");
    }

    #[test]
    fn maps_issue_with_missing_optionals() {
        let v = serde_json::json!({
            "key": "X-1",
            "fields": {
                "summary": "s",
                "status": { "name": "To Do", "statusCategory": { "key": "new" } },
                "issuetype": { "name": "Task" }
            }
        });
        let issue = issue_from_json(&v, "https://acme.atlassian.net");
        assert_eq!(issue.status_category, StatusCategory::Todo);
        assert_eq!(issue.priority, None);
        assert_eq!(issue.parent_key, None);
        assert_eq!(issue.url, "https://acme.atlassian.net/browse/X-1");
    }
}
```

- [ ] **Step 2: Run tests** — `cd src-tauri && cargo test issue_tracker`. Expect the mod tests (Task 1) + these 2 jira mapping tests to pass.
- [ ] **Step 3: Build** — `cd src-tauri && cargo build` (confirm reqwest/base64 are already deps — they are, used by `providers/*` and `pty_client`).
- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/issue_tracker/jira.rs
git commit -m "feat(jira): Jira Cloud adapter (search/get + JSON mapping)"
```

---

## Task 3: Backend — settings config + Tauri commands

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add config to `src-tauri/src/settings.rs`**

Add a field to `AppSettings`:
```rust
    #[serde(default)]
    pub issue_tracker: Option<crate::issue_tracker::jira::JiraConfig>,
```
(`JiraConfig` already derives Serialize/Deserialize + camelCase, so it persists as `issueTracker: { baseUrl, email, apiToken }`.)

Add a getter mirroring `get_provider_key`:
```rust
pub fn get_issue_tracker_config() -> Option<crate::issue_tracker::jira::JiraConfig> {
    load_settings().ok().and_then(|s| s.issue_tracker)
}
```
(Match the file's existing `load_settings()` / save patterns; if `AppSettings` is constructed elsewhere with all fields, add `issue_tracker: None` there. The `#[serde(default)]` keeps older settings.json files loadable.)

- [ ] **Step 2: Add commands to `src-tauri/src/commands.rs`**

```rust
/// Build a Jira client from saved settings, or a clear error if unconfigured.
fn jira_client() -> AppResult<crate::issue_tracker::jira::JiraClient> {
    let cfg = crate::settings::get_issue_tracker_config()
        .ok_or_else(|| crate::error::AppError::Other("Issue tracker not configured".into()))?;
    Ok(crate::issue_tracker::jira::JiraClient::new(cfg))
}

/// The current user's assigned, not-done issues (the backlog).
#[tauri::command]
pub async fn list_my_issues() -> AppResult<Vec<crate::issue_tracker::Issue>> {
    use crate::issue_tracker::IssueTracker;
    jira_client()?.list_my_issues().await
}

/// A single issue by key (for the active workspace's linked ticket).
#[tauri::command]
pub async fn get_issue(key: String) -> AppResult<crate::issue_tracker::Issue> {
    use crate::issue_tracker::IssueTracker;
    jira_client()?.get_issue(&key).await
}

/// Read the saved tracker config (token included so the Settings form can
/// show it — same trust model as provider keys, on-device only).
#[tauri::command]
pub fn get_issue_tracker_config() -> Option<crate::issue_tracker::jira::JiraConfig> {
    crate::settings::get_issue_tracker_config()
}

/// Persist the tracker config to ~/.octopush/settings.json.
#[tauri::command]
pub fn save_issue_tracker_config(config: crate::issue_tracker::jira::JiraConfig) -> AppResult<()> {
    crate::settings::update_settings(|s| s.issue_tracker = Some(config))
}
```
(For `save_issue_tracker_config`, use whatever mutate-and-save helper `settings.rs` already exposes — e.g. an `update_settings(|s| ...)` or a `save_settings(s)` after loading. If none exists, load → mutate → save with the existing save fn. Match the provider-key save path.)

- [ ] **Step 3: Register commands in `src-tauri/src/lib.rs`** — add to `tauri::generate_handler![...]`:
```rust
commands::list_my_issues,
commands::get_issue,
commands::get_issue_tracker_config,
commands::save_issue_tracker_config,
```

- [ ] **Step 4: Build + test** — `cd src-tauri && cargo build` (clean) then `cargo test issue_tracker` (pure tests still pass).
- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(jira): settings config + list_my_issues/get_issue commands"
```

---

## Task 4: Frontend — types, ipc, key-detection util

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ipc.ts`
- Create: `src/lib/detectIssueKey.ts`
- Test: `src/lib/detectIssueKey.test.ts`

- [ ] **Step 1: Add types to `src/lib/types.ts`**

```ts
export type StatusCategory = "todo" | "inProgress" | "done" | "unknown";

export interface Issue {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: StatusCategory;
  issueType: string;
  priority: string | null;
  url: string;
  parentKey: string | null;
}

export interface IssueTrackerConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}
```

- [ ] **Step 2: Add ipc bindings to `src/lib/ipc.ts`**

```ts
  listMyIssues: () => invoke<Issue[]>("list_my_issues"),
  getIssue: (key: string) => invoke<Issue>("get_issue", { key }),
  getIssueTrackerConfig: () => invoke<IssueTrackerConfig | null>("get_issue_tracker_config"),
  saveIssueTrackerConfig: (config: IssueTrackerConfig) =>
    invoke<void>("save_issue_tracker_config", { config }),
```
(Import `Issue`, `IssueTrackerConfig` from `./types`.)

- [ ] **Step 3: Write the failing test `src/lib/detectIssueKey.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { detectIssueKey } from "./detectIssueKey";

describe("detectIssueKey", () => {
  it("extracts the first Jira-style key from a branch", () => {
    expect(detectIssueKey("feat/PROJ-123-login")).toBe("PROJ-123");
    expect(detectIssueKey("ABC-9")).toBe("ABC-9");
    expect(detectIssueKey("bugfix/AB12-7-x")).toBe("AB12-7");
  });
  it("returns null when there is no key", () => {
    expect(detectIssueKey("main")).toBeNull();
    expect(detectIssueKey("feature/login")).toBeNull();
    expect(detectIssueKey("proj-123")).toBeNull();
  });
});
```

- [ ] **Step 4: Run it — verify it fails** (`npx vitest run src/lib/detectIssueKey.test.ts`).

- [ ] **Step 5: Implement `src/lib/detectIssueKey.ts`** (mirrors the backend regex; documented to stay in sync with `issue_tracker::detect_issue_key`):

```ts
/** First Jira-style key (`[A-Z][A-Z0-9]+-<digits>`) in a branch name, or null.
 *  Kept in sync with the Rust `detect_issue_key`. */
export function detectIssueKey(branch: string): string | null {
  const m = branch.match(/(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+/);
  return m ? m[0] : null;
}
```

- [ ] **Step 6: Run it — verify it passes**; then `npm run typecheck` (clean).
- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/ipc.ts src/lib/detectIssueKey.ts src/lib/detectIssueKey.test.ts
git commit -m "feat(jira): frontend types, ipc bindings, detectIssueKey util"
```

---

## Task 5: Frontend — issuesStore

**Files:**
- Create: `src/stores/issuesStore.ts`
- Test: `src/stores/issuesStore.test.ts`

- [ ] **Step 1: Write the failing test `src/stores/issuesStore.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Issue } from "../lib/types";

const mockIpc = { listMyIssues: vi.fn<() => Promise<Issue[]>>() };
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useIssuesStore } = await import("./issuesStore");

const ISSUES: Issue[] = [
  { key: "PROJ-123", summary: "Login", statusName: "In Progress", statusCategory: "inProgress", issueType: "Story", priority: "High", url: "u", parentKey: null },
];

beforeEach(() => {
  useIssuesStore.setState({ issues: null, loading: false, error: null });
  mockIpc.listMyIssues.mockReset();
});

describe("issuesStore", () => {
  it("load() sets issues on success", async () => {
    mockIpc.listMyIssues.mockResolvedValue(ISSUES);
    await useIssuesStore.getState().load();
    expect(useIssuesStore.getState().issues).toEqual(ISSUES);
    expect(useIssuesStore.getState().error).toBeNull();
  });
  it("load() sets error on failure and keeps last issues", async () => {
    useIssuesStore.setState({ issues: ISSUES });
    mockIpc.listMyIssues.mockRejectedValue(new Error("boom"));
    await useIssuesStore.getState().load();
    expect(useIssuesStore.getState().error).toBeTruthy();
    expect(useIssuesStore.getState().issues).toEqual(ISSUES); // last good kept
  });
});
```

- [ ] **Step 2: Run it — verify it fails.**

- [ ] **Step 3: Implement `src/stores/issuesStore.ts`**

```ts
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Issue } from "../lib/types";

interface IssuesState {
  issues: Issue[] | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  issues: null,
  loading: false,
  error: null,
  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const issues = await ipc.listMyIssues();
      set({ issues, loading: false });
    } catch (e) {
      // Keep the last good list; surface the error quietly.
      set({ loading: false, error: String(e) });
    }
  },
}));
```

- [ ] **Step 4: Run it — verify pass**; `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/stores/issuesStore.ts src/stores/issuesStore.test.ts
git commit -m "feat(jira): issuesStore (load backlog, keep last good on error)"
```

---

## Task 6: Frontend — BacklogPanel component

**Files:**
- Create: `src/components/BacklogPanel.tsx`
- Test: `src/components/BacklogPanel.test.tsx`

- [ ] **Step 1: Write the failing test `src/components/BacklogPanel.test.tsx`**

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BacklogPanel } from "./BacklogPanel";
import { useIssuesStore } from "../stores/issuesStore";

vi.mock("../lib/ipc", () => ({ ipc: { listMyIssues: vi.fn().mockResolvedValue([]) } }));

beforeEach(() => useIssuesStore.setState({ issues: null, loading: false, error: null }));

describe("BacklogPanel", () => {
  it("shows the BACKLOG eyebrow", () => {
    render(<BacklogPanel activeKey={null} configured />);
    expect(screen.getByText(/backlog/i)).toBeInTheDocument();
  });
  it("prompts to connect when not configured", () => {
    render(<BacklogPanel activeKey={null} configured={false} />);
    expect(screen.getByText(/connect jira/i)).toBeInTheDocument();
  });
  it("lists issues with key + status", () => {
    useIssuesStore.setState({
      issues: [
        { key: "PROJ-123", summary: "Login", statusName: "In Progress", statusCategory: "inProgress", issueType: "Story", priority: "High", url: "u", parentKey: null },
      ],
    });
    render(<BacklogPanel activeKey="PROJ-123" configured />);
    expect(screen.getByText("PROJ-123")).toBeInTheDocument();
    expect(screen.getByText("Login")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it — verify it fails.**

- [ ] **Step 3: Implement `src/components/BacklogPanel.tsx`**

Props: `{ activeKey: string | null; configured: boolean }`. Reads `useIssuesStore`. Calls `load()` on mount (via `useEffect`) when `configured`. A collapsible section with the `BACKLOG` eyebrow and a small refresh affordance. Status dot color mapped to tokens — NO new colors:
```tsx
import { useEffect, useState } from "react";
import { useIssuesStore } from "../stores/issuesStore";
import { open as openExternal } from "@tauri-apps/plugin-shell"; // if available; else ipc/openUrl
import type { Issue, StatusCategory } from "../lib/types";

const STATUS_COLOR: Record<StatusCategory, string> = {
  todo: "text-octo-mute",
  inProgress: "text-octo-brass",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};

export function BacklogPanel({ activeKey, configured }: { activeKey: string | null; configured: boolean }) {
  const { issues, loading, error, load } = useIssuesStore();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (configured) void load();
  }, [configured, load]);

  return (
    <div className="border-t border-octo-hairline px-3 py-2">
      <button type="button" onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
        <span>Backlog</span>
        <span>{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="mt-2 space-y-1">
          {!configured && <div className="text-[12px] text-octo-mute">Connect Jira in Settings</div>}
          {configured && loading && !issues && <div className="text-[12px] text-octo-mute">loading…</div>}
          {configured && error && <div className="text-[12px] text-octo-mute">couldn't reach Jira</div>}
          {configured && issues && issues.length === 0 && <div className="text-[12px] text-octo-mute">No assigned tickets</div>}
          {configured && issues?.map((it: Issue) => (
            <button key={it.key} type="button" onClick={() => openExternal(it.url).catch(() => {})}
              className={`flex w-full items-center gap-2 border-l-2 px-2 py-1 text-left ${it.key === activeKey ? "border-octo-brass bg-octo-panel-2" : "border-transparent hover:bg-octo-panel-2"}`}>
              <span className={STATUS_COLOR[it.statusCategory]}>●</span>
              <span className="font-mono text-[11px] text-octo-ivory">{it.key}</span>
              <span className="flex-1 truncate text-[12px] text-octo-sage">{it.summary}</span>
              <span className="text-[10px] text-octo-mute">{it.statusName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```
NOTE: confirm the external-open mechanism. If `@tauri-apps/plugin-shell`'s `open` isn't imported elsewhere, use the project's existing "open url" path (grep for how links open, e.g. an `ipc.openExternal` or the shell plugin). Match the established approach; the test mocks ipc so external-open isn't exercised there.

- [ ] **Step 4: Run it — verify pass**; `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/components/BacklogPanel.tsx src/components/BacklogPanel.test.tsx
git commit -m "feat(jira): BacklogPanel (collapsible, status dots, active highlight)"
```

---

## Task 7: Frontend — wire into RUN Companion + ContextHeader chip

**Files:**
- Modify: `src/components/Companion.tsx`
- Modify: `src/components/ContextHeader.tsx`
- Modify: `src/App.tsx` (pass the active workspace's branch / ticket key + configured flag down)

- [ ] **Step 1: Mount `BacklogPanel` under the terminals in RUN mode (`Companion.tsx`)**

In the `mode === "run"` branch, render `CompanionTerminals` (unchanged) then `<BacklogPanel activeKey={…} configured={…} />` as a stacked second section. The Companion will need `activeIssueKey` + `issueTrackerConfigured` props (threaded from `App.tsx`), OR `BacklogPanel` reads them from a small source. Keep `BacklogPanel` presentational (props) and pass from `App` → `Companion` → `BacklogPanel`.

- [ ] **Step 2: Thread props from `App.tsx`**

`App` computes `const activeIssueKey = activeWorkspace ? detectIssueKey(activeWorkspace.branch) : null;` and tracks `issueTrackerConfigured` (from `ipc.getIssueTrackerConfig()` on mount → boolean). Pass both into `<Companion ... activeIssueKey issueTrackerConfigured />` (extend Companion's props).

- [ ] **Step 3: ContextHeader ticket chip (`ContextHeader.tsx`)**

ContextHeader already shows the workspace name + branch + (existing) PR chip. Add, when `activeIssueKey` is present, a ticket chip next to the PR chip: `◈ PROJ-123 · <status>` styled like the PR chip (mono, hairline/brass-ghost, brass on the key). Get the issue's status from the loaded `issuesStore` list (find by key); if not in the list (e.g. it's Done, excluded by the JQL), the chip may show just the key (status omitted) — do NOT block on a network fetch in the header. Clicking opens the issue URL.
- Add an `activeIssueKey?: string | null` prop to ContextHeader (passed from App), and read the matching issue from `useIssuesStore` for the status label.

- [ ] **Step 4: Typecheck + full frontend test run**

`npm run typecheck` (clean) then `npx vitest run` (all pass).

- [ ] **Step 5: Commit**

```bash
git add src/components/Companion.tsx src/components/ContextHeader.tsx src/App.tsx
git commit -m "feat(jira): backlog in RUN companion + ticket chip in ContextHeader"
```

---

## Task 8: Frontend — Settings "Issue Tracker" section

**Files:**
- Modify: `src/components/Settings.tsx`
- Test: `src/components/Settings.issuetracker.test.tsx` (new)

- [ ] **Step 1: Write the failing test** — render the Settings Issue Tracker section (export the pane or render `<Settings>` to its tab), fill base URL / email / token, click Save, assert `ipc.saveIssueTrackerConfig` called with the values (mock ipc). Also assert the token field is a password input with a show/hide toggle.

- [ ] **Step 2: Run it — verify it fails.**

- [ ] **Step 3: Implement an "Issue Tracker" section in `Settings.tsx`**

A sibling section (its own pane or a clearly separated block) with three inputs (base URL, email, API token with show/hide) + a Save button, reusing the exact input/secret recipe from the provider-key fields (`rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory ... focus:border-octo-brass`, password toggle). Load current config via `ipc.getIssueTrackerConfig()` on mount; Save via `ipc.saveIssueTrackerConfig({ baseUrl, email, apiToken })`; show a "✓ Saved" state on the button (stable width, no overlapping eyebrow — same pattern as the fixed provider Save button). Tokens only, no italics.

- [ ] **Step 4: Run the test — verify pass**; `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/components/Settings.tsx src/components/Settings.issuetracker.test.tsx
git commit -m "feat(jira): Settings Issue Tracker config section"
```

---

## Verification (after all tasks)

- [ ] `cd src-tauri && cargo test` — all pass (incl. `issue_tracker` tests).
- [ ] `npm run typecheck` — clean.
- [ ] `npx vitest run` — all pass.
- [ ] Manual (built .app): configure Jira (base URL + email + token) in Settings → open RUN → the Backlog section under Terminals lists your assigned tickets with status; in a workspace whose branch carries a key (e.g. `feat/PROJ-123-…`), the ContextHeader shows the ticket chip and that ticket is highlighted in the backlog; clicking a ticket opens it in the browser; with no/invalid config, the panel shows the "Connect Jira" / quiet-error states (no crash).
