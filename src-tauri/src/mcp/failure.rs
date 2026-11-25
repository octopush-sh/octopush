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
/// "status code (403)"), so a pid or a stack trace's `:401:` doesn't count.
static AUTH_STATUS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:https?|status|code)\b[^0-9\n]{0,12}\b40[13]\b").unwrap());
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
/// Node (`spawn node ENOENT`) or `/usr/bin/env` (`env: node: No such file…`).
static CHILD_MISSING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bspawn (\S+) ENOENT\b|\benv: ['‘"]?([^\s'’":]+)['’"]?:? No such file or directory"#).unwrap()
});
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
/// input). Every line is redacted first, so neither the summary nor the
/// details can show a token the output carried.
pub fn classify_failure(reason: &str) -> McpFailure {
    let raw: Vec<String> = reason.trim().lines().map(super::redact_output_line).collect();
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

fn summarize(lines: &[String], text: &str) -> (String, Option<String>) {
    let first = lines.first().map(String::as_str).unwrap_or("");
    let hint = |s: &str| Some(s.to_string());

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
        let program = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
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
    if REFUSED.is_match(text) {
        return (
            "The server refused the connection.".into(),
            hint("Check the URL and port, and that the server is running."),
        );
    }
    if DNS.is_match(text) {
        let summary = match DNS_HOST.captures(text) {
            Some(c) => format!("Octopush couldn't find the host {}.", &c[1]),
            None => "Octopush couldn't find the server's host.".into(),
        };
        return (summary, hint("Check the URL's host name and your network or VPN."));
    }
    if NET_TIMEOUT.is_match(text) {
        return (
            "The connection to the server timed out.".into(),
            hint("Check the URL and your network or VPN, then test again."),
        );
    }
    if AUTH_STATUS.is_match(text) || AUTH_WORDS.is_match(text) {
        return (
            "The server rejected the credentials.".into(),
            hint("Check the token or headers it sends, or sign in again."),
        );
    }
    fallback(lines)
}

/// No known cause: the first line that reads as an error, else the first
/// line, without its error label.
fn fallback(lines: &[String]) -> (String, Option<String>) {
    let output: Vec<&String> = match lines.first() {
        Some(l) if l == CLOSED => lines[1..].iter().collect(),
        _ => lines.iter().collect(),
    };
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
    let line = output.iter().find(|l| ERRORISH.is_match(l)).unwrap_or(&output[0]);
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
