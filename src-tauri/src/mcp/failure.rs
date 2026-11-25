//! Why a server failed to connect, as Settings shows it: a short summary, a
//! hint when Octopush knows what to do about it, and the whole output behind a
//! "Details" disclosure.
//!
//! The input is the reason `McpRegistry::test_connect` returns: either one
//! line of Octopush's own (`spawn_plan`, the spawn itself, the smoke test's
//! timeout) or "MCP server closed the connection" followed by what the server
//! printed. Bridges such as `mcp-remote` prefix each stderr line with their
//! pid (`[12345] …`), so matching runs on lines with that prefix removed.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

/// A connection failure, classified for people.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct McpFailure {
    /// One short line: what went wrong.
    pub summary: String,
    /// What to do about it, when Octopush knows; `None` otherwise.
    pub hint: Option<String>,
    /// The whole reason and the server's output, redacted, line by line.
    pub detail: String,
}

impl std::fmt::Display for McpFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.summary)
    }
}

/// The most of a line that goes into a summary, in characters.
const SUMMARY_CAP: usize = 160;

/// mcp-remote's `[pid] ` prefix on every line it logs.
static PID_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\[\d+\]\s*)+").unwrap());
/// Leading error labels that add nothing to a summary.
static ERROR_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:fatal error|received error|connection error|uncaught exception|error)\s*:\s*)+").unwrap()
});

static DCR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)dynamic client registration|does not support dynamic (?:client )?registration").unwrap()
});
/// An HTTP 401/403 next to a word that says it is a status ("HTTP 401",
/// "HTTP/1.1 403", "status code (403)"), so a pid, a stack trace's `:401:`
/// or a URL's port doesn't count.
static AUTH_STATUS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bhttp(?:/\d(?:\.\d)?)?\s+40[13]\b|\b(?:status|code)\b[^0-9\n]{0,12}\b40[13]\b").unwrap()
});
static AUTH_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bunauthori[sz]ed\b|\bforbidden\b|\binvalid[_ ]token\b|\binvalid_client\b|\binvalid_grant\b|\b(?:token|credentials?) (?:is |are |was |were )?(?:invalid|expired|revoked)\b")
        .unwrap()
});
/// Octopush's own lookup failure (`spawn_plan`).
static NOT_ON_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Octopush couldn't find `([^`]+)` on (the [^(]+?) \(").unwrap());
/// The spawn itself (`McpRegistry::spawn`): `spawn /path: No such file…`.
static SPAWN_MISSING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^spawn (.+?): No such file or directory").unwrap());
/// Node (`spawn node ENOENT`), `/usr/bin/env` (`env: node: No such file…`)
/// or a shell (`sh: npx: command not found`, `zsh: command not found: npx`).
static CHILD_MISSING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\bspawn (\S+) ENOENT\b|\benv: ['‘"]?([^\s'’":]+)['’"]?:? No such file or directory|([^\s:]+): command not found(?:$|[^:])|command not found: (\S+)"#,
    )
    .unwrap()
});
/// A browser sign-in that wasn't finished in time.
static AUTH_TIMEOUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:authenticat|authoriz|sign[- ]?in)\w*\s+timed out\b").unwrap());
/// The OAuth callback port is taken (another sign-in still listening).
static PORT_IN_USE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bEADDRINUSE\b|callback port \d+ is already in use").unwrap());
/// The line a bridge logs when it gives up (mcp-remote's "Fatal error:").
static FATAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bfatal\b").unwrap());
static OUR_TIMEOUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^connection timed out after (\d+)s").unwrap());
static NET_TIMEOUT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bETIMEDOUT\b|\bUND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT\b|\btimed out\b|\bconnect timeout error\b").unwrap()
});
static REFUSED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bECONNREFUSED\b|\bconnection refused\b").unwrap());
static DNS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:ENOTFOUND|EAI_AGAIN)\b|\bgetaddrinfo\b|could not resolve host|nodename nor servname|name or service not known|failed to lookup address").unwrap()
});
static DNS_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:ENOTFOUND|EAI_AGAIN)\s+([A-Za-z0-9.-]+\.[A-Za-z]{2,})").unwrap());
/// A line that reads as the error rather than as progress.
static ERRORISH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:error|failed|failure|fatal|cannot|can't|couldn't|unable|denied|refused|invalid|exception|giving up)\b").unwrap()
});

