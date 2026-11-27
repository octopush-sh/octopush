//! Epiku adapter, read-only. Auth: `Authorization: Bearer <token>`.
//!
//! Every request names the configured project (`?proyecto=<id>`: without it
//! Epiku answers for its bundled default project) and carries nothing else
//! but the token and, where the call needs one, a story id (in the path) or
//! an epic id (`epica`). No code, diffs, prompts or agent output ever go to
//! Epiku, and Octopush never writes to it.
//!
//! The paths, bodies and error codes are Epiku's read API; its field names
//! are Spanish because they are that contract, not UI copy. Everything shown
//! to the user is English. Recorded synthetic responses (`sample-project`,
//! `ST-1.1`) live in `tests/fixtures/epiku/`.

use super::{Issue, IssueTracker, LinkedIssueRef, StatusCategory};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// How long one Epiku read may take.
const TIMEOUT: Duration = Duration::from_secs(20);

/// Stories have no type field; every Epiku ticket is a story.
const STORY: &str = "Story";

/// The answer was a success but not an Epiku body.
const NOT_EPIKU: &str = "That URL didn't answer like Epiku. Check the base URL.";

const INVALID_PROJECT: &str =
    "Epiku project ids are lowercase letters, digits and hyphens, 2 to 40 characters.";

/// What Settings keeps for Epiku in settings.json. The token isn't here: it
/// lives in the macOS Keychain.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpikuConfig {
    /// e.g. `https://epiku.example.com`
    pub base_url: String,
    /// The Epiku project id every request names.
    pub project: String,
}

/// A project id Epiku accepts: lowercase letters, digits and hyphens, 2–40
/// characters, starting and ending with a letter or a digit.
pub fn valid_project_id(id: &str) -> bool {
    let b = id.as_bytes();
    let edge = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    (2..=40).contains(&b.len())
        && edge(b[0])
        && edge(b[b.len() - 1])
        && b.iter().all(|&c| edge(c) || c == b'-')
}

/// The base URL without its trailing slashes, when Octopush may send the
/// token to it: `https://`, or `http://` to an Epiku on this Mac only.
pub fn normalized_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| "Enter the Epiku URL, starting with https://.".to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" if url.host_str().is_some() => {}
        "http" if local => {}
        _ => return Err("Use an https:// URL for Epiku (http:// only for one on this Mac).".into()),
    }
    if url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err("Enter the Epiku URL without a query, a fragment or credentials.".into());
    }
    Ok(trimmed.to_string())
}

/// An Epiku `estado` as the status the UI shows, and its category. The four
/// states are a closed set, so they show in English; any other value (the
/// state endpoint doesn't validate) is kept as it is, under `Unknown`.
/// `bloqueada` is set by hand on the board, apart from the dependency graph.
pub fn status_from_estado(estado: Option<&str>) -> (String, StatusCategory) {
    match estado {
        Some("backlog") => ("Backlog".into(), StatusCategory::Todo),
        Some("curso") => ("In progress".into(), StatusCategory::InProgress),
        Some("bloqueada") => ("Blocked".into(), StatusCategory::InProgress),
        Some("hecha") => ("Done".into(), StatusCategory::Done),
        Some(other) => (other.to_string(), StatusCategory::Unknown),
        None => (String::new(), StatusCategory::Unknown),
    }
}

/// `prioridad` (`alta` / `normal`) in English.
fn priority_name(prioridad: Option<&str>) -> Option<String> {
    match prioridad? {
        "" => None,
        "alta" => Some("High".into()),
        "normal" => Some("Normal".into()),
        other => Some(other.to_string()),
    }
}

/// A blocker's or dependent's `tipo` (`historia` / `epica` / `externo`).
fn type_name(tipo: Option<&str>) -> String {
    match tipo {
        Some("epica") => "Epic".into(),
        Some("externo") => "External".into(),
        _ => STORY.into(),
    }
}

