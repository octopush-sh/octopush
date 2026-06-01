//! GitHub PR helpers — pure data types and JSON mapper used by the PR commands.

use serde::{Deserialize, Serialize};

/// The lifecycle state of a pull request, as understood by Octopush.
///
/// GitHub's REST API returns two fields — `state` ("open"/"closed") and
/// `draft` (bool) — plus `merged_at` (null or a timestamp string). We
/// collapse these into a single semantic enum so the frontend can apply the
/// correct color without re-deriving the logic.
///
/// Wire format (via `serde(rename_all = "lowercase")`):
///   `"open"` | `"draft"` | `"merged"` | `"closed"`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

/// A pull request returned by `find_pr_for_branch`.
///
/// `camelCase` serialization matches what the TypeScript frontend expects.
/// `is_draft` is kept for backward compatibility (the frontend previously read
/// it); the authoritative state is `state`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub is_draft: bool,
    pub state: PrState,
}

/// Map a raw GitHub PR JSON value (from the REST API or `gh pr list`) into
/// a `Pr`.
///
/// State derivation rules:
/// - `state="open"`,  `draft=true`         → `PrState::Draft`
/// - `state="open"`,  `draft=false`        → `PrState::Open`
/// - `state="closed"`, `merged_at` is set  → `PrState::Merged`
/// - `state="closed"`, `merged_at` is null → `PrState::Closed`
/// - anything else                         → `PrState::Open` (safe fallback)
///
/// The REST API uses `html_url`; the `gh pr list --json` output uses `url`.
/// This function checks both.
pub fn pr_from_json(v: &serde_json::Value) -> Pr {
    let number = v["number"].as_u64().unwrap_or(0);
    // REST API field is "html_url"; gh CLI field is "url".
    let url = v["html_url"]
        .as_str()
        .or_else(|| v["url"].as_str())
        .unwrap_or("")
        .to_string();
    let title = v["title"].as_str().unwrap_or("").to_string();
    let is_draft = v["draft"]
        .as_bool()
        .or_else(|| v["isDraft"].as_bool())
        .unwrap_or(false);
    let gh_state = v["state"].as_str().unwrap_or("open");
    // merged_at is a string timestamp when merged, or JSON null / missing otherwise.
    let merged_at = v["merged_at"].as_str();

    let state = match (gh_state, is_draft, merged_at) {
        ("open", true, _) => PrState::Draft,
        ("open", false, _) => PrState::Open,
        // The `gh` CLI returns `state="MERGED"` (normalized to lowercase by
        // try_gh_cli) directly when a PR is merged. The REST API instead
        // returns `state="closed"` + `merged_at: <timestamp>` for the same
        // PR. Handle both shapes.
        ("merged", _, _) => PrState::Merged,
        ("closed", _, Some(_)) => PrState::Merged,
        ("closed", _, None) => PrState::Closed,
        _ => PrState::Open,
    };

    Pr {
        number,
        url,
        title,
        is_draft,
        state,
    }
}
