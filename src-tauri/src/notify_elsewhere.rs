//! Notify me elsewhere (#964): an opt-in webhook for the moments a crew needs
//! the director while they are away from the Mac.
//!
//! **Off by default.** Once the user saves a URL and turns it on (Settings ›
//! General › Attention), Octopush POSTs one small JSON body to that URL when
//! a crew waits at a checkpoint gate, a stage asks the director a question, a
//! Claude plan limit holds a crew for the director, a crew run fails, or a
//! Routine's run finishes or fails. The body is built by [`payload`] alone and
//! carries exactly five keys: `text` and `content` (the same string, for
//! Slack-style and Discord-style incoming webhooks), `mission`, `project` and
//! `event`. The text is a fixed label plus the mission's title (the start of
//! its task; a Routine's name for a Routine's run) and the project's name.
//! Never code, diffs, the crew's questions, agent output, file paths or a
//! repository URL.
//!
//! Delivery is at least once: a retry after a timeout can deliver a message
//! twice if the first attempt did arrive.
//!
//! The rules the sender keeps:
//! - the URL is `https`, or `http` only to this Mac (`localhost`, `127.0.0.1`,
//!   `[::1]`) so a local receiver can be tested ([`validate_url`]); it is
//!   never logged, because webhook URLs carry their secret in the path;
//! - a send never blocks a run: it is spawned, gives up after
//!   [`REQUEST_TIMEOUT`], is retried at most once (a network error, a timeout,
//!   429 or 5xx), and follows no redirect;
//! - the setting is read fresh before every attempt, so turning it off stops
//!   even a pending retry;
//! - a failure is one quiet journal line on the run (the orchestrator's
//!   `on_failure`), never a run failure.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// How long connecting to the webhook may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// How long one attempt may take in all (connect, send, answer).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// The pause before the one retry.
pub const RETRY_DELAY: Duration = Duration::from_secs(2);
/// How long the detached worker waits for in-flight sends before it exits:
/// two attempts and the pause between them, with room to spare.
pub const FLUSH_MAX: Duration = Duration::from_secs(15);
/// Longest URL accepted.
pub const URL_MAX_LEN: usize = 2048;
/// A mission or project name is cut to this many characters, so the whole
/// body stays under [`BODY_MAX_BYTES`] whatever the names hold.
pub const NAME_MAX_CHARS: usize = 80;
/// The most a body can weigh: three names of 80 four-byte characters, twice
/// in the text, fit with room to spare.
pub const BODY_MAX_BYTES: usize = 4096;
/// The names in the Settings preview and in the test message.
pub const SAMPLE_MISSION: &str = "Example mission";
pub const SAMPLE_PROJECT: &str = "Example project";

/// What happened. Each one has a fixed `event` token and a fixed label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// A stage parked at a checkpoint gate (a gate, a review loop at its
    /// decision, a budget park, a secret-guard hold).
    CheckpointGate,
    /// A stage asked the director a question (`ask_director`).
    DirectorQuestion,
    /// A Claude plan limit stopped a stage and the run now waits for the
    /// director (no automatic resume, or it ran out). A park that resumes
    /// on its own sends nothing.
    PlanLimit,
    /// A stage failed and halted a crew run.
    RunFailed,
    /// A Routine's run completed.
    RoutineFinished,
    /// A Routine's run failed.
    RoutineFailed,
    /// Settings › "Send a test".
    Test,
}

impl Event {
    pub const ALL: [Event; 7] = [
        Event::CheckpointGate,
        Event::DirectorQuestion,
        Event::PlanLimit,
        Event::RunFailed,
        Event::RoutineFinished,
        Event::RoutineFailed,
        Event::Test,
    ];

