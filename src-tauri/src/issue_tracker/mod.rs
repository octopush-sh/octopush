//! Tracker-agnostic issue model + helpers. The adapters are Jira
//! (`jira.rs`) and Epiku (`epiku.rs`, read-only); the normalized `Issue` here
//! is what the UI and (later) the Octopush MCP consume, independent of the
//! provider.

pub mod epiku;
pub mod jira;

use serde::{Deserialize, Serialize};

/// Where a ticket sits in its workflow, normalized from the provider's status
/// category so the UI can color it without knowing provider specifics.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StatusCategory {
    Todo,
    InProgress,
    Done,
    #[default]
    Unknown,
}

/// A lightweight reference to a related ticket — enough to render in a row
/// without a second round-trip. Returned by Jira's `issuelinks` /
/// `subtasks` arrays inline, so we never need to refetch the linked
/// issues' summaries or statuses to show them in the WorkContext pills.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedIssueRef {
    pub key: String,
    pub summary: String,
    pub status_name: String,
    pub status_category: StatusCategory,
    pub issue_type: String,
    pub url: String,
}

/// A tracker-agnostic ticket. `Default` lets an adapter fill only the fields
/// its tracker has (`..Default::default()`), so a field added for one tracker
/// doesn't break the others.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
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
    /// Tickets THIS ticket blocks (outward "blocks" links). Empty for
    /// list endpoints that don't fetch issuelinks; populated by
    /// get_issue.
    #[serde(default)]
    pub blocks: Vec<LinkedIssueRef>,
    /// Tickets that block THIS ticket (inward "blocks" links — Jira
    /// renders them as "is blocked by" from the active ticket's POV).
    #[serde(default)]
    pub blocked_by: Vec<LinkedIssueRef>,
    /// Direct children of this ticket. Empty when the ticket itself is
    /// a sub-task or a leaf. For sub-task siblings, the caller queries
    /// the parent's `subtasks`.
    #[serde(default)]
    pub subtasks: Vec<LinkedIssueRef>,
    /// The ticket's description as plain text, cut at 8,000 characters
    /// (`jira::description_text`). `None` for list endpoints, which don't
    /// fetch it, and for a ticket without one.
    #[serde(default)]
    pub description: Option<String>,
}

/// Read capabilities v1 needs. Implemented per tracker (native async-in-trait;
/// callers hold a concrete client, so no `async_trait` crate / no `dyn`).
pub trait IssueTracker {
    async fn list_my_issues(&self) -> crate::error::AppResult<Vec<Issue>>;
    async fn get_issue(&self, key: &str) -> crate::error::AppResult<Issue>;
    /// All open tickets that live under `epic_key`. Used by the WorkContext
    /// "Epic" pill — the user wants visibility into what the rest of their
    /// team is doing in the same epic, not only their own assignments.
    async fn list_issues_in_epic(&self, epic_key: &str) -> crate::error::AppResult<Vec<Issue>>;
}

/// The trackers a project can read (#1127).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackerKind {
    Jira,
    Epiku,
}

/// The values a project's stored tracker choice may hold.
pub const TRACKER_CHOICES: [&str; 3] = ["jira", "epiku", "none"];

/// The tracker a project reads, from its stored choice (`jira`, `epiku`,
/// `none`) and what is configured. No choice yet means Jira wherever Jira is
/// configured, so nothing changes for existing users; a chosen tracker that
/// isn't configured reads as none.
pub fn resolve_tracker(choice: Option<&str>, jira_configured: bool, epiku_configured: bool) -> Option<TrackerKind> {
    match choice {
        Some("none") => None,
        Some("epiku") => epiku_configured.then_some(TrackerKind::Epiku),
        _ => jira_configured.then_some(TrackerKind::Jira),
    }
}

