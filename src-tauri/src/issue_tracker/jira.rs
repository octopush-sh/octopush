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
    }
}

/// Fields requested by list_my_issues — kept minimal because the row
/// rendering doesn't need issuelinks or subtasks.
const FIELDS: &str = "summary,status,issuetype,priority,parent";
/// Fields requested by get_issue — adds the link/child fields the
/// WorkContext pills depend on.
const FIELDS_DETAIL: &str = "summary,status,issuetype,priority,parent,issuelinks,subtasks";

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
            .map_err(|e| AppError::Other(format!("jira epic search: {e}")))?;
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
                .map_err(|e| AppError::Other(format!("jira epic search legacy: {e}")))?;
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
    use super::super::StatusCategory;

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