/// The header line of a reason whose process exited mid-handshake.
const CLOSED: &str = "MCP server closed the connection";

/// Classify why a server failed to connect (see the module docs for the
/// input). Every line is redacted first (`redact_output_line`), the summary
/// and the details alike.
pub fn classify_failure(reason: &str) -> McpFailure {
    classify_failure_with(reason, &[])
}

/// [`classify_failure`], also redacting `known` values (the server's own
/// env, `known_secrets`).
pub fn classify_failure_with(reason: &str, known: &[crate::secret_scan::KnownSecret]) -> McpFailure {
    let raw: Vec<String> = reason.trim().lines().map(|l| super::redact_output_line(l, known)).collect();
    let detail = raw.join("\n");
    // The lines to match on: no pid prefix, trimmed, none empty.
    let lines: Vec<String> = raw
        .iter()
        .map(|l| PID_PREFIX.replace(l.trim(), "").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let text = lines.join("\n");
    let (summary, hint) = summarize(&lines, &text);
    McpFailure { summary, hint, detail }
}

/// The lines that say how it ended: from the first fatal line, else from
/// the last line that reads as an error, to the end. A bridge logs a 401
/// on its way into a browser sign-in, so an earlier error isn't the cause.
fn decisive(lines: &[String]) -> &[String] {
    if let Some(i) = lines.iter().position(|l| FATAL.is_match(l)) {
        return &lines[i..];
    }
    match lines.iter().rposition(|l| ERRORISH.is_match(l)) {
        Some(i) => &lines[i..],
        None => lines,
    }
}

fn summarize(lines: &[String], text: &str) -> (String, Option<String>) {
    let first = lines.first().map(String::as_str).unwrap_or("");
    let hint = |s: &str| Some(s.to_string());
    let ending = decisive(lines);
    let end = ending.join("\n");

    if DCR.is_match(text) {
        return (
            "This server doesn't support automatic sign-in.".into(),
            hint("Use a token, or the OAuth client ID its admins give you."),
        );
    }
    if let Some(c) = NOT_ON_PATH.captures(first) {
        return (
            format!("Octopush couldn't find `{}` on {}.", &c[1], c[2].trim()),
            hint(&format!("Use its full path (run `which {}` in Terminal).", base_name(&c[1]))),
        );
    }
    if let Some(c) = SPAWN_MISSING.captures(first) {
        return (
            format!("Octopush couldn't find `{}`.", &c[1]),
            hint(&format!("Check the command's path (run `which {}` in Terminal).", base_name(&c[1]))),
        );
    }
    if let Some(c) = CHILD_MISSING.captures(text) {
        let program = (1..=4).find_map(|i| c.get(i)).map_or("", |m| m.as_str());
        return (
            format!("The server couldn't start `{program}`."),
            hint(&format!(
                "Use its full path in Command, or set PATH in the server's env (run `which {}` in Terminal).",
                base_name(program)
            )),
        );
    }
    if let Some(c) = OUR_TIMEOUT.captures(first) {
        return (
            format!("The server didn't answer within {}s.", &c[1]),
            hint("If it signs in through a browser, finish signing in there, then test again."),
        );
    }
    if AUTH_TIMEOUT.is_match(text) {
        return (
            "Signing in timed out.".into(),
            hint("Finish signing in in the browser window that opened, then test again."),
        );
    }
    if PORT_IN_USE.is_match(text) {
        return (
            "The sign-in callback port is in use.".into(),
            hint("Another sign-in for this server may still be open in your browser; finish or close it, then test again."),
        );
    }
    if REFUSED.is_match(&end) {
        return (
            "The server refused the connection.".into(),
            hint("Check the URL and port, and that the server is running."),
        );
    }
    if DNS.is_match(&end) {
        let summary = match DNS_HOST.captures(&end) {
            Some(c) => format!("Octopush couldn't find the host {}.", &c[1]),
            None => "Octopush couldn't find the server's host.".into(),
        };
        return (summary, hint("Check the URL's host name and your network or VPN."));
    }
    if NET_TIMEOUT.is_match(&end) {
        return (
            "The connection to the server timed out.".into(),
            hint("Check the URL and your network or VPN, then test again."),
        );
    }
    if AUTH_STATUS.is_match(&end) || AUTH_WORDS.is_match(&end) {
        return (
            "The server rejected the credentials.".into(),
            hint("Check the token or headers it sends, or sign in again."),
        );
    }
    fallback(lines, ending)
}

/// A line with something to say once its error label is gone (a bare
/// `Error:` has nothing).
fn meaningful(line: &str) -> bool {
    line != CLOSED && !ERROR_LABEL.replace(line, "").trim().is_empty()
}

/// No known cause: the first line of the ending that reads as an error,
/// else the first such line anywhere, else the first line, without its
/// error label.
fn fallback(lines: &[String], ending: &[String]) -> (String, Option<String>) {
    let output: Vec<&String> = lines.iter().filter(|l| meaningful(l)).collect();
    if output.is_empty() {
        return match lines.first() {
            Some(l) if l == CLOSED => (
                "The server exited before it answered.".into(),
                Some("Run its command in Terminal to see why.".into()),
            ),
            Some(l) => (clip(&tidy(l)), None),
            None => ("The server failed to connect.".into(), None),
        };
    }
    let line = ending
        .iter()
        .find(|l| meaningful(l) && ERRORISH.is_match(l))
        .or_else(|| output.iter().copied().find(|l| ERRORISH.is_match(l)))
        .unwrap_or(output[0]);
    (clip(&tidy(line)), None)
}

/// A line as a summary: its error label dropped, a JSON-RPC error answer
/// reduced to its message, ending in a full stop.
fn tidy(line: &str) -> String {
    let stripped = ERROR_LABEL.replace(line, "");
    let line = match stripped.trim() {
        "" => line.trim(),
        rest => rest,
    };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
        if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
            return format!("The server answered with an error: {}", m.trim_end_matches('.')).trim().to_string() + ".";
        }
    }
    let mut s = line.to_string();
    if let Some(c) = s.chars().next() {
        if c.is_lowercase() {
            s = c.to_uppercase().collect::<String>() + &s[c.len_utf8()..];
        }
    }
    if !s.ends_with(['.', '!', '?', ')', ']', '}']) {
        s.push('.');
    }
    s
}