/// The epic's id: the summary gives it as a string, one story as an object.
fn epic_id(v: &serde_json::Value) -> Option<String> {
    v.as_str()
        .or_else(|| v["id"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Resolved blockers or dependents (`bloqueantes`, `desbloquea` of one
/// story). The summary lists bare ids there, with no title or state to show,
/// so those are skipped, as Jira's list endpoints carry no links.
fn linked_refs(v: &serde_json::Value, board: &str) -> Vec<LinkedIssueRef> {
    let Some(arr) = v.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|r| {
            let key = r["id"].as_str()?.to_string();
            let (status_name, status_category) = status_from_estado(r["estado"].as_str());
            Some(LinkedIssueRef {
                key,
                summary: r["titulo"].as_str().unwrap_or("").to_string(),
                status_name,
                status_category,
                issue_type: type_name(r["tipo"].as_str()),
                url: board.to_string(),
            })
        })
        .collect()
}

/// One Epiku story (the full object, or a summary row) as an `Issue`. `board`
/// is where it opens: Epiku has no per-story page. `None` without an id.
pub fn issue_from_story(v: &serde_json::Value, board: &str) -> Option<Issue> {
    let key = v["id"].as_str()?.to_string();
    let (status_name, status_category) = status_from_estado(v["estado"].as_str());
    Some(Issue {
        key,
        summary: v["titulo"].as_str().unwrap_or("").to_string(),
        status_name,
        status_category,
        issue_type: STORY.to_string(),
        priority: priority_name(v["prioridad"].as_str()),
        url: board.to_string(),
        parent_key: epic_id(&v["epica"]),
        blocks: linked_refs(&v["desbloquea"], board),
        blocked_by: linked_refs(&v["bloqueantes"], board),
        ..Default::default()
    })
}

/// The stories of a list answer (`{ proyecto, total, historias }`) that
/// aren't done, in Epiku's plan order — like Jira's `statusCategory != Done`.
fn open_stories(v: &serde_json::Value, board: &str) -> AppResult<Vec<Issue>> {
    let arr = v["historias"].as_array().ok_or_else(|| AppError::Other(NOT_EPIKU.into()))?;
    Ok(arr
        .iter()
        .filter_map(|s| issue_from_story(s, board))
        .filter(|i| i.status_category != StatusCategory::Done)
        .collect())
}

/// The path of one story; the id is free-form, so it is percent-encoded.
fn story_path(id: &str) -> String {
    format!("/api/historias/{}", urlencoding::encode(id.trim()))
}

/// What a failed read means, in words the user can act on. Epiku checks a
/// request in this order: 401, then 400, then 404. A 404 without Epiku's
/// JSON `error` field is a URL that isn't Epiku, or an Epiku without the
/// route.
pub fn describe_failure(status: u16, body: &str) -> String {
    let code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string));
    match (status, code.as_deref()) {
        (401, _) => "Epiku rejected the token.".into(),
        (400, Some("proyecto_invalido")) => "Epiku says the project id is invalid.".into(),
        (404, Some("proyecto_no_encontrado")) => {
            "Project not found, or not readable with this token.".into()
        }
        (404, Some("no_encontrada")) => "That story isn't in the Epiku project.".into(),
        (404, None) => "This Epiku doesn't have that endpoint. Check the base URL.".into(),
        (s, _) => format!("Epiku answered HTTP {s}."),
    }
}

/// A read-only client for one Epiku project.
pub struct EpikuClient {
    base_url: String,
    project: String,
    token: String,
    http: reqwest::Client,
}

impl EpikuClient {
    /// A client for `cfg` and the token from the Keychain, or why that
    /// configuration can't be used. Nothing is sent yet.
    pub fn new(cfg: &EpikuConfig, token: &str) -> AppResult<Self> {
        let base_url = normalized_base_url(&cfg.base_url).map_err(AppError::Other)?;
        let project = cfg.project.trim();
        if !valid_project_id(project) {
            return Err(AppError::Other(INVALID_PROJECT.into()));
        }
        let token = token.trim();
        if token.is_empty() {
            return Err(AppError::Other("Add your Epiku token first.".into()));
        }
        Ok(Self {
            base_url,
            project: project.to_string(),
            token: token.to_string(),
            http: crate::tls::client(),
        })
    }

    /// Where every story link opens: the board on the project.
    pub fn board_url(&self) -> String {
        format!("{}/?proyecto={}", self.base_url, self.project)
    }

    /// `GET <base><path>?proyecto=<id>&<query>` with the bearer token.
    async fn get(&self, path: &str, query: &[(&str, &str)]) -> AppResult<serde_json::Value> {
        let mut params: Vec<(&str, &str)> = vec![("proyecto", self.project.as_str())];
        params.extend_from_slice(query);
        let request = self.http.get(format!("{}{}", self.base_url, path)).query(&params);
        let resp = request
            .bearer_auth(&self.token)
            .header("Accept", "application/json")
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|e| AppError::Other(format!("Couldn't reach Epiku: {}", crate::tls::describe_request_error(&e))))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.map_err(|e| AppError::Other(format!("Couldn't read Epiku's answer: {e}")))?;
        if !(200..300).contains(&status) {
            return Err(AppError::Other(describe_failure(status, &body)));
        }
        serde_json::from_str(&body).map_err(|_| AppError::Other(NOT_EPIKU.into()))
    }

    /// The Settings "Connected" gate: one read of the project's stories
    /// proves both the token and read access to the project. Returns how
    /// many stories the project has.
    pub async fn check_connection(&self) -> AppResult<usize> {
        let v = self.get("/api/historias", &[]).await?;
        v["historias"]
            .as_array()
            .map(Vec::len)
            .ok_or_else(|| AppError::Other(NOT_EPIKU.into()))
    }
}

