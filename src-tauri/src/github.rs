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
    /// The CI checks on the PR's head commit, for open and draft PRs. `None`
    /// when the PR has no checks or they couldn't be read (no `gh`, no token).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<PrChecks>,
}

/// The rolled-up state of a PR's CI checks: any failing check makes the PR
/// failing, else any unfinished one makes it pending.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChecksState {
    Passing,
    Pending,
    Failing,
}

/// One failing check: its name and, for a GitHub Actions check, the workflow
/// run id `gh run view <id> --log-failed` reads its log from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailingCheck {
    pub name: String,
    pub run_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrChecks {
    pub state: ChecksState,
    /// Failing checks in GitHub's order, one per name.
    pub failing: Vec<FailingCheck>,
}

/// How one check counts toward the rollup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckOutcome {
    Ok,
    Pending,
    Failed,
}

/// Classify a check-run (`status` + `conclusion`) or a commit status
/// (`state`), case-insensitively: `gh` says `COMPLETED`/`FAILURE`, REST says
/// `completed`/`failure`. Cancelled, neutral, skipped and stale don't fail a
/// PR (a cancelled run is usually one a newer push superseded).
fn check_outcome(status: Option<&str>, conclusion: Option<&str>, state: Option<&str>) -> CheckOutcome {
    if let Some(state) = state {
        return match state.to_ascii_lowercase().as_str() {
            "failure" | "error" => CheckOutcome::Failed,
            "pending" | "expected" => CheckOutcome::Pending,
            _ => CheckOutcome::Ok,
        };
    }
    let status = status.unwrap_or("completed").to_ascii_lowercase();
    if status != "completed" {
        return CheckOutcome::Pending;
    }
    match conclusion.unwrap_or("").to_ascii_lowercase().as_str() {
        "failure" | "timed_out" | "action_required" | "startup_failure" => CheckOutcome::Failed,
        _ => CheckOutcome::Ok,
    }
}

/// The workflow run id in a GitHub Actions URL
/// (`https://github.com/o/r/actions/runs/123/job/456` → 123).
pub fn actions_run_id(url: &str) -> Option<u64> {
    let rest = url.split("/actions/runs/").nth(1)?;
    rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// Roll up `(name, outcome, details url)` triples. `None` with no checks.
fn rollup(checks: impl Iterator<Item = (String, CheckOutcome, Option<String>)>) -> Option<PrChecks> {
    let mut any = false;
    let mut pending = false;
    let mut failing: Vec<FailingCheck> = Vec::new();
    for (name, outcome, url) in checks {
        any = true;
        match outcome {
            CheckOutcome::Ok => {}
            CheckOutcome::Pending => pending = true,
            CheckOutcome::Failed => {
                if !failing.iter().any(|f| f.name == name) {
                    failing.push(FailingCheck { name, run_id: url.as_deref().and_then(actions_run_id) });
                }
            }
        }
    }
    if !any {
        return None;
    }
    let state = if !failing.is_empty() {
        ChecksState::Failing
    } else if pending {
        ChecksState::Pending
    } else {
        ChecksState::Passing
    };
    Some(PrChecks { state, failing })
}

/// Parse `gh pr … --json statusCheckRollup`'s array, which mixes check runs
/// (`__typename: "CheckRun"`: `name`, `status`, `conclusion`, `detailsUrl`)
/// and commit statuses (`"StatusContext"`: `context`, `state`, `targetUrl`).
pub fn checks_from_gh_rollup(rollup_json: &serde_json::Value) -> Option<PrChecks> {
    let items = rollup_json.as_array()?;
    rollup(items.iter().map(|c| {
        let is_status = c["__typename"].as_str() == Some("StatusContext")
            || (c.get("context").is_some() && c.get("conclusion").is_none());
        if is_status {
            (
                c["context"].as_str().unwrap_or("status").to_string(),
                check_outcome(None, None, Some(c["state"].as_str().unwrap_or("pending"))),
                c["targetUrl"].as_str().map(str::to_string),
            )
        } else {
            (
                c["name"].as_str().unwrap_or("check").to_string(),
                check_outcome(c["status"].as_str(), c["conclusion"].as_str(), None),
                c["detailsUrl"].as_str().map(str::to_string),
            )
        }
    }))
}

/// Parse the REST `GET /repos/{o}/{r}/commits/{sha}/check-runs` body
/// (`{ "check_runs": [{ name, status, conclusion, details_url, html_url }] }`).
pub fn checks_from_rest_check_runs(body: &serde_json::Value) -> Option<PrChecks> {
    let runs = body["check_runs"].as_array()?;
    rollup(runs.iter().map(|c| {
        (
            c["name"].as_str().unwrap_or("check").to_string(),
            check_outcome(c["status"].as_str(), c["conclusion"].as_str(), None),
            c["details_url"].as_str().or_else(|| c["html_url"].as_str()).map(str::to_string),
        )
    }))
}

/// The most a "Fix failing checks" brief carries of the failed-step logs.
pub const FAILED_LOG_MAX_CHARS: usize = 8_000;

/// The last `max` chars of `s` (char-safe), whole when it already fits.
pub fn tail_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    s.chars().skip(count - max).collect()
}