/// At most [`SUMMARY_CAP`] characters, cut at a character boundary.
fn clip(s: &str) -> String {
    if s.chars().count() <= SUMMARY_CAP {
        return s.to_string();
    }
    let cut: String = s.chars().take(SUMMARY_CAP - 1).collect();
    format!("{}…", cut.trim_end())
}

/// `/opt/homebrew/bin/npx` → `npx`, for a `which` hint.
fn base_name(program: &str) -> &str {
    program.rsplit('/').next().unwrap_or(program)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn closed(output: &str) -> String {
        format!("{CLOSED}\n{output}")
    }

    #[test]
    fn dynamic_client_registration_rejected_at_any_status() {
        // mcp-remote 0.16: the server has no registration endpoint.
        let stderr = closed(
            "[48211] Using automatically selected callback port: 3334\n\
             [48211] Discovering OAuth server configuration...\n\
             [48211] Connecting to remote server: https://mcp.example.com/mcp\n\
             [48211] Using transport strategy: http-first\n\
             [48211] Received error (status 401): Unauthorized\n\
             [48211] Authentication required. Initializing auth...\n\
             [48211] Fatal error: Error: Dynamic Client Registration rejected (HTTP 404): Not Found",
        );
        let f = classify_failure(&stderr);
        assert_eq!(f.summary, "This server doesn't support automatic sign-in.");
        assert_eq!(f.hint.as_deref(), Some("Use a token, or the OAuth client ID its admins give you."));
        assert!(f.detail.contains("Dynamic Client Registration rejected (HTTP 404)"), "{}", f.detail);
        assert!(f.detail.starts_with(CLOSED) && f.detail.contains("[48211] Discovering"), "the details keep every line as printed");

        let f = classify_failure(&closed("[7] Fatal error: Error: Dynamic Client Registration rejected (HTTP 400): invalid_client_metadata"));
        assert_eq!(f.summary, "This server doesn't support automatic sign-in.");
        // Older mcp-remote releases word it differently.
        let f = classify_failure(&closed("Error: Incompatible auth server: does not support dynamic client registration"));
        assert_eq!(f.summary, "This server doesn't support automatic sign-in.");
    }

    #[test]
    fn rejected_credentials() {
        for output in [
            "[901] Error POSTing to endpoint (HTTP 401): {\"error\":\"invalid_token\",\"error_description\":\"expired\"}",
            "[901] SSE error: Non-200 status code (403)",
            "[901] Fatal error: Error: Forbidden",
            "[901] Error: the token is expired",
        ] {
            let f = classify_failure(&closed(output));
            assert_eq!(f.summary, "The server rejected the credentials.", "{output}");
            assert_eq!(f.hint.as_deref(), Some("Check the token or headers it sends, or sign in again."));
        }
    }

    #[test]
    fn a_pid_or_a_stack_frame_isnt_a_status() {
        let f = classify_failure(&closed(
            "[401] Connecting to remote server: https://mcp.example.com/mcp\n\
             [401] Fatal error: TypeError: Cannot read properties of undefined (reading 'tools')\n\
             [401]     at Client.listTools (file:///tmp/node_modules/sdk/client.js:401:12)",
        ));
        assert_eq!(f.summary, "TypeError: Cannot read properties of undefined (reading 'tools')");
        assert_eq!(f.hint, None);
    }

    #[test]
    fn a_command_that_isnt_found_keeps_octopushs_path_message() {
        let f = classify_failure(
            "Octopush couldn't find `npx` on the PATH Octopush searched (/opt/homebrew/bin:/usr/bin:/bin). \
             Use its full path (run `which npx` in Terminal).",
        );
        assert_eq!(f.summary, "Octopush couldn't find `npx` on the PATH Octopush searched.");
        assert_eq!(f.hint.as_deref(), Some("Use its full path (run `which npx` in Terminal)."));
        assert!(f.detail.contains("/opt/homebrew/bin:/usr/bin:/bin"), "the PATH searched is in the details");

        let f = classify_failure("Octopush couldn't find `uvx` on the server's own PATH (/nonexistent/own). Use its full path (run `which uvx` in Terminal).");
        assert_eq!(f.summary, "Octopush couldn't find `uvx` on the server's own PATH.");

        let f = classify_failure("spawn /Users/sample/.nvm/versions/node/v22.0.0/bin/npx: No such file or directory (os error 2)");
        assert_eq!(f.summary, "Octopush couldn't find `/Users/sample/.nvm/versions/node/v22.0.0/bin/npx`.");
        assert_eq!(f.hint.as_deref(), Some("Check the command's path (run `which npx` in Terminal)."));
    }

    #[test]
    fn a_program_the_server_runs_isnt_found() {
        let f = classify_failure(&closed("env: node: No such file or directory"));
        assert_eq!(f.summary, "The server couldn't start `node`.");
        assert!(f.hint.as_deref().unwrap().contains("which node"), "{:?}", f.hint);
        let f = classify_failure(&closed("Error: spawn uvx ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)"));
        assert_eq!(f.summary, "The server couldn't start `uvx`.");
    }

    #[test]
    fn an_initial_401_on_the_way_to_a_browser_sign_in_isnt_the_cause() {
        let challenge = "[7] Received error (status 401): Unauthorized\n[7] Authentication required. Initializing auth...";
        let f = classify_failure(&closed(&format!(
            "{challenge}\n[7] Fatal error: Error: listen EADDRINUSE: address already in use :::3334"
        )));
        assert_eq!(f.summary, "The sign-in callback port is in use.");
        assert!(f.hint.as_deref().unwrap().contains("browser"), "{:?}", f.hint);

        let f = classify_failure(&closed(&format!(
            "{challenge}\n[7] Fatal error: ServerError: HTTP 500: Internal Server Error from https://auth.example.com/token"
        )));
        assert_eq!(f.summary, "ServerError: HTTP 500: Internal Server Error from https://auth.example.com/token.");
        assert_eq!(f.hint, None);

        // The 401 alone is the cause.
        let f = classify_failure(&closed(challenge));
        assert_eq!(f.summary, "The server rejected the credentials.");
    }

    #[test]
    fn a_url_port_isnt_a_status() {
        let f = classify_failure(&closed("[2] Error: connect to http://localhost:401/mcp failed: socket hang up"));
        assert_ne!(f.summary, "The server rejected the credentials.");
        let f = classify_failure(&closed("[2] Fatal error: HTTP/1.1 403 Forbidden"));
        assert_eq!(f.summary, "The server rejected the credentials.");
    }

    #[test]
    fn a_shell_that_cant_find_the_program() {
        let f = classify_failure(&closed("sh: npx: command not found"));
        assert_eq!(f.summary, "The server couldn't start `npx`.");
        let f = classify_failure(&closed("zsh: command not found: uvx"));
        assert_eq!(f.summary, "The server couldn't start `uvx`.");
        let f = classify_failure(&closed("bash: line 1: node: command not found"));
        assert_eq!(f.summary, "The server couldn't start `node`.");
    }

    #[test]
    fn a_sign_in_that_timed_out_has_its_own_hint() {
        let f = classify_failure(&closed("[4] Authentication timed out after 30s"));
        assert_eq!(f.summary, "Signing in timed out.");
        assert_eq!(f.hint.as_deref(), Some("Finish signing in in the browser window that opened, then test again."));
    }

    #[test]
    fn a_bare_error_label_falls_through_to_the_next_line() {
        let f = classify_failure(&closed("[5] Error:\n[5]   unexpected end of JSON input from the server"));
        assert_eq!(f.summary, "Unexpected end of JSON input from the server.");
    }

    #[test]
    fn credentials_in_other_shapes_are_redacted_too() {
        let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzYW1wbGUifQ.c2lnbmF0dXJl";
        let output = closed(&format!(
            "[3] Using custom headers: {{\"Authorization\":\"Basic dXNlcjpwYXNzd29yZA==\"}}\n\
             Authorization: Basic c2FtcGxlOnNlY3JldA==\n\
             X-API-Key: k3y-v4lue\n\
             {{\"refresh_token\":\"rt-abc\",\"id_token\":\"{jwt}\"}}\n\
             token was {jwt}\n\
             {{\"client_secret\":\"shh-1\",\"password\":\"hunter2\"}}\n\
             [3] echo: my-own-env-value-42\n\
             [3] Fatal error: Error: Unexpected token"
        ));
        let known = [crate::secret_scan::KnownSecret::new("env SAMPLE_VAR", "my-own-env-value-42")];
        let f = classify_failure_with(&output, &known);
        for secret in [
            "dXNlcjpwYXNzd29yZA==",
            "c2FtcGxlOnNlY3JldA==",
            "k3y-v4lue",
            "rt-abc",
            jwt,
            "shh-1",
            "hunter2",
            "my-own-env-value-42",
        ] {
            assert!(!f.detail.contains(secret) && !f.summary.contains(secret), "{secret} in {}", f.detail);
        }
        assert!(f.detail.contains("Authorization: [redacted]") && f.detail.contains("X-API-Key: [redacted]"), "{}", f.detail);
        // Lines that only name a credential keep their words.
        assert!(f.detail.contains("Fatal error: Error: Unexpected token"), "{}", f.detail);
    }

    #[test]
    fn timeouts() {
        let f = classify_failure(
            "Connection timed out after 120s. If this server requires OAuth, complete the authentication in the \
             browser that opened, then test again.",
        );
        assert_eq!(f.summary, "The server didn't answer within 120s.");
        assert_eq!(f.hint.as_deref(), Some("If it signs in through a browser, finish signing in there, then test again."));

        let f = classify_failure(&closed("[52] Connection error: TypeError: fetch failed\n[52]   cause: ConnectTimeoutError: Connect Timeout Error (attempted address: mcp.example.com:443, timeout: 10000ms) { code: 'UND_ERR_CONNECT_TIMEOUT' }"));
        assert_eq!(f.summary, "The connection to the server timed out.");
    }

    #[test]
    fn refused_and_unresolvable_hosts() {
        let f = classify_failure(&closed("[3] Connection error: TypeError: fetch failed\n[3]   [cause]: Error: connect ECONNREFUSED 127.0.0.1:8808"));
        assert_eq!(f.summary, "The server refused the connection.");
        assert_eq!(f.hint.as_deref(), Some("Check the URL and port, and that the server is running."));

        let f = classify_failure(&closed("[3] Fatal error: TypeError: fetch failed\n[3]   [cause]: Error: getaddrinfo ENOTFOUND mcp.example.invalid"));
        assert_eq!(f.summary, "Octopush couldn't find the host mcp.example.invalid.");
        assert_eq!(f.hint.as_deref(), Some("Check the URL's host name and your network or VPN."));
        let f = classify_failure(&closed("curl: (6) Could not resolve host: mcp.example.com"));
        assert_eq!(f.summary, "Octopush couldn't find the server's host.");
    }

    #[test]
    fn fallback_is_the_first_line_that_reads_as_an_error() {
        let f = classify_failure(&closed("starting example-server v1.2\nlistening on stdio\nerror: missing config file ./server.toml\nbye"));
        assert_eq!(f.summary, "Missing config file ./server.toml.");
        assert_eq!(f.hint, None);
        // No error line: the first line of output.
        let f = classify_failure(&closed("usage: example-server [--stdio]"));
        assert_eq!(f.summary, "Usage: example-server [--stdio]");
        // No output at all.
        let f = classify_failure(CLOSED);
        assert_eq!(f.summary, "The server exited before it answered.");
        assert_eq!(f.hint.as_deref(), Some("Run its command in Terminal to see why."));
        // A JSON-RPC error answer to the handshake.
        let f = classify_failure(r#"{"code":-32601,"message":"Method not found"}"#);
        assert_eq!(f.summary, "The server answered with an error: Method not found.");
        // Octopush's own one-liners.
        let f = classify_failure("couldn't write to the server: Broken pipe (os error 32)");
        assert_eq!(f.summary, "Couldn't write to the server: Broken pipe (os error 32)");
        assert_eq!(classify_failure("").summary, "The server failed to connect.");
    }

    #[test]
    fn a_long_line_is_cut_for_the_summary_but_not_the_details() {
        let long = format!("error: {}", "x".repeat(400));
        let f = classify_failure(&closed(&long));
        assert_eq!(f.summary.chars().count(), SUMMARY_CAP);
        assert!(f.summary.ends_with('…'));
        assert!(f.detail.contains(&"x".repeat(400)));
    }

    #[test]
    fn secrets_in_the_output_are_redacted_everywhere() {
        let gh = format!("ghp_{}", "b".repeat(36));
        let f = classify_failure(&closed(&format!(
            "[9] Using custom headers: {{\"Authorization\":\"Bearer abcdefgh12345678\"}}\n\
             [9] Open https://auth.example.com/authorize?code=s3cr3tc0de&state=1\n\
             [9] Error: bad key {gh}\nAPI_TOKEN=tok-value-123"
        )));
        for secret in ["abcdefgh12345678", "s3cr3tc0de", gh.as_str(), "tok-value-123"] {
            assert!(!f.detail.contains(secret) && !f.summary.contains(secret), "{secret}: {f:?}");
        }
        assert_eq!(f.summary, "Bad key [redacted]");
    }
}