impl IssueTracker for EpikuClient {
    /// The project's stories that aren't done. Epiku can't filter by
    /// assignee yet, so the picker searches all of them; `detalle=true`
    /// because the summary has neither the owner nor the resolved links.
    async fn list_my_issues(&self) -> AppResult<Vec<Issue>> {
        let v = self.get("/api/historias", &[("detalle", "true")]).await?;
        open_stories(&v, &self.board_url())
    }

    /// One story with its blockers, its dependents and its epic resolved.
    async fn get_issue(&self, key: &str) -> AppResult<Issue> {
        let v = self.get(&story_path(key), &[]).await?;
        issue_from_story(&v, &self.board_url()).ok_or_else(|| AppError::Other(NOT_EPIKU.into()))
    }

    /// The open stories of an epic. Epics are explicit in Epiku, not derived
    /// from the story id, so Epiku filters them (`epica`).
    async fn list_issues_in_epic(&self, epic_key: &str) -> AppResult<Vec<Issue>> {
        let v = self.get("/api/historias", &[("epica", epic_key)]).await?;
        open_stories(&v, &self.board_url())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const DETALLE: &str = include_str!("../../tests/fixtures/epiku/historias-detalle.json");
    const EPICA: &str = include_str!("../../tests/fixtures/epiku/historias-epica.json");
    const HISTORIA: &str = include_str!("../../tests/fixtures/epiku/historia.json");
    const NO_AUTORIZADO: &str = include_str!("../../tests/fixtures/epiku/error-no-autorizado.json");
    const PROYECTO_INVALIDO: &str = include_str!("../../tests/fixtures/epiku/error-proyecto-invalido.json");
    const PROYECTO_NO_ENCONTRADO: &str =
        include_str!("../../tests/fixtures/epiku/error-proyecto-no-encontrado.json");
    const NO_ENCONTRADA: &str = include_str!("../../tests/fixtures/epiku/error-no-encontrada.json");

    const TOKEN: &str = "epk_sample";

    type Seen = Arc<parking_lot::Mutex<Vec<String>>>;

    /// A recorded Epiku on this Mac. It answers each request target from
    /// `routes` (anything else: a bare 404 page, like a missing route) and
    /// keeps every request head it read.
    async fn serve(routes: Vec<(&'static str, u16, &'static str)>) -> (String, Seen) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let (log, routes) = (log.clone(), routes.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let head = loop {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            break text[..end].to_string();
                        }
                    };
                    let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    log.lock().push(head);
                    let (status, body) = routes
                        .iter()
                        .find(|(t, _, _)| *t == target)
                        .map(|(_, s, b)| (*s, *b))
                        .unwrap_or((404, "<html>Not Found</html>"));
                    let resp = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn client(base: &str) -> EpikuClient {
        let cfg = EpikuConfig { base_url: format!("{base}/"), project: "sample-project".into() };
        EpikuClient::new(&cfg, TOKEN).unwrap()
    }

    fn issue_keys(issues: &[Issue]) -> Vec<&str> {
        issues.iter().map(|i| i.key.as_str()).collect()
    }

    fn ref_keys(refs: &[LinkedIssueRef]) -> Vec<&str> {
        refs.iter().map(|r| r.key.as_str()).collect()
    }

    /// The one request sent: exactly `GET <target>`, the bearer token, and
    /// no other header that could carry anything (no body, no cookies).
    fn assert_sent_only(seen: &Seen, targets: &[&str]) {
        let heads = seen.lock().clone();
        assert_eq!(heads.len(), targets.len(), "{heads:?}");
        for (head, target) in heads.iter().zip(targets) {
            let mut lines = head.lines();
            assert_eq!(lines.next(), Some(format!("GET {target} HTTP/1.1").as_str()));
            let mut auth = None;
            for line in lines {
                let (name, value) = line.split_once(':').unwrap();
                let name = name.trim().to_ascii_lowercase();
                assert!(
                    ["host", "authorization", "accept", "accept-encoding", "user-agent", "connection"]
                        .contains(&name.as_str()),
                    "unexpected header {name}"
                );
                if name == "authorization" {
                    auth = Some(value.trim().to_string());
                }
            }
            assert_eq!(auth.as_deref(), Some("Bearer epk_sample"));
            assert!(!head.contains("asignado"), "no assignee filter until Epiku has one");
        }
    }

    #[tokio::test]
    async fn list_my_issues_reads_the_project_in_detail_and_drops_done_stories() {
        let target = "/api/historias?proyecto=sample-project&detalle=true";
        let (base, seen) = serve(vec![(target, 200, DETALLE)]).await;
        let issues = client(&base).list_my_issues().await.unwrap();
        assert_sent_only(&seen, &[target]);

        assert_eq!(issue_keys(&issues), ["ST-1.1", "ST-1.2", "ST-1.3"]);
        let board = format!("{base}/?proyecto=sample-project");
        let first = &issues[0];
        assert_eq!(first.summary, "Sample story title");
        assert_eq!((first.status_name.as_str(), first.status_category), ("Blocked", StatusCategory::InProgress));
        assert_eq!(first.issue_type, "Story");
        assert_eq!(first.priority.as_deref(), Some("High"));
        assert_eq!(first.parent_key.as_deref(), Some("EP-1"));
        assert_eq!(first.url, board);
        assert!(!first.subtask && first.hierarchy_level == 0 && first.subtasks.is_empty());
        assert_eq!(ref_keys(&first.blocked_by), ["ST-1.2", "EXT-1"]);
        assert_eq!(ref_keys(&first.blocks), ["ST-1.3"]);
        assert_eq!(issues[2].parent_key.as_deref(), Some("EP-2"));
        assert_eq!(issues[2].priority.as_deref(), Some("Normal"));
        assert_eq!(issues[2].status_category, StatusCategory::Todo);
    }

    #[tokio::test]
    async fn get_issue_reads_one_story_with_its_blockers_dependents_and_epic() {
        let target = "/api/historias/ST-1.1?proyecto=sample-project";
        let (base, seen) = serve(vec![(target, 200, HISTORIA)]).await;
        let issue = client(&base).get_issue("ST-1.1").await.unwrap();
        assert_sent_only(&seen, &[target]);

        let board = format!("{base}/?proyecto=sample-project");
        assert_eq!(issue.key, "ST-1.1");
        assert_eq!(issue.parent_key.as_deref(), Some("EP-1"));
        let blocker = &issue.blocked_by[0];
        assert_eq!(
            (blocker.summary.as_str(), blocker.status_name.as_str(), blocker.status_category, blocker.issue_type.as_str()),
            ("Sample blocking story", "In progress", StatusCategory::InProgress, "Story")
        );
        assert_eq!(blocker.url, board);
        // An external dependency has no state: nothing is invented for it.
        let external = &issue.blocked_by[1];
        assert_eq!(
            (external.issue_type.as_str(), external.status_name.as_str(), external.status_category),
            ("External", "", StatusCategory::Unknown)
        );
        let dependent = &issue.blocks[0];
        assert_eq!(
            (dependent.key.as_str(), dependent.status_name.as_str(), dependent.status_category),
            ("ST-1.3", "Backlog", StatusCategory::Todo)
        );
    }

    #[tokio::test]
    async fn list_issues_in_epic_asks_epiku_for_the_epic() {
        let target = "/api/historias?proyecto=sample-project&epica=EP-1";
        let (base, seen) = serve(vec![(target, 200, EPICA)]).await;
        let issues = client(&base).list_issues_in_epic("EP-1").await.unwrap();
        assert_sent_only(&seen, &[target]);

        assert_eq!(issue_keys(&issues), ["ST-1.1", "ST-1.2"]);
        assert!(issues.iter().all(|i| i.parent_key.as_deref() == Some("EP-1")));
        assert_eq!(issues[1].status_name, "In progress");
        // The summary lists links as bare ids: no row to show, so none.
        assert!(issues.iter().all(|i| i.blocks.is_empty() && i.blocked_by.is_empty()));
    }

    #[tokio::test]
    async fn check_connection_reads_the_project_once() {
        let target = "/api/historias?proyecto=sample-project";
        let (base, seen) = serve(vec![(target, 200, EPICA)]).await;
        assert_eq!(client(&base).check_connection().await.unwrap(), 2);
        assert_sent_only(&seen, &[target]);
    }

    #[tokio::test]
    async fn failures_say_what_went_wrong() {
        let list = "/api/historias?proyecto=sample-project";
        let (base, _) = serve(vec![(list, 401, NO_AUTORIZADO)]).await;
        let err = client(&base).check_connection().await.unwrap_err().to_string();
        assert!(err.contains("rejected the token"), "{err}");

        let (base, _) = serve(vec![(list, 404, PROYECTO_NO_ENCONTRADO)]).await;
        let err = client(&base).check_connection().await.unwrap_err().to_string();
        assert!(err.contains("not readable with this token"), "{err}");

        let story = "/api/historias/ST-9.9?proyecto=sample-project";
        let (base, _) = serve(vec![(story, 404, NO_ENCONTRADA)]).await;
        let err = client(&base).get_issue("ST-9.9").await.unwrap_err().to_string();
        assert!(err.contains("isn't in the Epiku project"), "{err}");

        // No route at all: a 404 that isn't Epiku JSON.
        let (base, _) = serve(vec![]).await;
        let err = client(&base).check_connection().await.unwrap_err().to_string();
        assert!(err.contains("doesn't have that endpoint"), "{err}");

        // A 200 that isn't Epiku.
        let (base, _) = serve(vec![(list, 200, "<html>hello</html>")]).await;
        let err = client(&base).check_connection().await.unwrap_err().to_string();
        assert!(err.contains("didn't answer like Epiku"), "{err}");
    }

    #[tokio::test]
    async fn an_unreachable_epiku_never_shows_the_token() {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let err = client(&format!("http://127.0.0.1:{port}")).check_connection().await.unwrap_err().to_string();
        assert!(err.contains("Couldn't reach Epiku"), "{err}");
        assert!(!err.contains(TOKEN), "{err}");
    }

    #[test]
    fn describes_each_recorded_error() {
        assert_eq!(describe_failure(401, NO_AUTORIZADO), "Epiku rejected the token.");
        assert_eq!(describe_failure(400, PROYECTO_INVALIDO), "Epiku says the project id is invalid.");
        assert_eq!(
            describe_failure(404, PROYECTO_NO_ENCONTRADO),
            "Project not found, or not readable with this token."
        );
        assert_eq!(describe_failure(404, NO_ENCONTRADA), "That story isn't in the Epiku project.");
        assert_eq!(describe_failure(404, "Not Found"), "This Epiku doesn't have that endpoint. Check the base URL.");
        assert_eq!(describe_failure(500, ""), "Epiku answered HTTP 500.");
    }

    #[test]
    fn maps_every_state_and_keeps_unknown_ones() {
        let cases = [
            (Some("backlog"), "Backlog", StatusCategory::Todo),
            (Some("curso"), "In progress", StatusCategory::InProgress),
            (Some("bloqueada"), "Blocked", StatusCategory::InProgress),
            (Some("hecha"), "Done", StatusCategory::Done),
            (Some("revision"), "revision", StatusCategory::Unknown),
            (None, "", StatusCategory::Unknown),
        ];
        for (estado, name, category) in cases {
            assert_eq!(status_from_estado(estado), (name.to_string(), category), "{estado:?}");
        }
    }

    #[test]
    fn percent_encodes_the_story_id() {
        assert_eq!(story_path("ST-1.1"), "/api/historias/ST-1.1");
        assert_eq!(story_path("ST 1/1"), "/api/historias/ST%201%2F1");
    }

    #[test]
    fn project_ids_follow_epikus_rule() {
        let (longest, too_long) = ("a".repeat(40), "a".repeat(41));
        for ok in ["sample-project", "ab", "a1", "x-2-y", longest.as_str()] {
            assert!(valid_project_id(ok), "{ok}");
        }
        for bad in ["", "a", "Bad_Id", "-ab", "ab-", "sample project", "Sample", too_long.as_str()] {
            assert!(!valid_project_id(bad), "{bad}");
        }
    }

    #[test]
    fn base_urls_are_https_or_this_mac() {
        assert_eq!(normalized_base_url(" https://epiku.example.com/ ").unwrap(), "https://epiku.example.com");
        assert_eq!(normalized_base_url("https://example.com/epiku").unwrap(), "https://example.com/epiku");
        assert_eq!(normalized_base_url("http://localhost:3000").unwrap(), "http://localhost:3000");
        assert_eq!(normalized_base_url("http://127.0.0.1:3000/").unwrap(), "http://127.0.0.1:3000");
        for bad in [
            "",
            "epiku.example.com",
            "http://epiku.example.com",
            "ftp://epiku.example.com",
            "https://epiku.example.com/?proyecto=x",
            "https://user:pw@epiku.example.com",
        ] {
            assert!(normalized_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_client_needs_a_valid_project_and_a_token_and_the_config_holds_no_token() {
        let cfg = |project: &str| EpikuConfig { base_url: "https://epiku.example.com".into(), project: project.into() };
        assert!(EpikuClient::new(&cfg("Bad_Id"), TOKEN).is_err());
        assert!(EpikuClient::new(&cfg("sample-project"), "  ").is_err());
        let board = EpikuClient::new(&cfg("sample-project"), TOKEN).unwrap().board_url();
        assert_eq!(board, "https://epiku.example.com/?proyecto=sample-project");
        let json = serde_json::to_value(cfg("sample-project")).unwrap();
        assert_eq!(json, serde_json::json!({ "baseUrl": "https://epiku.example.com", "project": "sample-project" }));
        assert_eq!(serde_json::from_value::<EpikuConfig>(json).unwrap(), cfg("sample-project"));
    }
}