/// Join each run's `gh run view --log-failed` output under a `run <id>`
/// header, splitting the budget evenly and keeping each log's TAIL (where the
/// failure is). Empty logs are left out.
pub fn join_failed_logs(logs: &[(u64, String)], max: usize) -> String {
    let logs: Vec<&(u64, String)> = logs.iter().filter(|(_, l)| !l.trim().is_empty()).collect();
    if logs.is_empty() {
        return String::new();
    }
    let per = max / logs.len();
    let parts: Vec<String> = logs
        .iter()
        .map(|(id, log)| format!("run {id}\n{}", tail_chars(log.trim_end(), per)))
        .collect();
    tail_chars(&parts.join("\n\n"), max)
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
        checks: None,
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

/// The login-shell command that opens a pull request, plus the environment
/// it reads its values from. No user value is ever spliced into the command:
/// base, head, title and body file travel as environment variables and the
/// command only says `"$VAR"`, which bash, zsh and fish all expand as one
/// argument (fish treats `\'` inside single quotes as an escape, so
/// single-quoting is not safe there). The body goes through `--body-file`.
/// `base` is the bare branch on the base repo (`git_ops::pr_target`), `repo`
/// that repo as `host/owner/repo` (`--repo`, so gh's own pick can't differ
/// from the draft's), `head` the branch or `owner:branch` on a fork. A title
/// is one line.
pub fn pr_create_command(
    repo: Option<&str>,
    base: &str,
    head: &str,
    title: &str,
    body_file: &str,
    draft: bool,
) -> (String, Vec<(&'static str, String)>) {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut cmd = String::from(
        "gh pr create --base \"$OCTOPUSH_PR_BASE\" --head \"$OCTOPUSH_PR_HEAD\" --title \"$OCTOPUSH_PR_TITLE\" --body-file \"$OCTOPUSH_PR_BODY_FILE\"",
    );
    let mut env = vec![
        ("OCTOPUSH_PR_BASE", base.to_string()),
        ("OCTOPUSH_PR_HEAD", head.to_string()),
        ("OCTOPUSH_PR_TITLE", title),
        ("OCTOPUSH_PR_BODY_FILE", body_file.to_string()),
    ];
    if let Some(repo) = repo {
        cmd.push_str(" --repo \"$OCTOPUSH_PR_REPO\"");
        env.push(("OCTOPUSH_PR_REPO", repo.to_string()));
    }
    if draft {
        cmd.push_str(" --draft");
    }
    (cmd, env)
}

/// `gh --repo` for a remote: `owner/repo` on github.com (its URL may say
/// `ssh.github.com:443`, which gh doesn't know as a host), else
/// `host/owner/repo` for GitHub Enterprise.
pub fn gh_repo_arg(host: &str, owner: &str, repo: &str) -> String {
    let host = host.split(':').next().unwrap_or(host);
    if host == "github.com" || host == "ssh.github.com" {
        format!("{owner}/{repo}")
    } else {
        format!("{host}/{owner}/{repo}")
    }
}

/// `gh pr create --head` for `branch` pushed to a repo owned by `head_owner`:
/// `owner:branch` when it differs from the base repo's owner (a fork — gh
/// can't find a bare branch name there), else the bare branch.
pub fn pr_head_label(branch: &str, head_owner: Option<&str>, base_owner: Option<&str>) -> String {
    match head_owner {
        Some(o) if !o.is_empty() && !base_owner.is_some_and(|b| b.eq_ignore_ascii_case(o)) => {
            format!("{o}:{branch}")
        }
        _ => branch.to_string(),
    }
}

/// Whether opening a PR from `head` onto `base` makes sense: never from a
/// branch onto itself (that would only push the base branch). `base` is the
/// bare branch, its remote already stripped (`git_ops::pr_target`).
pub fn pr_head_is_valid(base: &str, head: &str) -> bool {
    // A detached HEAD reports itself as "HEAD": not a branch to open from.
    !head.trim().is_empty() && head != "HEAD" && head != base
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
        checks: None,
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