    /// The `event` value in the body.
    pub fn token(self) -> &'static str {
        match self {
            Event::CheckpointGate => "checkpoint_gate",
            Event::DirectorQuestion => "director_question",
            Event::PlanLimit => "plan_limit",
            Event::RunFailed => "run_failed",
            Event::RoutineFinished => "routine_finished",
            Event::RoutineFailed => "routine_failed",
            Event::Test => "test",
        }
    }

    /// The fixed label the text starts with.
    pub fn label(self) -> &'static str {
        match self {
            Event::CheckpointGate => "Checkpoint gate waiting",
            Event::DirectorQuestion => "Question waiting for you",
            Event::PlanLimit => "Claude plan limit, waiting for you",
            Event::RunFailed => "Crew run failed",
            Event::RoutineFinished => "Routine finished",
            Event::RoutineFailed => "Routine failed",
            Event::Test => "Test message",
        }
    }
}

/// The one body Octopush sends. Exactly these five keys, in this order.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Payload {
    pub text: String,
    pub content: String,
    pub mission: String,
    pub project: String,
    pub event: &'static str,
}

/// Build the body for `event` (pure). Names are cleaned by [`clean_name`];
/// an empty one is left out of the text and sent as `""`.
pub fn payload(event: Event, mission: &str, project: &str) -> Payload {
    let mission = clean_name(mission);
    let project = clean_name(project);
    let mut parts = vec!["Octopush", event.label()];
    if !mission.is_empty() {
        parts.push(&mission);
    }
    if !project.is_empty() {
        parts.push(&project);
    }
    let text = parts.join(" · ");
    Payload { content: text.clone(), text, mission, project, event: event.token() }
}

/// A name as it goes into the body: bidi controls and zero-width characters
/// dropped (a name can't reorder or hide what the receiver shows), other
/// control characters dropped, whitespace (newlines included) collapsed to
/// single spaces, `<` `>` `@` `[` `]` swapped for look-alikes so a name can
/// never mention a whole channel (Slack's `<!channel>`, Discord's
/// `@everyone`) or turn into a Markdown link, and cut to [`NAME_MAX_CHARS`].
pub fn clean_name(raw: &str) -> String {
    let visible: String = raw
        .chars()
        .filter(|&c| !is_invisible(c) && (!c.is_control() || c.is_whitespace()))
        .collect();
    let collapsed = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = collapsed
        .chars()
        .map(|c| match c {
            '<' => '‹',
            '>' => '›',
            '@' => '＠',
            '[' => '［',
            ']' => '］',
            other => other,
        })
        .collect();
    if cleaned.chars().count() <= NAME_MAX_CHARS {
        return cleaned;
    }
    let mut cut: String = cleaned.chars().take(NAME_MAX_CHARS - 1).collect();
    cut.push('…');
    cut
}

/// Check a webhook URL the user typed. `https` anywhere; `http` only to this
/// Mac (`localhost`, `127.0.0.1`, `[::1]`), for a local test receiver. No
/// user name or password in the URL. The messages are shown in Settings.
pub fn validate_url(raw: &str) -> Result<reqwest::Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Add a webhook URL first.".into());
    }
    if raw.len() > URL_MAX_LEN {
        return Err("That URL is too long for a webhook.".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "That isn't a valid URL.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the user name and password out of the URL.".into());
    }
    let host = url.host_str().unwrap_or("");
    if host.is_empty() {
        return Err("That isn't a valid URL.".into());
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_this_mac(host) => Ok(url),
        "http" => Err("Use an https:// URL. Plain http:// works only to this Mac (localhost or 127.0.0.1).".into()),
        _ => Err("Use an https:// URL.".into()),
    }
}

/// Bidi embedding, override and isolate controls, the Arabic letter mark,
/// zero-width characters and the byte-order mark.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200B}'..='\u{200F}' | '\u{2060}' | '\u{FEFF}' | '\u{061C}'
    )
}

fn is_this_mac(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// The saved state, as Settings shows it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotifySettings {
    pub enabled: bool,
    pub url: String,
}

/// The saved state (any read failure reads as off, with no URL).
pub fn current() -> NotifySettings {
    let s = crate::settings::load_settings().unwrap_or_default();
    NotifySettings { enabled: s.notify_elsewhere_enabled, url: s.notify_elsewhere_url.unwrap_or_default() }
}

