//! Jira Cloud adapter. Auth: HTTP Basic with `email:api_token`.

use super::{status_category_from_key, Issue, IssueTracker, LinkedIssueRef};
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
        Self { cfg, http: crate::tls::client() }
    }

    fn auth_header(&self) -> String {
        let raw = format!("{}:{}", self.cfg.email, self.cfg.api_token);
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
    }

    fn base(&self) -> &str {
        self.cfg.base_url.trim_end_matches('/')
    }
}

/// Build a LinkedIssueRef from a sibling shape — either an issuelinks'
/// `inwardIssue`/`outwardIssue` or a `subtasks[i]`. Both shapes have the
/// same fields (`key` + `fields.{summary, status, issuetype}`), so one
/// helper covers both.
fn linked_ref_from_json(v: &serde_json::Value, base_url: &str) -> Option<LinkedIssueRef> {
    let key = v["key"].as_str()?.to_string();
    let f = &v["fields"];
    let status_name = f["status"]["name"].as_str().unwrap_or("").to_string();
    let cat_key = f["status"]["statusCategory"]["key"].as_str().unwrap_or("");
    Some(LinkedIssueRef {
        url: format!("{}/browse/{}", base_url.trim_end_matches('/'), key),
        key,
        summary: f["summary"].as_str().unwrap_or("").to_string(),
        status_name,
        status_category: status_category_from_key(cat_key),
        issue_type: f["issuetype"]["name"].as_str().unwrap_or("").to_string(),
    })
}

/// Walk Jira's `issuelinks` array and split into (blocks, blocked_by).
/// Jira represents the relation with two perspectives:
///   - `outwardIssue` present + type.outward = "blocks"   → this ticket BLOCKS that one
///   - `inwardIssue`  present + type.inward  = "is blocked by" → this ticket IS BLOCKED BY that one
/// Non-"Blocks" link types (Relates, Duplicates, Clones, …) are skipped
/// here — they'll be surfaced under a future "Related" pill.
fn parse_issuelinks(
    raw: &serde_json::Value,
    base_url: &str,
) -> (Vec<LinkedIssueRef>, Vec<LinkedIssueRef>) {
    let mut blocks = Vec::new();
    let mut blocked_by = Vec::new();
    let Some(arr) = raw.as_array() else {
        return (blocks, blocked_by);
    };
    for link in arr {
        let type_name = link["type"]["name"].as_str().unwrap_or("");
        if !type_name.eq_ignore_ascii_case("Blocks") {
            continue;
        }
        if let Some(out) = link.get("outwardIssue") {
            if let Some(r) = linked_ref_from_json(out, base_url) {
                blocks.push(r);
            }
        } else if let Some(inw) = link.get("inwardIssue") {
            if let Some(r) = linked_ref_from_json(inw, base_url) {
                blocked_by.push(r);
            }
        }
    }
    (blocks, blocked_by)
}

fn parse_subtasks(raw: &serde_json::Value, base_url: &str) -> Vec<LinkedIssueRef> {
    let Some(arr) = raw.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|s| linked_ref_from_json(s, base_url))
        .collect()
}

/// Map one Jira issue JSON object onto our normalized `Issue`. Pure +
/// unit-tested. `base_url` is used to build the browse URL.
pub fn issue_from_json(v: &serde_json::Value, base_url: &str) -> Issue {
    let key = v["key"].as_str().unwrap_or("").to_string();
    let f = &v["fields"];
    let status_name = f["status"]["name"].as_str().unwrap_or("").to_string();
    let cat_key = f["status"]["statusCategory"]["key"].as_str().unwrap_or("");
    let subtask = f["issuetype"]["subtask"]
        .as_bool()
        .unwrap_or(false);
    let hierarchy_level = f["issuetype"]["hierarchyLevel"]
        .as_i64()
        .unwrap_or(0) as i32;
    let (blocks, blocked_by) = parse_issuelinks(&f["issuelinks"], base_url);
    let subtasks = parse_subtasks(&f["subtasks"], base_url);
    Issue {
        url: format!("{}/browse/{}", base_url.trim_end_matches('/'), key),
        key,
        summary: f["summary"].as_str().unwrap_or("").to_string(),
        status_name,
        status_category: status_category_from_key(cat_key),
        issue_type: f["issuetype"]["name"].as_str().unwrap_or("").to_string(),
        priority: f["priority"]["name"].as_str().map(|s| s.to_string()),
        parent_key: f["parent"]["key"].as_str().map(|s| s.to_string()),
        subtask,
        hierarchy_level,
        blocks,
        blocked_by,
        subtasks,
        description: description_text(&f["description"]),
    }
}

