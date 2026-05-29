//! Jira Cloud adapter. Auth: HTTP Basic with `email:api_token`.

use super::{status_category_from_key, Issue, IssueTracker};
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
    use super::super::StatusCategory;

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