/// Save the setting (the only writer of `notifyElsewhereEnabled` /
/// `notifyElsewhereUrl`). An invalid URL is never stored; an empty one clears
/// it and turns the setting off; turning on needs a URL.
pub fn save(enabled: bool, url: &str) -> AppResult<NotifySettings> {
    let url = url.trim();
    let stored = if url.is_empty() {
        None
    } else {
        validate_url(url).map_err(AppError::Other)?;
        Some(url.to_string())
    };
    if enabled && stored.is_none() {
        return Err(AppError::Other("Add a webhook URL first.".into()));
    }
    let enabled = enabled && stored.is_some();
    crate::settings::set_notify_elsewhere(enabled, stored.clone())?;
    Ok(NotifySettings { enabled, url: stored.unwrap_or_default() })
}

/// The URL to send to: `Some` only while the setting is on and the saved URL
/// is valid. Read fresh from `settings.json` on every call, so the detached
/// worker sees the same answer and a switch turned off applies at once.
pub fn configured_url() -> Option<reqwest::Url> {
    // Tests never read the developer's real settings (and never post to
    // their webhook): only a test that points the settings at a temp file
    // gets an answer.
    #[cfg(test)]
    crate::settings::test_settings_path::get()?;
    let s = crate::settings::load_settings().ok()?;
    if !s.notify_elsewhere_enabled {
        return None;
    }
    validate_url(s.notify_elsewhere_url.as_deref()?).ok()
}

/// Why a send didn't go through. [`SendError::describe`] never contains the
/// URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendError {
    /// The setting was turned off (or the URL changed) before the attempt.
    Off,
    Timeout,
    Connect,
    /// The webhook answered with a redirect, which is not followed.
    Redirect(u16),
    Status(u16),
    /// Any other request error.
    Request,
    /// No HTTP client could be built.
    NoClient,
}

impl SendError {
    fn retryable(&self) -> bool {
        match self {
            SendError::Timeout | SendError::Connect | SendError::Request => true,
            SendError::Status(code) => *code == 429 || *code >= 500,
            _ => false,
        }
    }

    /// One plain clause for the journal line and the test result.
    pub fn describe(&self) -> String {
        match self {
            SendError::Off => "Notify me elsewhere is off".into(),
            SendError::Timeout => format!("the webhook didn't answer within {} seconds", REQUEST_TIMEOUT.as_secs()),
            SendError::Connect => "couldn't connect to the webhook".into(),
            SendError::Redirect(code) => format!("the webhook answered with a redirect (HTTP {code}), which Octopush doesn't follow"),
            SendError::Status(code) => format!("the webhook answered HTTP {code}"),
            SendError::Request => "the request couldn't be sent".into(),
            SendError::NoClient => "Octopush couldn't set up the request".into(),
        }
    }
}

fn classify(e: &reqwest::Error) -> SendError {
    if e.is_timeout() {
        SendError::Timeout
    } else if e.is_connect() {
        SendError::Connect
    } else {
        SendError::Request
    }
}

/// The webhook client: short timeouts and no redirects, on the same hardened
/// TLS stack as every other Octopush client. `None` only if no client could be
/// built at all.
fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let tune = |b: reqwest::ClientBuilder| {
                b.connect_timeout(CONNECT_TIMEOUT)
                    .timeout(REQUEST_TIMEOUT)
                    .redirect(reqwest::redirect::Policy::none())
                    .user_agent("Octopush")
            };
            tune(crate::tls::client_builder())
                .build()
                .or_else(|_| tune(reqwest::Client::builder()).build())
                .ok()
        })
        .as_ref()
}

async fn post_once(client: &reqwest::Client, url: &reqwest::Url, body: &Payload) -> Result<(), SendError> {
    let resp = client.post(url.clone()).json(body).send().await.map_err(|e| classify(&e))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else if status.is_redirection() {
        Err(SendError::Redirect(status.as_u16()))
    } else {
        Err(SendError::Status(status.as_u16()))
    }
}

