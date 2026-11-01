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
/// A pull request candidate for "start a workspace from a PR", as returned
/// by `gh pr list --json number,title,headRefName,author`.
///
/// `camelCase` serialization matches the TypeScript `PrInfo` shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub title: String,
    pub head_ref_name: String,
    /// The author's login. `gh` nests it as `author.login`; bots or deleted
    /// accounts may omit it entirely.
    pub author: Option<String>,
}

/// Parse the stdout of `gh pr list --json number,title,headRefName,author`.
///
/// Rows missing `number` or `headRefName` are skipped (we can't fetch a PR
/// head without both); non-JSON input (e.g. `gh` auth guidance printed to
/// stdout) is an error.
pub fn pr_infos_from_json(raw: &str) -> Result<Vec<PrInfo>, String> {
    let values: Vec<serde_json::Value> =
        serde_json::from_str(raw).map_err(|e| e.to_string())?;
    Ok(values
        .iter()
        .filter_map(|v| {
            Some(PrInfo {
                number: v["number"].as_u64()?,
                title: v["title"].as_str().unwrap_or("").to_string(),
                head_ref_name: v["headRefName"].as_str()?.to_string(),
                author: v["author"]["login"].as_str().map(str::to_string),
            })
        })
        .collect())
}

/// The login-shell command that materialises a PR's head ref as a local
/// branch: `git fetch origin pull/<n>/head:<headRefName>`. Single quotes in
/// the branch name are shell-escaped (`'\''`), matching the push/pull
/// commands' escaping convention.
pub fn pr_fetch_command(number: u64, head_ref_name: &str) -> String {
    format!(
        "git fetch origin 'pull/{}/head:{}' 2>&1",
        number,
        head_ref_name.replace('\'', "'\\''"),
    )
}

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

/// An open GitHub issue, as listed for the "Ship it" flow. Parsed from
/// `gh issue list --json number,title,body,url` output.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhIssue {
    pub number: i64,
    pub title: String,
    /// Body capped by the CALLER when folded into a run task; carried whole
    /// here so the picker can show a preview line.
    pub body: String,
    pub url: String,
}

/// Parse `gh issue list --json number,title,body,url` output. Lenient: rows
/// missing a number or title are skipped, never fatal.
pub fn issues_from_json(raw: &str) -> Result<Vec<GhIssue>, serde_json::Error> {
    let vals: Vec<serde_json::Value> = serde_json::from_str(raw)?;
    Ok(vals
        .into_iter()
        .filter_map(|v| {
            Some(GhIssue {
                number: v.get("number")?.as_i64()?,
                title: v.get("title")?.as_str()?.to_string(),
                body: v.get("body").and_then(|b| b.as_str()).unwrap_or_default().to_string(),
                url: v.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_string(),
            })
        })
        .collect())
}

/// Where GitHub looks for a repo's pull-request template, in its lookup order
/// (the file name is case-insensitive on GitHub; these are the two spellings
/// people actually commit).
pub const PR_TEMPLATE_PATHS: &[&str] = &[
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
];

/// Templates longer than this are cut — the draft prompt has a budget too.
const PR_TEMPLATE_MAX_CHARS: usize = 8_000;

/// The repo's pull-request template under `root`, if it has a non-empty one.
pub fn find_pr_template(root: &std::path::Path) -> Option<String> {
    PR_TEMPLATE_PATHS.iter().find_map(|rel| {
        let text = std::fs::read_to_string(root.join(rel)).ok()?;
        let text = text.trim();
        (!text.is_empty()).then(|| text.chars().take(PR_TEMPLATE_MAX_CHARS).collect())
    })
}

/// What the PR composer drafts from: the branch's diff against the base
/// (`git diff base...HEAD`, capped by the caller's prompt), its commit
/// subjects (newest first) and the repo's PR template, if any.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDraftContext {
    pub branch: String,
    pub diff: String,
    pub commits: Vec<String>,
    pub template: Option<String>,
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The login-shell command that opens a pull request. Every user value is
/// single-quoted (`'\''` escaping, as for push/pull) and the body never
/// touches the shell at all — it goes through `--body-file`. A remote base
/// picked as `origin/main` is opened against `main`; a title is one line.
pub fn pr_create_command(base: &str, head: &str, title: &str, body_file: &str, draft: bool) -> String {
    let base = base.strip_prefix("origin/").unwrap_or(base);
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut cmd = format!(
        "gh pr create --base {} --head {} --title {} --body-file {}",
        shell_quote(base),
        shell_quote(head),
        shell_quote(&title),
        shell_quote(body_file),
    );
    if draft {
        cmd.push_str(" --draft");
    }
    cmd
}

/// Read the new PR's URL from `gh pr create`'s stdout (its last URL line,
/// `https://github.com/<o>/<r>/pull/<n>`). `None` when no such line exists.
pub fn pr_from_create_output(stdout: &str, title: &str, draft: bool) -> Option<Pr> {
    let url = stdout
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| l.starts_with("https://") && l.contains("/pull/"))?;
    let number = url.rsplit("/pull/").next()?.trim_end_matches('/').parse::<u64>().ok()?;
    Some(Pr {
        number,
        title: title.split_whitespace().collect::<Vec<_>>().join(" "),
        url: url.to_string(),
        is_draft: draft,
        state: if draft { PrState::Draft } else { PrState::Open },
    })
}

/// Readiness preflight for the "Ship it" flow — the `pull_request` stage
/// needs BOTH a github.com remote and an authenticated `gh`; failing that
/// mid-run (after the crew already built) is a terrible way to find out.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipReadiness {
    pub github_remote: bool,
    pub gh_authenticated: bool,
}
