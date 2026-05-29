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