/// POST `body` to `url`. With `retry`, a retryable failure is tried once more
/// after that pause. `still_on` is asked before each attempt: `false` stops
/// with [`SendError::Off`].
pub async fn send_with(
    client: &reqwest::Client,
    url: &reqwest::Url,
    body: &Payload,
    retry: Option<Duration>,
    still_on: impl Fn() -> bool,
) -> Result<(), SendError> {
    if !still_on() {
        return Err(SendError::Off);
    }
    match post_once(client, url, body).await {
        Err(e) if e.retryable() && retry.is_some() => {
            tokio::time::sleep(retry.unwrap_or_default()).await;
            if !still_on() {
                return Err(SendError::Off);
            }
            post_once(client, url, body).await
        }
        other => other,
    }
}

/// Settings › "Send a test": the test body to the URL in the field (saved or
/// not), once, with no retry, whether or not the setting is on. The user
/// pressed the button, so this is the one send that needs no switch.
pub async fn send_test(url: &str) -> Result<(), String> {
    let url = validate_url(url)?;
    let client = client().ok_or_else(|| SendError::NoClient.describe())?;
    send_with(client, &url, &payload(Event::Test, SAMPLE_MISSION, SAMPLE_PROJECT), None, || true)
        .await
        .map_err(|e| e.describe())
}

/// One event in the Settings preview.
#[derive(Serialize, Clone, Debug)]
pub struct EventInfo {
    pub event: &'static str,
    pub label: &'static str,
}

/// The read-only preview in Settings: the body's fields for a checkpoint gate
/// (sample names), and every `event` value with its label.
#[derive(Serialize, Clone, Debug)]
pub struct Preview {
    pub payload: Payload,
    pub events: Vec<EventInfo>,
}

pub fn preview() -> Preview {
    Preview {
        payload: payload(Event::CheckpointGate, SAMPLE_MISSION, SAMPLE_PROJECT),
        events: Event::ALL.iter().map(|e| EventInfo { event: e.token(), label: e.label() }).collect(),
    }
}

/// Sends spawned and not finished yet (see [`flush`]).
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Counts one send in flight until dropped, however the send ends.
struct InFlight;

impl InFlight {
    fn start() -> Self {
        IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        InFlight
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Fire and forget: send `body` in the background if the setting is on. A
/// failure (other than the setting going off) calls `on_failure` with
/// [`SendError::describe`]'s clause. Returns `false` when nothing was sent
/// because the setting is off.
pub fn dispatch<F>(body: Payload, on_failure: F) -> bool
where
    F: FnOnce(String) + Send + 'static,
{
    let Some(url) = configured_url() else { return false };
    let guard = InFlight::start();
    spawn(async move {
        let _guard = guard;
        let Some(client) = client() else {
            on_failure(SendError::NoClient.describe());
            return;
        };
        let still_on = || configured_url().as_ref() == Some(&url);
        match send_with(client, &url, &body, Some(RETRY_DELAY), still_on).await {
            Ok(()) | Err(SendError::Off) => {}
            Err(e) => {
                // The kind and the cause only: the URL holds the secret.
                tracing::warn!(kind = body.event, "notify elsewhere: {}", e.describe());
                on_failure(e.describe());
            }
        }
    });
    true
}

/// Run `fut` on the current Tokio runtime, or on a small one of its own when
/// called from outside any runtime.
fn spawn<F>(fut: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(fut);
        }
        Err(_) => {
            std::thread::spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    rt.block_on(fut);
                }
            });
        }
    }
}