/// A project's choice as stored: empty means the default, any other value
/// must be one of [`TRACKER_CHOICES`]; the Epiku project override must be a
/// valid Epiku project id, empty meaning the one in Settings.
pub fn validate_project_choice(
    choice: Option<&str>,
    epiku_project: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    let choice = choice.map(str::trim).filter(|c| !c.is_empty());
    if let Some(c) = choice.filter(|c| !TRACKER_CHOICES.contains(c)) {
        return Err(format!("{c} isn't an issue tracker Octopush reads."));
    }
    let epiku_project = epiku_project.map(str::trim).filter(|p| !p.is_empty());
    if epiku_project.is_some_and(|p| !epiku::valid_project_id(p)) {
        return Err(epiku::INVALID_PROJECT.into());
    }
    Ok((choice.map(str::to_string), epiku_project.map(str::to_string)))
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

/// Extract the first issue key from a branch name: a Jira key
/// (`[A-Z][A-Z0-9]+-<digits>`, e.g. `feat/PROJ-123-login` → `PROJ-123`) or an
/// Epiku story id, which adds dotted numbers (`ST-2.3`, `HU-1.1`): the
/// pattern is `[A-Z][A-Z0-9]+-\d+(\.\d+)*`. A dot extends the key only when
/// a digit follows it, so `PROJ-123.fix` and `PROJ-123.` still give
/// `PROJ-123`. No regex dependency.
pub fn detect_issue_key(branch: &str) -> Option<String> {
    let b = branch.as_bytes();
    let n = b.len();
    let digits_end = |mut k: usize| {
        while k < n && b[k].is_ascii_digit() {
            k += 1;
        }
        k
    };
    let mut i = 0;
    while i < n {
        let boundary = i == 0 || !b[i - 1].is_ascii_alphanumeric();
        if boundary && b[i].is_ascii_uppercase() {
            let start = i;
            let mut j = i;
            while j < n && (b[j].is_ascii_uppercase() || b[j].is_ascii_digit()) {
                j += 1;
            }
            // Project prefixes are ≥ 2 chars (letter + ≥1 alnum), matching the
            // TS `detectIssueKey` regex `[A-Z][A-Z0-9]+-\d+(?:\.\d+)*`.
            if (j - start) >= 2 && j < n && b[j] == b'-' {
                let num_start = j + 1;
                let mut k = digits_end(num_start);
                if k > num_start {
                    while k + 1 < n && b[k] == b'.' && b[k + 1].is_ascii_digit() {
                        k = digits_end(k + 1);
                    }
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

/// A Jira key never has dotted numbers: `PROJ-12.5` names `PROJ-12`.
pub fn jira_key(key: &str) -> &str {
    key.split('.').next().unwrap_or(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jira_key_drops_dotted_numbers() {
        assert_eq!(jira_key("PROJ-12.5"), "PROJ-12");
        assert_eq!(jira_key("PROJ-7.1.2"), "PROJ-7");
        assert_eq!(jira_key("PROJ-12"), "PROJ-12");
    }

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
        assert_eq!(detect_issue_key("A-1.1"), None);    // the same for a dotted id
    }

    #[test]
    fn detects_dotted_epiku_ids_whole() {
        assert_eq!(detect_issue_key("feat/ST-2.3-login").as_deref(), Some("ST-2.3"));
        assert_eq!(detect_issue_key("HU-1.1").as_deref(), Some("HU-1.1"));
        assert_eq!(detect_issue_key("ST-1.2.3-deep").as_deref(), Some("ST-1.2.3"));
        assert_eq!(detect_issue_key("fix/[ST-10.12]").as_deref(), Some("ST-10.12"));
    }

    #[test]
    fn jira_keys_match_exactly_as_before() {
        // A dot extends a key only when a digit follows it.
        assert_eq!(detect_issue_key("feat/PROJ-123.fix").as_deref(), Some("PROJ-123"));
        assert_eq!(detect_issue_key("Fix PROJ-123.").as_deref(), Some("PROJ-123"));
        assert_eq!(detect_issue_key("PROJ-12..3").as_deref(), Some("PROJ-12"));
        assert_eq!(detect_issue_key("PROJ-123-login.v2").as_deref(), Some("PROJ-123"));
        assert_eq!(detect_issue_key("ABC-9_x").as_deref(), Some("ABC-9"));
        assert_eq!(detect_issue_key("release/1.2-PROJ-7").as_deref(), Some("PROJ-7"));
        assert_eq!(detect_issue_key("ST-.1"), None);
    }

    #[test]
    fn a_project_reads_jira_by_default_wherever_jira_is_configured() {
        use TrackerKind::{Epiku, Jira};
        assert_eq!(resolve_tracker(None, true, true), Some(Jira));
        assert_eq!(resolve_tracker(None, false, true), None);
        assert_eq!(resolve_tracker(Some("jira"), true, false), Some(Jira));
        assert_eq!(resolve_tracker(Some("jira"), false, true), None);
        assert_eq!(resolve_tracker(Some("epiku"), true, true), Some(Epiku));
        assert_eq!(resolve_tracker(Some("epiku"), true, false), None);
        assert_eq!(resolve_tracker(Some("none"), true, true), None);
        assert_eq!(serde_json::to_string(&Epiku).unwrap(), "\"epiku\"");
    }

    #[test]
    fn validates_a_project_choice() {
        assert_eq!(validate_project_choice(Some(" epiku "), Some(" sample-project ")).unwrap(),
            (Some("epiku".to_string()), Some("sample-project".to_string())));
        assert_eq!(validate_project_choice(Some(""), Some("")).unwrap(), (None, None));
        assert_eq!(validate_project_choice(None, None).unwrap(), (None, None));
        assert!(validate_project_choice(Some("linear"), None).is_err());
        assert!(validate_project_choice(Some("epiku"), Some("Bad_Id")).is_err());
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