/// How much of a description a ticket carries (`Issue::description`).
const DESCRIPTION_CAP: usize = 8_000;

/// A Jira description as plain text: Atlassian Document Format (API v3)
/// read as paragraphs, headings, list items (`- `), fenced code blocks,
/// hard breaks, mention text and card URLs; a plain string as it is. Cut at
/// [`DESCRIPTION_CAP`] characters with a closing note. `None` when empty.
pub fn description_text(v: &serde_json::Value) -> Option<String> {
    let mut out = String::new();
    match v {
        serde_json::Value::String(s) => out.push_str(s),
        serde_json::Value::Object(_) => adf_node(v, &mut out),
        _ => return None,
    }
    let mut text = out.trim().to_string();
    while text.contains("\n\n\n") {
        text = text.replace("\n\n\n", "\n\n");
    }
    if text.is_empty() {
        return None;
    }
    if text.chars().count() > DESCRIPTION_CAP {
        let cut: String = text.chars().take(DESCRIPTION_CAP).collect();
        text = format!("{}\n(cut at 8,000 characters)", cut.trim_end());
    }
    Some(text)
}

fn adf_node(node: &serde_json::Value, out: &mut String) {
    let children = node["content"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    match node["type"].as_str().unwrap_or("") {
        "text" => out.push_str(node["text"].as_str().unwrap_or("")),
        "hardBreak" => out.push('\n'),
        "mention" => out.push_str(node["attrs"]["text"].as_str().unwrap_or("")),
        "inlineCard" | "blockCard" | "embedCard" => out.push_str(node["attrs"]["url"].as_str().unwrap_or("")),
        "listItem" => {
            let mut item = String::new();
            children.iter().for_each(|c| adf_node(c, &mut item));
            out.push_str(&format!("- {}\n", item.trim().replace('\n', "\n  ")));
        }
        "codeBlock" => {
            out.push_str("```\n");
            children.iter().for_each(|c| adf_node(c, out));
            out.push_str("\n```\n\n");
        }
        kind => {
            children.iter().for_each(|c| adf_node(c, out));
            if matches!(kind, "paragraph" | "heading" | "bulletList" | "orderedList" | "blockquote" | "rule" | "table" | "tableRow") {
                out.push_str("\n\n");
            } else if matches!(kind, "tableCell" | "tableHeader") {
                out.push(' ');
            }
        }
    }
}

/// Fields requested by list_my_issues — kept minimal because the row
/// rendering doesn't need issuelinks or subtasks.
const FIELDS: &str = "summary,status,issuetype,priority,parent";
/// Fields requested by get_issue — adds the link/child fields the
/// WorkContext pills depend on.
const FIELDS_DETAIL: &str = "summary,status,issuetype,priority,parent,issuelinks,subtasks,description";

impl IssueTracker for JiraClient {
    async fn list_my_issues(&self) -> AppResult<Vec<Issue>> {
        // Atlassian sunset POST /rest/api/3/search on Jira Cloud (returns 410);
        // the replacement is /rest/api/3/search/jql with the same body + response.
        // https://developer.atlassian.com/changelog/#CHANGE-2046
        let url = format!("{}/rest/api/3/search/jql", self.base());
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
            .map_err(|e| AppError::Other(format!("jira search: {}", crate::tls::describe_request_error(&e))))?;
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

    async fn list_issues_in_epic(&self, epic_key: &str) -> AppResult<Vec<Issue>> {
        // `parent = EPIC-KEY` is the modern team-managed-project syntax.
        // For company-managed projects with legacy custom-field epics,
        // `"Epic Link" = EPIC-KEY` is required; we accept failures of the
        // first form and fall back to the legacy one before giving up.
        let url = format!("{}/rest/api/3/search/jql", self.base());
        let modern = format!(
            "parent = {epic_key} AND statusCategory != Done ORDER BY status, priority"
        );
        let body = serde_json::json!({
            "jql": modern,
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
            .map_err(|e| AppError::Other(format!("jira epic search: {}", crate::tls::describe_request_error(&e))))?;
        if !resp.status().is_success() {
            // Try the legacy `Epic Link` custom field. If both fail we
            // surface the second status — usually 400 for "field unknown",
            // which is a clear enough signal in the toast.
            let legacy = format!(
                r#""Epic Link" = {epic_key} AND statusCategory != Done ORDER BY status, priority"#
            );
            let body2 = serde_json::json!({
                "jql": legacy,
                "fields": FIELDS.split(',').collect::<Vec<_>>(),
                "maxResults": 50,
            });
            let resp2 = self
                .http
                .post(&url)
                .header("Authorization", self.auth_header())
                .header("Accept", "application/json")
                .json(&body2)
                .send()
                .await
                .map_err(|e| AppError::Other(format!("jira epic search legacy: {}", crate::tls::describe_request_error(&e))))?;
            if !resp2.status().is_success() {
                return Err(AppError::Other(format!(
                    "jira epic search HTTP {}",
                    resp2.status()
                )));
            }
            let v: serde_json::Value = resp2
                .json()
                .await
                .map_err(|e| AppError::Other(format!("jira epic search parse: {e}")))?;
            return Ok(v["issues"]
                .as_array()
                .map(|arr| arr.iter().map(|i| issue_from_json(i, &self.cfg.base_url)).collect())
                .unwrap_or_default());
        }
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Other(format!("jira epic search parse: {e}")))?;
        Ok(v["issues"]
            .as_array()
            .map(|arr| arr.iter().map(|i| issue_from_json(i, &self.cfg.base_url)).collect())
            .unwrap_or_default())
    }

    async fn get_issue(&self, key: &str) -> AppResult<Issue> {
        let url = format!("{}/rest/api/3/issue/{}?fields={}", self.base(), key, FIELDS_DETAIL);
        let resp = self
            .http
            .get(&url)
            .header("Authorization", self.auth_header())
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| AppError::Other(format!("jira issue: {}", crate::tls::describe_request_error(&e))))?;
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
    use super::super::StatusCategory;

    /// A synthetic `get_issue` response in Jira's ADF shape becomes the
    /// ticket's plain-text description (#1239).
    #[test]
    fn reads_an_adf_description_as_plain_text() {
        let text = |t: &str| serde_json::json!({ "type": "text", "text": t });
        let para = |content: serde_json::Value| serde_json::json!({ "type": "paragraph", "content": content });
        let v = serde_json::json!({
            "key": "ENG-42",
            "fields": {
                "summary": "Keep the return path on sign-in",
                "description": { "type": "doc", "version": 1, "content": [
                    { "type": "heading", "attrs": { "level": 2 }, "content": [text("Test plan")] },
                    para(serde_json::json!([text("Run sample-service, then"), { "type": "hardBreak" }, text("ask "),
                        { "type": "mention", "attrs": { "id": "a1", "text": "@sample-person" } }, text(".")])),
                    { "type": "bulletList", "content": [
                        { "type": "listItem", "content": [para(serde_json::json!([text("Open /login?next=/billing")]))] },
                        { "type": "listItem", "content": [para(serde_json::json!([text("See "),
                            { "type": "inlineCard", "attrs": { "url": "https://tracker.example.com/browse/ENG-41" } }]))] }
                    ] },
                    { "type": "codeBlock", "attrs": { "language": "sh" }, "content": [text("npm run dev")] }
                ] }
            }
        });
        let issue = issue_from_json(&v, "https://tracker.example.com");
        assert_eq!(
            issue.description.as_deref(),
            Some("Test plan\n\nRun sample-service, then\nask @sample-person.\n\n- Open /login?next=/billing\n- See https://tracker.example.com/browse/ENG-41\n\n```\nnpm run dev\n```")
        );
        // No description, or a list payload that didn't ask for one: None.
        assert_eq!(issue_from_json(&serde_json::json!({ "key": "ENG-42", "fields": {} }), "https://x").description, None);
        assert_eq!(description_text(&serde_json::json!({ "type": "doc", "content": [] })), None);
        // A plain string (API v2) is kept, and the cap holds.
        assert_eq!(description_text(&serde_json::json!("Steps: run it")).as_deref(), Some("Steps: run it"));
        let long = description_text(&serde_json::json!("é".repeat(9_000))).unwrap();
        assert!(long.starts_with(&"é".repeat(8_000)) && long.ends_with("\n(cut at 8,000 characters)"), "{}", long.len());
        assert_eq!(long.chars().count(), 8_000 + "\n(cut at 8,000 characters)".chars().count());
    }

    #[test]
    fn maps_jira_issue_json() {
        let v = serde_json::json!({
            "key": "PROJ-123",
            "fields": {
                "summary": "Login page",
                "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                "issuetype": { "name": "Story", "subtask": false, "hierarchyLevel": 0 },
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
        assert_eq!(issue.subtask, false);
        assert_eq!(issue.hierarchy_level, 0);
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
        let issue = issue_from_json(&raw, "https://example.com/");
        assert_eq!(issue.hierarchy_level, 1);
        assert!(!issue.subtask);
    }

    #[test]
    fn parses_blocks_and_blocked_by_from_issuelinks() {
        // Active ticket has two outward "Blocks" (it blocks PROJ-251 and
        // PROJ-263) and one inward (PROJ-198 blocks it). Non-Blocks types
        // ("Relates" here) are dropped — they belong in a future Related pill.
        let raw = serde_json::json!({
            "key": "PROJ-247",
            "fields": {
                "summary": "active",
                "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                "issuetype": { "name": "Story", "subtask": false, "hierarchyLevel": 0 },
                "issuelinks": [
                    {
                        "type": { "name": "Blocks", "inward": "is blocked by", "outward": "blocks" },
                        "outwardIssue": {
                            "key": "PROJ-251",
                            "fields": {
                                "summary": "Migrate session storage to Redis",
                                "status": { "name": "To Do", "statusCategory": { "key": "new" } },
                                "issuetype": { "name": "Bug" }
                            }
                        }
                    },
                    {
                        "type": { "name": "Blocks", "inward": "is blocked by", "outward": "blocks" },
                        "outwardIssue": {
                            "key": "PROJ-263",
                            "fields": {
                                "summary": "Decommission legacy cookie path",
                                "status": { "name": "Backlog", "statusCategory": { "key": "new" } },
                                "issuetype": { "name": "Story" }
                            }
                        }
                    },
                    {
                        "type": { "name": "Blocks", "inward": "is blocked by", "outward": "blocks" },
                        "inwardIssue": {
                            "key": "PROJ-198",
                            "fields": {
                                "summary": "JWT key rotation runbook",
                                "status": { "name": "In Review", "statusCategory": { "key": "indeterminate" } },
                                "issuetype": { "name": "Sub-task" }
                            }
                        }
                    },
                    {
                        "type": { "name": "Relates", "inward": "relates to", "outward": "relates to" },
                        "outwardIssue": { "key": "PROJ-999", "fields": { "summary": "unrelated", "status": { "name": "Done", "statusCategory": { "key": "done" } }, "issuetype": { "name": "Story" } } }
                    }
                ]
            }
        });
        let issue = issue_from_json(&raw, "https://acme.atlassian.net/");
        assert_eq!(issue.blocks.len(), 2);
        assert_eq!(issue.blocks[0].key, "PROJ-251");
        assert_eq!(issue.blocks[0].summary, "Migrate session storage to Redis");
        assert_eq!(issue.blocks[0].url, "https://acme.atlassian.net/browse/PROJ-251");
        assert_eq!(issue.blocks[1].key, "PROJ-263");

        assert_eq!(issue.blocked_by.len(), 1);
        assert_eq!(issue.blocked_by[0].key, "PROJ-198");
        assert_eq!(issue.blocked_by[0].status_category, StatusCategory::InProgress);
    }

    #[test]
    fn parses_subtasks_field() {
        let raw = serde_json::json!({
            "key": "PROJ-247",
            "fields": {
                "summary": "parent",
                "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                "issuetype": { "name": "Story", "subtask": false, "hierarchyLevel": 0 },
                "subtasks": [
                    {
                        "key": "PROJ-258",
                        "fields": {
                            "summary": "Unit tests for token rotation helper",
                            "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                            "issuetype": { "name": "Sub-task" }
                        }
                    },
                    {
                        "key": "PROJ-264",
                        "fields": {
                            "summary": "Document the new middleware contract",
                            "status": { "name": "To Do", "statusCategory": { "key": "new" } },
                            "issuetype": { "name": "Sub-task" }
                        }
                    }
                ]
            }
        });
        let issue = issue_from_json(&raw, "https://acme.atlassian.net/");
        assert_eq!(issue.subtasks.len(), 2);
        assert_eq!(issue.subtasks[0].key, "PROJ-258");
        assert_eq!(issue.subtasks[1].status_category, StatusCategory::Todo);
    }

    #[test]
    fn no_issuelinks_or_subtasks_yields_empty_vecs() {
        // The bare-bones JSON from list endpoints doesn't include the new
        // fields; the parser should default to empty vecs, not panic.
        let raw = serde_json::json!({
            "key": "PROJ-1",
            "fields": {
                "summary": "no links",
                "status": { "name": "To Do", "statusCategory": { "key": "new" } },
                "issuetype": { "name": "Task" }
            }
        });
        let issue = issue_from_json(&raw, "https://acme.atlassian.net");
        assert!(issue.blocks.is_empty());
        assert!(issue.blocked_by.is_empty());
        assert!(issue.subtasks.is_empty());
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
        let issue = issue_from_json(&raw, "https://example.com/");
        assert_eq!(issue.hierarchy_level, -1);
        assert!(issue.subtask);
    }
}