/// Wait (at most `max`) until every dispatched send has finished. The
/// detached worker calls this before it exits, so a park it announced with
/// the app closed still reaches the webhook.
pub async fn flush(max: Duration) {
    let deadline = tokio::time::Instant::now() + max;
    while IN_FLIGHT.load(Ordering::SeqCst) > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::test_receiver::{serve, Answer};
    use super::*;
    use std::sync::Arc;

    #[test]
    fn the_body_has_exactly_the_five_keys() {
        let body = serde_json::to_value(payload(Event::CheckpointGate, "Add dark mode", "acme-web")).unwrap();
        let mut keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["content", "event", "mission", "project", "text"]);
        assert_eq!(
            body,
            serde_json::json!({
                "text": "Octopush · Checkpoint gate waiting · Add dark mode · acme-web",
                "content": "Octopush · Checkpoint gate waiting · Add dark mode · acme-web",
                "mission": "Add dark mode",
                "project": "acme-web",
                "event": "checkpoint_gate",
            })
        );
        // The wire order is the documented one.
        let wire = serde_json::to_string(&payload(Event::Test, "m", "p")).unwrap();
        let at = |k: &str| wire.find(&format!("\"{k}\"")).unwrap();
        assert!(at("text") < at("content") && at("content") < at("mission"));
        assert!(at("mission") < at("project") && at("project") < at("event"));
    }

    #[test]
    fn every_event_has_its_fixed_token_and_label() {
        let tokens: Vec<&str> = Event::ALL.iter().map(|e| e.token()).collect();
        assert_eq!(
            tokens,
            [
                "checkpoint_gate",
                "director_question",
                "plan_limit",
                "run_failed",
                "routine_finished",
                "routine_failed",
                "test"
            ]
        );
        for e in Event::ALL {
            let body = payload(e, "M", "P");
            assert_eq!(body.event, e.token());
            assert_eq!(body.text, format!("Octopush · {} · M · P", e.label()));
            assert_eq!(body.text, body.content, "text and content are the same string");
        }
        assert_eq!(Event::DirectorQuestion.label(), "Question waiting for you");
        assert_eq!(Event::RoutineFailed.label(), "Routine failed");
        assert_eq!(Event::PlanLimit.label(), "Claude plan limit, waiting for you");
    }

    #[test]
    fn names_are_cleaned_capped_and_left_out_when_empty() {
        let body = payload(Event::RunFailed, "  Fix\nthe\tlogin  ", "");
        assert_eq!(body.mission, "Fix the login");
        assert_eq!(body.project, "");
        assert_eq!(body.text, "Octopush · Crew run failed · Fix the login");
        assert_eq!(payload(Event::RunFailed, "", "").text, "Octopush · Crew run failed");
        // No channel-wide mention can ride on a name.
        let loud = payload(Event::CheckpointGate, "<!channel> @everyone", "p");
        assert!(!loud.text.contains('<') && !loud.text.contains('@'), "{}", loud.text);
        let long = "x".repeat(500);
        let cut = clean_name(&long);
        assert_eq!(cut.chars().count(), NAME_MAX_CHARS);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn names_keep_their_letters_and_lose_invisible_and_markup_characters() {
        // Non-ASCII names pass through as written.
        for name in ["Añadir modo oscuro", "ダークモードを追加", "Dark mode 🌙", "Ünïcødé · ok"] {
            assert_eq!(clean_name(name), name);
        }
        // Bidi controls, zero-width characters and the BOM are dropped, so a
        // name can't reorder or hide what the receiver shows.
        assert_eq!(clean_name("abc\u{202E}fed\u{202C}"), "abcfed");
        assert_eq!(clean_name("pay\u{2066}lo\u{2069}ad"), "payload");
        assert_eq!(clean_name("a\u{200B}b\u{200C}c\u{200D}d\u{200E}e\u{200F}f"), "abcdef");
        assert_eq!(clean_name("\u{FEFF}start\u{061C}"), "start");
        assert_eq!(clean_name("a \u{200B} b"), "a b", "collapsed after the strip");
        // No Markdown link can ride on a name.
        let linked = clean_name("[Open](https://example.com)");
        assert!(!linked.contains('[') && !linked.contains(']'), "{linked}");
        assert_eq!(linked, "［Open］(https://example.com)");
    }

    #[test]
    fn the_body_stays_under_its_bound_for_the_worst_names() {
        // 80 four-byte characters per name is the heaviest a name can be;
        // quotes and backslashes are escaped to two bytes, lighter still.
        for worst in ["🌙".repeat(500), "\"".repeat(500), "\\".repeat(500), "ダ".repeat(500)] {
            for e in Event::ALL {
                let wire = serde_json::to_string(&payload(e, &worst, &worst)).unwrap();
                assert!(wire.len() < BODY_MAX_BYTES, "{} bytes for {:?}", wire.len(), e);
            }
        }
        // An ordinary body is a few hundred bytes.
        let usual = serde_json::to_string(&payload(Event::CheckpointGate, "Add dark mode", "acme-web")).unwrap();
        assert!(usual.len() < 512, "{} bytes", usual.len());
    }

    #[test]
    fn urls_are_https_or_plain_http_to_this_mac_only() {
        for ok in [
            "https://ntfy.sh/my-topic",
            "https://hooks.slack.com/services/T0/B0/xyz",
            "https://discord.com/api/webhooks/1/abc",
            "  https://example.com/hook  ",
            "http://localhost:8080/hook",
            "http://127.0.0.1:9000/",
            "http://[::1]:9000/x",
        ] {
            assert!(validate_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "   ",
            "not a url",
            "ftp://example.com/x",
            "file:///etc/passwd",
            "http://example.com/hook",
            "http://192.168.1.10/hook",
            "http://127.0.0.2/hook",
            "http://localhost.example.com/hook",
            "https://user:secret@example.com/hook",
            "https://user@example.com/hook",
        ] {
            assert!(validate_url(bad).is_err(), "{bad}");
        }
        let long = format!("https://example.com/{}", "a".repeat(URL_MAX_LEN));
        assert!(validate_url(&long).is_err());
        assert!(validate_url("http://example.com").unwrap_err().contains("https://"));
    }

    #[test]
    fn saving_validates_and_never_stores_a_bad_url() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        crate::settings::test_settings_path::set(Some(path.clone()));
        assert_eq!(current(), NotifySettings { enabled: false, url: String::new() }, "off by default");
        assert!(configured_url().is_none());

        assert!(save(true, "").is_err(), "on needs a URL");
        assert!(save(true, "http://example.com/x").is_err());
        assert!(!path.exists() || current().url.is_empty(), "nothing stored");

        let saved = save(false, " https://ntfy.sh/t ").unwrap();
        assert_eq!(saved, NotifySettings { enabled: false, url: "https://ntfy.sh/t".into() });
        assert!(configured_url().is_none(), "saved but off");
        save(true, "https://ntfy.sh/t").unwrap();
        assert_eq!(configured_url().map(|u| u.to_string()).as_deref(), Some("https://ntfy.sh/t"));

        // A bad URL leaves the saved one alone.
        assert!(save(true, "ftp://x").is_err());
        assert_eq!(current().url, "https://ntfy.sh/t");
        // Off applies at once; clearing the URL turns it off too.
        save(false, "https://ntfy.sh/t").unwrap();
        assert!(configured_url().is_none());
        save(true, "https://ntfy.sh/t").unwrap();
        assert_eq!(save(false, "").unwrap(), NotifySettings { enabled: false, url: String::new() });
        assert!(configured_url().is_none());
        crate::settings::test_settings_path::set(None);
    }

    #[test]
    fn the_preview_is_the_real_body_and_lists_every_event() {
        let p = preview();
        assert_eq!(p.payload, payload(Event::CheckpointGate, SAMPLE_MISSION, SAMPLE_PROJECT));
        let events: Vec<&str> = p.events.iter().map(|e| e.event).collect();
        let all: Vec<&str> = Event::ALL.iter().map(|e| e.token()).collect();
        assert_eq!(events, all);
    }

    #[test]
    fn errors_never_carry_the_url() {
        for e in [
            SendError::Off,
            SendError::Timeout,
            SendError::Connect,
            SendError::Redirect(302),
            SendError::Status(404),
            SendError::Request,
            SendError::NoClient,
        ] {
            let d = e.describe();
            assert!(!d.contains("http"), "{d}");
        }
        assert!(SendError::Status(503).retryable());
        assert!(SendError::Status(429).retryable());
        assert!(!SendError::Status(404).retryable());
        assert!(!SendError::Redirect(301).retryable());
    }

    // ── Against a local HTTP server ─────────────────────────────────────

    fn quick_client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(Duration::from_millis(400))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    fn body() -> Payload {
        payload(Event::DirectorQuestion, "Add dark mode", "acme-web")
    }

    #[tokio::test]
    async fn a_send_posts_the_exact_json() {
        let (url, seen) = serve(Answer::Status(200)).await;
        let url = validate_url(&url).unwrap();
        send_with(&quick_client(), &url, &body(), Some(Duration::from_millis(10)), || true).await.unwrap();
        let seen = seen.lock().clone();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].head.starts_with("POST /hook "), "{}", seen[0].head);
        assert!(
            seen[0].head.lines().any(|l| l.eq_ignore_ascii_case("content-type: application/json")),
            "{}",
            seen[0].head
        );
        let got: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
        assert_eq!(got, serde_json::to_value(body()).unwrap());
    }

    #[tokio::test]
    async fn a_timeout_is_retried_once_and_then_given_up() {
        let (url, seen) = serve(Answer::Hang).await;
        let url = validate_url(&url).unwrap();
        let started = std::time::Instant::now();
        let err = send_with(&quick_client(), &url, &body(), Some(Duration::from_millis(10)), || true)
            .await
            .unwrap_err();
        assert_eq!(err, SendError::Timeout);
        assert_eq!(seen.lock().len(), 2, "one attempt and one retry, no more");
        assert!(started.elapsed() < Duration::from_secs(5), "bounded by the timeouts");
    }

    #[tokio::test]
    async fn server_errors_retry_once_and_client_errors_not_at_all() {
        let (url, seen) = serve(Answer::Status(503)).await;
        let url = validate_url(&url).unwrap();
        let err = send_with(&quick_client(), &url, &body(), Some(Duration::from_millis(10)), || true)
            .await
            .unwrap_err();
        assert_eq!(err, SendError::Status(503));
        assert_eq!(seen.lock().len(), 2);

        let (url, seen) = serve(Answer::Status(404)).await;
        let url = validate_url(&url).unwrap();
        let err = send_with(&quick_client(), &url, &body(), Some(Duration::from_millis(10)), || true)
            .await
            .unwrap_err();
        assert_eq!(err, SendError::Status(404));
        assert_eq!(seen.lock().len(), 1);

        // The test button never retries.
        let (url, seen) = serve(Answer::Status(503)).await;
        let url = validate_url(&url).unwrap();
        assert!(send_with(&quick_client(), &url, &body(), None, || true).await.is_err());
        assert_eq!(seen.lock().len(), 1);
    }

    #[tokio::test]
    async fn a_redirect_is_never_followed() {
        let (elsewhere, elsewhere_seen) = serve(Answer::Status(200)).await;
        let (url, seen) = serve(Answer::Redirect(elsewhere)).await;
        let url = validate_url(&url).unwrap();
        // The production client: its redirect policy is what's under test.
        let err = send_with(client().unwrap(), &url, &body(), Some(Duration::from_millis(10)), || true)
            .await
            .unwrap_err();
        assert_eq!(err, SendError::Redirect(302));
        assert_eq!(seen.lock().len(), 1, "a redirect is not retried");
        assert!(elsewhere_seen.lock().is_empty(), "the other host never hears from us");
    }

    #[tokio::test]
    async fn turning_it_off_stops_a_pending_retry() {
        let (url, seen) = serve(Answer::Status(500)).await;
        let url = validate_url(&url).unwrap();
        let asked = std::sync::atomic::AtomicUsize::new(0);
        let still_on = || asked.fetch_add(1, Ordering::SeqCst) == 0;
        let err = send_with(&quick_client(), &url, &body(), Some(Duration::from_millis(10)), still_on)
            .await
            .unwrap_err();
        assert_eq!(err, SendError::Off);
        assert_eq!(seen.lock().len(), 1, "the retry never went out");
        // Off before the first attempt: nothing at all.
        let (url, seen) = serve(Answer::Status(200)).await;
        let url = validate_url(&url).unwrap();
        assert_eq!(send_with(&quick_client(), &url, &body(), None, || false).await, Err(SendError::Off));
        assert!(seen.lock().is_empty());
    }

    #[tokio::test]
    async fn dispatch_reads_the_setting_and_flush_waits_for_the_send() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        crate::settings::test_settings_path::set(Some(path.clone()));
        let (url, seen) = serve(Answer::Status(200)).await;

        // Off (the default): nothing is spawned, nothing is sent.
        assert!(!dispatch(body(), |_| panic!("no send, no failure")));
        flush(Duration::from_millis(200)).await;
        assert!(seen.lock().is_empty());

        save(true, &url).unwrap();
        let failed = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
        let f = failed.clone();
        assert!(dispatch(body(), move |why| f.lock().push(why)));
        flush(FLUSH_MAX).await;
        assert_eq!(seen.lock().len(), 1);
        assert!(failed.lock().is_empty());
        crate::settings::test_settings_path::set(None);
    }

    #[tokio::test]
    async fn a_failed_dispatch_reports_once_without_the_url() {
        let dir = tempfile::tempdir().unwrap();
        crate::settings::test_settings_path::set(Some(dir.path().join("settings.json")));
        let (url, _seen) = serve(Answer::Status(404)).await;
        save(true, &url).unwrap();
        let failed = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
        let f = failed.clone();
        dispatch(body(), move |why| f.lock().push(why));
        flush(FLUSH_MAX).await;
        let failed = failed.lock().clone();
        assert_eq!(failed, vec!["the webhook answered HTTP 404".to_string()]);
        assert!(!failed[0].contains("127.0.0.1"));
        crate::settings::test_settings_path::set(None);
    }

    #[tokio::test]
    async fn the_test_button_sends_the_test_body_even_while_off() {
        let (url, seen) = serve(Answer::Status(204)).await;
        send_test(&url).await.unwrap();
        let seen = seen.lock().clone();
        assert_eq!(seen.len(), 1);
        let got: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
        assert_eq!(got["event"], "test");
        assert_eq!(got["text"], "Octopush · Test message · Example mission · Example project");
        assert!(send_test("http://example.com/hook").await.unwrap_err().contains("https://"));
    }
}

/// Tests: a webhook receiver on this Mac (also used by the orchestrator's
/// tests in `tests.rs`).
#[cfg(test)]
pub(crate) mod test_receiver {
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One request as the receiver read it: the head and the body.
    #[derive(Clone, Debug)]
    pub(crate) struct Seen {
        pub head: String,
        pub body: String,
    }

    /// How the receiver answers.
    #[derive(Clone)]
    pub(crate) enum Answer {
        Status(u16),
        Redirect(String),
        /// Read the request, then never answer.
        Hang,
    }

    pub(crate) async fn serve(answer: Answer) -> (String, Arc<parking_lot::Mutex<Vec<Seen>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let (log, answer) = (log.clone(), answer.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let (head, body) = loop {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        let Some(end) = text.find("\r\n\r\n") else { continue };
                        let head = text[..end].to_string();
                        let len = head
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                k.trim().eq_ignore_ascii_case("content-length").then(|| v.trim().parse::<usize>().ok())?
                            })
                            .unwrap_or(0);
                        if buf.len() >= end + 4 + len {
                            break (head, String::from_utf8_lossy(&buf[end + 4..end + 4 + len]).to_string());
                        }
                    };
                    log.lock().push(Seen { head, body });
                    let resp = match answer {
                        Answer::Hang => {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                            return;
                        }
                        Answer::Status(code) => {
                            format!("HTTP/1.1 {code} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        }
                        Answer::Redirect(to) => format!(
                            "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        ),
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (format!("http://{addr}/hook"), seen)
    }

    /// The bodies the receiver got, parsed.
    pub(crate) fn bodies(seen: &Arc<parking_lot::Mutex<Vec<Seen>>>) -> Vec<serde_json::Value> {
        seen.lock().iter().filter_map(|s| serde_json::from_str(&s.body).ok()).collect()
    }
}
