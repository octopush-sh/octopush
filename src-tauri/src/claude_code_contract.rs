//! Contract tests: recorded Claude Code output, run through the REAL parsers.
//!
//! Octopush reads several undocumented, fast-moving Claude Code formats. Each
//! one has a fixture under `tests/fixtures/claude-code/<cli-version>/`
//! (re-recorded with `scripts/record-claude-fixtures.sh`; see the README
//! there) and a test here that feeds it to the production function — never a
//! copy — so an upstream format change shows up as one red test whose message
//! names the fixture and the field that went missing.
//!
//! Every version directory present is tested, so a fresh recording is covered
//! the moment it lands.
//!
//! | Surface | Production code |
//! |---|---|
//! | `claude -p --output-format stream-json --verbose` (+ `--resume`) | `orchestrator::cli_runner`, `orchestrator::live` |
//! | transcript JSONL (`~/.claude/projects/<cwd>/<session>.jsonl`) | `transcripts` |
//! | `Total cost:` PTY tail | `token_engine::scan_pty_output` (via `agent_adapter`) |
//! | `SKILL.md` / `.claude/agents/*.md` frontmatter (incl. `effort:`) | `skills`, `skills::agents` |
//! | `claude mcp add octopush …` argv | `mcp_setup` |
//! | `Notification` / `Stop` hook stdin payloads | `agent_adapter::parse_hook_event`, `claude_hooks::record_hook` |
//! | `claude auth status --json` (`loggedIn`, `loginExpiresAt`) | `agent_adapter::parse_claude_auth_status` |

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::agent_adapter::{AgentAdapter, ClaudeCodeAdapter};
use crate::orchestrator::cli_runner::{
    apply_stage_env, build_cli_args, build_cli_args_resume, context_window_env, is_builtin_claude_model, DISABLE_1M_CONTEXT_ENV,
    MAX_CONTEXT_TOKENS_ENV, cli_auth_from_init, is_result_event,
    parse_cli_result, plan_windows_from_stream_event, read_stream, usage_from_stream_event, CliAuth,
    CliDialect, CodexWriteScope, OpenTools, ReadEnd, ReadLimits, QUIET_TRAFFIC_ENV,
};
use crate::orchestrator::live::{api_retry_delay, entries_from_stream_event, RetryThrottle};
use crate::orchestrator::types::{ArtifactKind, StageStatus};

// ─── Fixture helpers ──────────────────────────────────────────────────────

/// One recorded CLI version: `tests/fixtures/claude-code/<version>/`.
struct Rec {
    dir: PathBuf,
    version: String,
}

impl Rec {
    fn label(&self, rel: &str) -> String {
        format!("claude-code/{}/{rel}", self.version)
    }
    fn path(&self, rel: &str) -> PathBuf {
        let p = self.dir.join(rel);
        assert!(
            p.exists(),
            "[{}] fixture is missing — re-record with scripts/record-claude-fixtures.sh (see the fixtures README)",
            self.label(rel)
        );
        p
    }
    fn text(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path(rel))
            .unwrap_or_else(|e| panic!("[{}] unreadable fixture: {e}", self.label(rel)))
    }
    /// Every line parsed as JSON; a non-JSON line is a broken fixture.
    fn jsonl(&self, rel: &str) -> Vec<Value> {
        self.text(rel)
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, l)| {
                serde_json::from_str(l)
                    .unwrap_or_else(|e| panic!("[{}:{}] line is not JSON: {e}", self.label(rel), i + 1))
            })
            .collect()
    }
    fn json(&self, rel: &str) -> Value {
        serde_json::from_str(&self.text(rel))
            .unwrap_or_else(|e| panic!("[{}] not JSON: {e}", self.label(rel)))
    }
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-code")
}

/// `2.1.10` → `[2, 1, 10]`, so versions sort numerically (2.1.9 < 2.1.10).
fn semver_key(v: &str) -> Vec<u64> {
    v.split(['.', '-']).map(|p| p.parse().unwrap_or(0)).collect()
}

/// All recorded versions, oldest first. Every directory under the fixture
/// root is a recording, except a synthetic-only one (a `SYNTHETIC` file in
/// place of `VERSION`, see [`synthesized`]): one without a `VERSION` file, or
/// whose `VERSION` disagrees with its name, is a broken recording and fails here.
fn recordings() -> Vec<Rec> {
    let root = fixture_root();
    let mut out: Vec<Rec> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("fixture root {} unreadable: {e}", root.display()))
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| !e.path().join("SYNTHETIC").exists() || e.path().join("VERSION").exists())
        .map(|e| {
            let dir = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let version = std::fs::read_to_string(dir.join("VERSION"))
                .unwrap_or_else(|_| panic!("[claude-code/{name}] recording has no VERSION file"))
                .trim()
                .to_string();
            assert_eq!(version, name, "[claude-code/{name}/VERSION] says `{version}`, but the directory is `{name}`");
            Rec { dir, version }
        })
        .collect();
    out.sort_by_key(|r| semver_key(&r.version));
    assert!(!out.is_empty(), "no Claude Code fixture versions under {}", root.display());
    out
}

/// One specific recording (for tests about a fixture known to have a shape).
fn recording(version: &str) -> Rec {
    recordings()
        .into_iter()
        .find(|r| r.version == version)
        .unwrap_or_else(|| panic!("[claude-code/{version}] recording not found"))
}

/// Hand-written fixtures for a CLI version with no recording yet:
/// `tests/fixtures/claude-code/<version>/` holding a `SYNTHETIC` file (its
/// content the version) instead of `VERSION`. Only tests that name a file
/// read them; the recording suite skips the directory.
fn synthesized(version: &str) -> Rec {
    let dir = fixture_root().join(version);
    let marker = std::fs::read_to_string(dir.join("SYNTHETIC"))
        .unwrap_or_else(|_| panic!("[claude-code/{version}] has no SYNTHETIC file"));
    assert_eq!(marker.trim(), version, "[claude-code/{version}/SYNTHETIC] names another version");
    Rec { dir, version: version.to_string() }
}

#[test]
fn versions_sort_numerically() {
    let mut v = vec!["2.1.10", "2.1.9", "2.0.100", "10.0.0"];
    v.sort_by_key(|s| semver_key(s));
    assert_eq!(v, ["2.0.100", "2.1.9", "2.1.10", "10.0.0"]);
}

#[test]
fn tested_claude_floor_names_a_recorded_version() {
    // The Settings row and the run preflight warn below this version, so it
    // must be one the contract tests actually ran against.
    let floor = crate::agent_adapter::TESTED_CLAUDE_FLOOR;
    let versions: Vec<String> = recordings().into_iter().map(|r| r.version).collect();
    assert!(
        versions.iter().any(|v| v == floor),
        "agent_adapter::TESTED_CLAUDE_FLOOR is {floor}, but the recorded fixtures are {versions:?} — \
         bump the floor together with the fixtures"
    );
}

/// Walk a dotted path (`message.usage.input_tokens`, `message.content.0.id`).
/// `Err` names the fixture, the field, and the event type it was read from.
fn try_require<'a>(fixture: &str, v: &'a Value, path: &str) -> Result<&'a Value, String> {
    let mut cur = v;
    for seg in path.split('.') {
        let next = match seg.parse::<usize>() {
            Ok(i) => cur.get(i),
            Err(_) => cur.get(seg),
        };
        cur = match next {
            Some(n) if !n.is_null() => n,
            _ => {
                let ty = v.get("type").and_then(Value::as_str).unwrap_or("?");
                return Err(format!(
                    "[{fixture}] Claude Code contract broken: required field `{path}` is missing \
                     (event type `{ty}`). Claude Code changed its format — update the parser, then re-record."
                ));
            }
        };
    }
    Ok(cur)
}

fn require<'a>(fixture: &str, v: &'a Value, path: &str) -> &'a Value {
    try_require(fixture, v, path).unwrap_or_else(|e| panic!("{e}"))
}

fn require_str<'a>(fixture: &str, v: &'a Value, path: &str) -> &'a str {
    require(fixture, v, path)
        .as_str()
        .unwrap_or_else(|| panic!("[{fixture}] field `{path}` is not a string"))
}

fn require_u64(fixture: &str, v: &Value, path: &str) -> u64 {
    require(fixture, v, path)
        .as_u64()
        .unwrap_or_else(|| panic!("[{fixture}] field `{path}` is not an unsigned integer"))
}

fn of_type<'a>(events: &'a [Value], ty: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e.get("type").and_then(Value::as_str) == Some(ty)).collect()
}

/// The one terminal `result` event (by the production predicate).
fn result_event<'a>(fixture: &str, events: &'a [Value]) -> &'a Value {
    let results: Vec<&Value> = events.iter().filter(|e| is_result_event(e)).collect();
    assert_eq!(results.len(), 1, "[{fixture}] expected exactly one `type:\"result\"` event, found {}", results.len());
    results[0]
}

const USAGE_FIELDS: [&str; 4] =
    ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

/// The fields the stream parsers read from every event of a run.
fn check_stream_shape(fixture: &str, events: &[Value]) {
    let init = events
        .iter()
        .find(|e| e.get("subtype").and_then(Value::as_str) == Some("init"))
        .unwrap_or_else(|| panic!("[{fixture}] no `system`/`init` event"));
    require_str(fixture, init, "session_id");
    let assistants = of_type(events, "assistant");
    assert!(!assistants.is_empty(), "[{fixture}] no `assistant` events");
    for a in &assistants {
        require_str(fixture, a, "message.id");
        require(fixture, a, "message.content");
        for f in USAGE_FIELDS {
            require_u64(fixture, a, &format!("message.usage.{f}"));
        }
        // A stopped stage prices each message at the model that answered it
        // (a subagent may run on another model than the stage).
        let model = require_str(fixture, a, "message.model");
        let (_, u) = usage_from_stream_event(a)
            .unwrap_or_else(|| panic!("[{fixture}] usage_from_stream_event returned None for an assistant event"));
        assert_eq!(u.model.as_deref(), Some(model), "[{fixture}] usage_from_stream_event lost `message.model`");
    }
    let result = result_event(fixture, events);
    for f in ["subtype", "is_error", "result", "session_id", "total_cost_usd"] {
        require(fixture, result, f);
    }
    for f in USAGE_FIELDS {
        require_u64(fixture, result, &format!("usage.{f}"));
    }
}

/// Run a recorded stream exactly as `CliRunner::run` does: entries for the
/// journal, latest usage per message id, and the result line through
/// `parse_cli_result`.
fn replay(fixture: &str, events: &[Value]) -> (Vec<Value>, HashMap<String, u64>, crate::orchestrator::types::StageOutcome) {
    let mut entries = Vec::new();
    let mut usage_by_msg: HashMap<String, u64> = HashMap::new();
    for e in events {
        entries.extend(entries_from_stream_event(e));
        if let Some((id, u)) = usage_from_stream_event(e) {
            let key = id.unwrap_or_else(|| format!("anon-{}", usage_by_msg.len()));
            usage_by_msg.insert(key, u.input_tokens + u.output_tokens);
        }
    }
    let line = serde_json::to_string(result_event(fixture, events)).unwrap();
    let outcome = parse_cli_result(&line, true, ArtifactKind::Note, "")
        .unwrap_or_else(|e| panic!("[{fixture}] parse_cli_result rejected the result event: {e}"));
    (entries, usage_by_msg, outcome)
}

fn kind_entries<'a>(entries: &'a [Value], kind: &str) -> Vec<&'a Value> {
    entries.iter().filter(|e| e["kind"] == kind).collect()
}

// ─── stream-json ──────────────────────────────────────────────────────────

#[test]
fn stream_json_simple_reply_parses_to_a_done_stage() {
    for rec in recordings() {
        let fx = rec.label("stream-json/simple.jsonl");
        let events = rec.jsonl("stream-json/simple.jsonl");
        check_stream_shape(&fx, &events);
        let init = events.iter().find(|e| e["subtype"] == "init").unwrap();
        assert_eq!(require_str(&fx, init, "claude_code_version"), rec.version, "[{fx}] VERSION file disagrees with the recording");
        let (entries, _, outcome) = replay(&fx, &events);
        assert_eq!(outcome.status, StageStatus::Done, "[{fx}] {:?}", outcome.error);
        assert_eq!(outcome.artifact.text.trim(), "ok", "[{fx}] result text");
        assert_eq!(outcome.session_id.as_deref(), Some(require_str(&fx, init, "session_id")), "[{fx}] result session_id must match init");
        assert!(outcome.cost_usd > 0.0, "[{fx}] total_cost_usd not carried");
        let r = result_event(&fx, &events);
        assert_eq!(outcome.input_tokens, require_u64(&fx, r, "usage.input_tokens"));
        assert_eq!(outcome.output_tokens, require_u64(&fx, r, "usage.output_tokens"));
        assert_eq!(outcome.cache_read_tokens, require_u64(&fx, r, "usage.cache_read_input_tokens"));
        assert_eq!(outcome.cache_creation_tokens, require_u64(&fx, r, "usage.cache_creation_input_tokens"));
        assert!(
            kind_entries(&entries, "text").iter().any(|e| e["text"] == "ok"),
            "[{fx}] the journal got no `ok` text entry: {entries:?}"
        );
    }
}

#[test]
fn stream_json_tool_use_journals_the_call_and_its_result() {
    for rec in recordings() {
        let fx = rec.label("stream-json/tool-use.jsonl");
        let events = rec.jsonl("stream-json/tool-use.jsonl");
        check_stream_shape(&fx, &events);
        let tool_use = events
            .iter()
            .flat_map(|e| e.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default())
            .find(|b| b["type"] == "tool_use")
            .unwrap_or_else(|| panic!("[{fx}] no tool_use content block"));
        for f in ["id", "name", "input.file_path"] {
            require(&fx, &tool_use, f);
        }
        let tool_result = events
            .iter()
            .filter(|e| e["type"] == "user")
            .flat_map(|e| e.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default())
            .find(|b| b["type"] == "tool_result")
            .unwrap_or_else(|| panic!("[{fx}] no user tool_result block"));
        require(&fx, &tool_result, "tool_use_id");
        require(&fx, &tool_result, "content");

        // The idle clock pairs each call with its result by id
        // (`OpenTools`): a recorded call opens, and its result closes it.
        let mut open = OpenTools::default();
        let mut was_open = false;
        for e in &events {
            open.observe(e);
            was_open |= open.latest().is_some_and(|t| t.name == "Read");
        }
        assert!(was_open, "[{fx}] the Read tool_use never registered as an open call");
        assert_eq!(open.latest(), None, "[{fx}] a call stayed open after its tool_result");

        let (entries, usage_by_msg, outcome) = replay(&fx, &events);
        let tools = kind_entries(&entries, "tool");
        assert!(
            tools.iter().any(|e| e["tool"] == "Read" && e["hint"].as_str().is_some_and(|h| h.ends_with("note.txt"))),
            "[{fx}] no `Read · …note.txt` tool entry: {tools:?}"
        );
        let results = kind_entries(&entries, "tool_result");
        assert!(
            results.iter().any(|e| e["ok"] == true && e["detail"].as_str().is_some_and(|d| d.contains("hello fixture"))),
            "[{fx}] no ok tool_result entry carrying the file text: {results:?}"
        );
        // The CLI emits one assistant event per content block, each repeating
        // its message's id — two API calls here, however many blocks.
        let ids: HashSet<&str> = of_type(&events, "assistant")
            .iter()
            .map(|a| require_str(&fx, a, "message.id"))
            .collect();
        assert!(of_type(&events, "assistant").len() > ids.len(), "[{fx}] expected per-block assistant events sharing a message id");
        assert_eq!(usage_by_msg.len(), ids.len(), "[{fx}] streamed usage must collapse to one entry per message id");
        assert_eq!(outcome.status, StageStatus::Done, "[{fx}] {:?}", outcome.error);
        assert_eq!(outcome.artifact.text.trim(), "hello fixture", "[{fx}] result text");
    }
}

#[test]
fn stream_json_resume_continues_a_recorded_session() {
    for rec in recordings() {
        let fx = rec.label("stream-json/resume.jsonl");
        let events = rec.jsonl("stream-json/resume.jsonl");
        check_stream_shape(&fx, &events);
        let (_, _, outcome) = replay(&fx, &events);
        assert_eq!(outcome.status, StageStatus::Done, "[{fx}] {:?}", outcome.error);
        assert_eq!(outcome.artifact.text.trim(), "resumed", "[{fx}] result text");
        // The resumed session id (persisted for the next Resume) is present.
        let sid = outcome.session_id.clone().unwrap_or_else(|| panic!("[{fx}] resumed result carries no session_id"));
        let args = build_cli_args_resume("claude-haiku-4-5", &sid, 1, false);
        let at = args.iter().position(|a| a == "--resume").expect("--resume flag");
        assert_eq!(args[at + 1], sid);
    }
}

#[test]
fn stream_json_api_error_is_a_failed_stage_with_the_cli_message() {
    for rec in recordings() {
        let fx = rec.label("stream-json/error-unknown-model.jsonl");
        let events = rec.jsonl("stream-json/error-unknown-model.jsonl");
        check_stream_shape(&fx, &events);
        let r = result_event(&fx, &events);
        assert_eq!(require(&fx, r, "is_error"), &Value::Bool(true), "[{fx}] an API error must set is_error");
        let (entries, _, outcome) = replay(&fx, &events);
        assert_eq!(outcome.status, StageStatus::Failed, "[{fx}] an is_error result must fail the stage");
        let err = outcome.error.unwrap_or_default();
        assert!(err.contains("claude-nonexistent-model-0"), "[{fx}] failure should carry the CLI's message, got: {err}");
        assert_eq!(outcome.cost_usd, 0.0);
        assert!(!kind_entries(&entries, "text").is_empty(), "[{fx}] the CLI's error text should reach the journal");
    }
}

#[test]
fn stream_json_success_result_with_exit_1_keeps_the_work_and_drops_the_session() {
    // Claude Code 2.1.317+: `-p` exits 1 when a full disk or quota loses the
    // session transcript or a ~/.claude.json write — after a `success` result.
    use crate::orchestrator::cli_runner::{is_budget_stop, is_session_not_saved};
    for rec in recordings() {
        for rel in ["stream-json/simple.jsonl", "stream-json/tool-use.jsonl", "stream-json/resume.jsonl"] {
            let fx = rec.label(rel);
            let events = rec.jsonl(rel);
            let r = result_event(&fx, &events);
            assert_eq!(require_str(&fx, r, "subtype"), "success", "[{fx}]");
            assert_eq!(require(&fx, r, "is_error"), &Value::Bool(false), "[{fx}]");
            let line = serde_json::to_string(r).unwrap();
            let outcome = parse_cli_result(&line, false, ArtifactKind::Diff, "ENOSPC: no space left on device")
                .unwrap_or_else(|e| panic!("[{fx}] parse_cli_result rejected the result event: {e}"));
            assert_eq!(outcome.status, StageStatus::Failed, "[{fx}]");
            let err = outcome.error.as_deref().unwrap_or_default();
            assert!(is_session_not_saved(err) && !is_budget_stop(err), "[{fx}] {err}");
            assert!(err.contains("no space left on device"), "[{fx}] stderr tail: {err}");
            assert_eq!(outcome.artifact.text, require_str(&fx, r, "result"), "[{fx}] the result text is kept");
            assert_eq!(outcome.session_id, None, "[{fx}] the unsaved session must not be resumed");
            assert_eq!(outcome.input_tokens, require_u64(&fx, r, "usage.input_tokens"), "[{fx}]");
        }
    }
}

#[test]
fn stream_json_api_error_with_exit_1_still_carries_the_cli_message() {
    for rec in recordings() {
        let fx = rec.label("stream-json/error-unknown-model.jsonl");
        let events = rec.jsonl("stream-json/error-unknown-model.jsonl");
        let line = serde_json::to_string(result_event(&fx, &events)).unwrap();
        let outcome = parse_cli_result(&line, false, ArtifactKind::Note, "").unwrap();
        assert_eq!(outcome.status, StageStatus::Failed, "[{fx}]");
        let err = outcome.error.unwrap_or_default();
        assert!(err.contains("claude-nonexistent-model-0"), "[{fx}] {err}");
        assert!(!crate::orchestrator::cli_runner::is_session_not_saved(&err), "[{fx}] {err}");
    }
}

const DEFERRED_VERSION: &str = "2.1.319";
const TOOL_DEFERRED_REL: &str = "stream-json/tool-deferred.jsonl";
const DEFERRED_UNAVAILABLE_REL: &str = "stream-json/resume-deferred-tool-unavailable.jsonl";

/// A deferred-tool result line through `parse_cli_result` at its exit code.
fn deferred_outcome(rel: &str, exit_success: bool) -> (String, Value, crate::orchestrator::types::StageOutcome) {
    let rec = synthesized(DEFERRED_VERSION);
    let fx = rec.label(rel);
    let events = rec.jsonl(rel);
    let r = result_event(&fx, &events).clone();
    for f in ["subtype", "is_error", "result", "session_id", "total_cost_usd", "terminal_reason", "deferred_tool_use.name"] {
        require(&fx, &r, f);
    }
    let line = serde_json::to_string(&r).unwrap();
    let outcome = parse_cli_result(&line, exit_success, ArtifactKind::Diff, "")
        .unwrap_or_else(|e| panic!("[{fx}] parse_cli_result rejected the result event: {e}"));
    (fx, r, outcome)
}

#[test]
fn stream_json_hook_deferred_tool_is_a_halt_not_an_empty_success() {
    use crate::orchestrator::cli_runner::{
        is_budget_stop, is_deferred_tool_unavailable, is_session_not_saved, is_tool_deferred, TOOL_DEFERRED,
    };
    // Claude Code 2.1.319: a PreToolUse hook's `defer` ends the run as a clean
    // `success` with no text, exit 0 — the deferred tool never ran.
    let (fx, r, outcome) = deferred_outcome(TOOL_DEFERRED_REL, true);
    assert_eq!(require_str(&fx, &r, "terminal_reason"), TOOL_DEFERRED, "[{fx}]");
    assert_eq!(require(&fx, &r, "is_error"), &Value::Bool(false), "[{fx}]");
    assert_eq!(outcome.status, StageStatus::Failed, "[{fx}] a deferred tool call is not a finished stage");
    let err = outcome.error.as_deref().unwrap_or_default();
    assert!(is_tool_deferred(err), "[{fx}] {err}");
    assert!(!is_deferred_tool_unavailable(err) && !is_session_not_saved(err) && !is_budget_stop(err), "[{fx}] {err}");
    assert!(
        err.starts_with("A hook paused echo (MCP server fixture-srv) before it ran. Resume once it may run, or re-run the stage."),
        "[{fx}] {err}"
    );
    assert_eq!(outcome.session_id.as_deref(), Some(require_str(&fx, &r, "session_id")), "[{fx}] Resume needs the session");
    assert!(outcome.artifact.text.is_empty(), "[{fx}]");
    assert!(outcome.cost_usd > 0.0, "[{fx}] the spend stays on the meter");
}

#[test]
fn stream_json_resume_with_its_deferred_tool_gone_names_the_tool() {
    use crate::orchestrator::cli_runner::{
        is_budget_stop, is_deferred_tool_unavailable, is_session_not_saved, is_tool_deferred, DEFERRED_TOOL_UNAVAILABLE,
    };
    // Claude Code 2.1.319: `--resume` with a prompt on a session that ended on
    // a deferred call whose tool is no longer available exits 1 — with a
    // `success` subtype and text, the shape of an unsaved session.
    let (fx, r, outcome) = deferred_outcome(DEFERRED_UNAVAILABLE_REL, false);
    assert_eq!(require_str(&fx, &r, "terminal_reason"), DEFERRED_TOOL_UNAVAILABLE, "[{fx}]");
    assert_eq!(require_str(&fx, &r, "subtype"), "success", "[{fx}]");
    assert_eq!(outcome.status, StageStatus::Failed, "[{fx}]");
    let err = outcome.error.as_deref().unwrap_or_default();
    assert!(is_deferred_tool_unavailable(err), "[{fx}] {err}");
    assert!(!is_tool_deferred(err) && !is_session_not_saved(err) && !is_budget_stop(err), "[{fx}] {err}");
    assert!(
        err.starts_with(
            "The resumed session was waiting to run echo (MCP server fixture-srv), which isn't available anymore. \
             Reconnect it and resume, or re-run the stage fresh."
        ),
        "[{fx}] {err}"
    );
    assert_eq!(outcome.session_id.as_deref(), Some(require_str(&fx, &r, "session_id")), "[{fx}] Resume needs the session");
    assert!(outcome.artifact.text.is_empty(), "[{fx}] the CLI's notice is not the stage's work");
    // Even had it exited 0, the reason decides.
    let (_, _, exit_0) = deferred_outcome(DEFERRED_UNAVAILABLE_REL, true);
    assert!(is_deferred_tool_unavailable(exit_0.error.as_deref().unwrap_or_default()), "[{fx}]");
}

const SETTINGS_REFUSED_VERSION: &str = "2.1.326";
const SETTINGS_REFUSED_REL: &str = "stream-json/settings-refused.jsonl";
const SETTINGS_REFUSED_STDERR_REL: &str = "stream-json/settings-refused.stderr.txt";

#[test]
fn stream_json_refused_settings_name_the_setting() {
    use crate::orchestrator::cli_runner::{is_budget_stop, is_session_not_saved, is_settings_refused, SETTINGS_REFUSED};
    // Claude Code 2.1.323: `--settings` that turn the sandbox on and fail
    // validation stop `claude -p` at start-up, naming the invalid setting.
    let rec = synthesized(SETTINGS_REFUSED_VERSION);
    let fx = rec.label(SETTINGS_REFUSED_REL);
    let events = rec.jsonl(SETTINGS_REFUSED_REL);
    let r = result_event(&fx, &events).clone();
    for f in ["subtype", "is_error", "errors.0", "session_id"] {
        require(&fx, &r, f);
    }
    assert_eq!(require_str(&fx, &r, "subtype"), "error_during_execution", "[{fx}]");
    let stderr = rec.text(SETTINGS_REFUSED_STDERR_REL);
    let line = serde_json::to_string(&r).unwrap();
    let named = "(permissions.blockWritesOutsideWorkingDirectories: Expected boolean, but received string)";
    for err_text in [stderr.as_str(), ""] {
        let outcome = parse_cli_result(&line, false, ArtifactKind::Diff, err_text)
            .unwrap_or_else(|e| panic!("[{fx}] parse_cli_result rejected the result event: {e}"));
        assert_eq!(outcome.status, StageStatus::Failed, "[{fx}]");
        let err = outcome.error.as_deref().unwrap_or_default();
        assert!(err.starts_with(&format!("{SETTINGS_REFUSED}: Sandbox required but unavailable: ")), "[{fx}] {err}");
        assert!(err.lines().next().unwrap().contains(named), "[{fx}] the first line names the setting: {err}");
        assert!(!err.contains("error_during_execution"), "[{fx}] not the generic stop: {err}");
        assert!(is_settings_refused(err) && !is_session_not_saved(err) && !is_budget_stop(err), "[{fx}] {err}");
        assert_eq!(outcome.session_id, None, "[{fx}] the session never ran: nothing to resume");
        assert!(outcome.artifact.text.is_empty(), "[{fx}]");
    }
    // stderr alone (no `errors` field) still names it.
    let mut bare = r.clone();
    bare.as_object_mut().unwrap().remove("errors");
    let outcome = parse_cli_result(&serde_json::to_string(&bare).unwrap(), false, ArtifactKind::Diff, &stderr).unwrap();
    let err = outcome.error.as_deref().unwrap_or_default();
    assert!(err.starts_with(&format!("{SETTINGS_REFUSED}: sandbox required but unavailable: ")), "[{fx}] {err}");
    assert!(err.lines().next().unwrap().contains(named), "[{fx}] {err}");
    // The machine-readable reason alone (no `errors`, no stderr) still reads
    // as refused settings; with the reason gone and only an unrelated
    // "failed validation" line, it does not.
    require(&fx, &r, "startup_failure_reason");
    let outcome = parse_cli_result(&serde_json::to_string(&bare).unwrap(), false, ArtifactKind::Diff, "").unwrap();
    assert!(is_settings_refused(outcome.error.as_deref().unwrap_or_default()), "[{fx}]");
    bare.as_object_mut().unwrap().remove("startup_failure_reason");
    let unrelated = "[Bootstrap] Gateway /v1/models failed validation: expected a list";
    let outcome = parse_cli_result(&serde_json::to_string(&bare).unwrap(), false, ArtifactKind::Diff, unrelated).unwrap();
    assert!(!is_settings_refused(outcome.error.as_deref().unwrap_or_default()), "[{fx}]");
}

const DENIALS_VERSION: &str = "2.1.326";
const DENIALS_REL: &str = "stream-json/result-with-denials.jsonl";

#[test]
fn stream_json_permission_denials_are_journaled_and_handed_on() {
    use crate::orchestrator::cli_runner::{refused_notice, refused_total};
    // Synthetic fixture (see the README): Claude Code 2.1.326 refuses some
    // calls in bypassPermissions mode and lists them on the `result` event.
    let rec = synthesized(DENIALS_VERSION);
    let fx = rec.label(DENIALS_REL);
    let events = rec.jsonl(DENIALS_REL);
    check_stream_shape(&fx, &events);
    let r = result_event(&fx, &events);
    for f in ["permission_denials.0.tool_name", "permission_denials.0.tool_use_id", "permission_denials.0.tool_input"] {
        require(&fx, r, f);
    }
    let line = serde_json::to_string(r).unwrap();
    let outcome = parse_cli_result(&line, true, ArtifactKind::Diff, "")
        .unwrap_or_else(|e| panic!("[{fx}] parse_cli_result rejected the result event: {e}"));
    // A writer stage that otherwise succeeded still settles done.
    assert_eq!(outcome.status, StageStatus::Done, "[{fx}] {:?}", outcome.error);
    let notices: Vec<String> = outcome.cli.refused_calls.iter().map(refused_notice).collect();
    assert_eq!(notices, [
        "refused · Bash · git push origin octo/fix-parser ×2",
        "refused · Bash · NPM_TOKEN=[redacted] npm publish --access public",
        "refused · Write · /Users/dev/.zshrc",
    ], "[{fx}]");
    assert_eq!(refused_total(&outcome.cli.refused_calls), 4, "[{fx}]");
    // Its hand-off names them, after the agent's own summary.
    let text = &outcome.artifact.text;
    assert!(text.starts_with("Fixed the parser. The push was refused."), "[{fx}] {text}");
    assert!(text.contains("Claude Code refused these tool calls"), "[{fx}] {text}");
    assert!(text.contains("- Bash: git push origin octo/fix-parser (×2)"), "[{fx}] {text}");
    assert!(!text.contains("fixture-npm-value-0403"), "[{fx}] the token never reaches the next stage");
    // A plan or review stage's artifact is left as the agent wrote it.
    let note = parse_cli_result(&line, true, ArtifactKind::Review, "").unwrap();
    assert_eq!(note.artifact.text, "Fixed the parser. The push was refused.", "[{fx}]");
    assert_eq!(refused_total(&note.cli.refused_calls), 4, "[{fx}]");
    // Every recorded result without the field reads as nothing refused.
    for rec in recordings() {
        let fx = rec.label("stream-json/simple.jsonl");
        let events = rec.jsonl("stream-json/simple.jsonl");
        let (_, _, outcome) = replay(&fx, &events);
        assert!(outcome.cli.refused_calls.is_empty(), "[{fx}]");
    }
}

#[test]
fn recorded_failures_are_never_read_as_refused_settings() {
    use crate::orchestrator::cli_runner::is_settings_refused;
    for rec in recordings() {
        let rel = "stream-json/error-unknown-model.jsonl";
        let fx = rec.label(rel);
        let events = rec.jsonl(rel);
        let line = serde_json::to_string(result_event(&fx, &events)).unwrap();
        let outcome = parse_cli_result(&line, false, ArtifactKind::Diff, "").unwrap();
        let err = outcome.error.as_deref().unwrap_or_default();
        assert!(!is_settings_refused(err), "[{fx}] {err}");
    }
}

#[test]
fn recorded_results_without_a_terminal_reason_are_never_read_as_deferred() {
    use crate::orchestrator::cli_runner::{is_deferred_tool_unavailable, is_tool_deferred};
    for rec in recordings() {
        for rel in ["stream-json/simple.jsonl", "stream-json/tool-use.jsonl", "stream-json/resume.jsonl", "stream-json/error-unknown-model.jsonl"] {
            let fx = rec.label(rel);
            let events = rec.jsonl(rel);
            let r = result_event(&fx, &events);
            if r.get("terminal_reason").is_some() {
                continue; // a newer recording; the deferred fixtures cover the field
            }
            let line = serde_json::to_string(r).unwrap();
            for exit_success in [true, false] {
                let o = parse_cli_result(&line, exit_success, ArtifactKind::Diff, "").unwrap();
                let err = o.error.as_deref().unwrap_or_default();
                assert!(!is_tool_deferred(err) && !is_deferred_tool_unavailable(err), "[{fx}] {err}");
            }
        }
    }
}

#[test]
fn synthetic_fixture_directories_are_not_recordings() {
    let names: Vec<String> = recordings().into_iter().map(|r| r.version).collect();
    for v in [DEFERRED_VERSION, SUBAGENT_MODEL_VERSION] {
        assert!(!names.iter().any(|n| n == v), "{names:?}");
        assert_eq!(synthesized(v).version, v);
    }
}

const SUBAGENT_MODEL_VERSION: &str = "2.1.325";

#[test]
#[serial_test::serial(pricing_catalog)]
fn stream_json_synthetic_error_message_is_never_unpriced() {
    use crate::orchestrator::cli_runner::{is_usage_unreported, stopped_stage, streamed_estimate, CliUsage};
    let _cfg = crate::provider_router::TestConfigDir::new();
    // Recorded: Claude Code's own model_not_found error message, stamped
    // `message.model: "<synthetic>"` with zero usage.
    let rec = recording("2.1.314");
    let rel = "stream-json/error-unknown-model.jsonl";
    let fx = rec.label(rel);
    let events = rec.jsonl(rel);
    let synthetic = of_type(&events, "assistant")
        .into_iter()
        .find(|e| e.pointer("/message/model").and_then(Value::as_str) == Some("<synthetic>"))
        .unwrap_or_else(|| panic!("[{fx}] no <synthetic> assistant message"));
    let (id, u) = usage_from_stream_event(synthetic).unwrap();
    assert_eq!(u.model.as_deref(), Some("<synthetic>"), "[{fx}]");
    // Alone, and beside a priced message of the stage's model.
    let mut map: HashMap<String, CliUsage> = HashMap::new();
    map.insert(id.unwrap(), u);
    assert!(streamed_estimate("claude-opus-5", &map).unpriced.is_empty(), "[{fx}]");
    let priced = CliUsage { input_tokens: 1_000, output_tokens: 100, model: Some("claude-opus-5".into()), ..Default::default() };
    map.insert("msg_priced".into(), priced);
    let est = streamed_estimate("claude-opus-5", &map);
    assert!(est.unpriced.is_empty(), "[{fx}] {:?}", est.unpriced);
    let out = stopped_stage(CliDialect::Claude, "Stopped by the director", "claude-opus-5", &map, false);
    assert_eq!(out.error.as_deref(), Some("Stopped by the director"), "[{fx}]");
    assert!(!is_usage_unreported(out.error.as_deref().unwrap()));
    // A token-less message on an unknown model is not unpriced either.
    map.insert("msg_empty".into(), CliUsage { model: Some("claude-mystery-9".into()), ..Default::default() });
    assert!(streamed_estimate("claude-opus-5", &map).unpriced.is_empty(), "[{fx}]");
}

#[test]
#[serial_test::serial(pricing_catalog)]
fn stream_json_stopped_stage_prices_a_subagent_at_its_own_model() {
    use crate::orchestrator::cli_runner::{is_usage_unreported, stopped_stage, streamed_cost, CliUsage};
    // Isolated catalog: never the owner's ~/.octopush/providers.json.
    let _cfg = crate::provider_router::TestConfigDir::new();
    // Synthetic (see the 2.1.325 README): an Opus stage stopped while its
    // Haiku subagent was mid-message — no `result` event.
    let rec = synthesized(SUBAGENT_MODEL_VERSION);
    let rel = "stream-json/stopped-with-subagent.jsonl";
    let fx = rec.label(rel);
    let events = rec.jsonl(rel);
    assert!(!events.iter().any(is_result_event), "[{fx}] a stopped stage has no result event");
    // Latest usage per message id, exactly as `CliRunner::run` keeps it.
    let mut map: HashMap<String, CliUsage> = HashMap::new();
    for e in of_type(&events, "assistant") {
        let model = require_str(&fx, e, "message.model");
        let (id, u) = usage_from_stream_event(e).unwrap();
        assert_eq!(u.model.as_deref(), Some(model), "[{fx}]");
        map.insert(id.unwrap(), u);
    }
    assert_eq!(map.len(), 2, "[{fx}] two messages, one of them in two content blocks");
    // Opus 5 at $5/$25 per M, Haiku 4.5 at $1/$5 per M, each on its own.
    let opus = (1_000.0 * 5.0 + 100.0 * 25.0) / 1e6;
    let haiku = (20_000.0 * 1.0 + 2_000.0 * 5.0) / 1e6;
    let c = streamed_cost("claude-opus-5", &map);
    assert!((c - (opus + haiku)).abs() < 1e-12, "[{fx}] {c}, not {}", opus + haiku);
    let out = stopped_stage(CliDialect::Claude, "Stopped by the director", "claude-opus-5", &map, false);
    assert_eq!(out.error.as_deref(), Some("Stopped by the director"), "[{fx}] every message was priced");
    assert!(!is_usage_unreported(out.error.as_deref().unwrap()));
    assert_eq!((out.input_tokens, out.output_tokens), (21_000, 2_100), "[{fx}]");
    assert!((out.cost_usd - (opus + haiku)).abs() < 1e-12, "[{fx}] {}", out.cost_usd);
}

#[test]
fn stream_json_argv_flags_are_all_known_to_the_cli() {
    for rec in recordings() {
        let fx = rec.label("cli-help.txt");
        let help = rec.text("cli-help.txt");
        let effort = || CliDialect::Claude.effort_args("claude-haiku-4-5", Some(crate::providers::Effort::High));
        for argv in [
            [build_cli_args("claude-haiku-4-5", "system", 3, true), effort()].concat(),
            [build_cli_args_resume("claude-haiku-4-5", "aaaaaaaa-0000-4000-8000-000000000001", 3, true), effort()].concat(),
        ] {
            if let Err(e) = flags_documented(&fx, &help, &argv, CLI_HIDDEN_FLAGS) {
                panic!("{e}");
            }
        }
        for value in ["stream-json", "bypassPermissions"] {
            assert!(help.contains(value), "[{fx}] `claude --help` no longer mentions `{value}`");
        }
        // `--effort <level>` lists its levels; every `Effort` token must be one.
        let line = help.lines().skip_while(|l| !l.trim_start().starts_with("--effort")).take(3).collect::<String>();
        for e in [
            crate::providers::Effort::Low,
            crate::providers::Effort::Medium,
            crate::providers::Effort::High,
            crate::providers::Effort::Xhigh,
            crate::providers::Effort::Max,
        ] {
            assert!(line.contains(e.as_str()), "[{fx}] `claude --help` --effort no longer lists `{}`: {line}", e.as_str());
        }
    }
}

/// Flags Octopush passes that `claude --help` does not list but the CLI
/// accepts — the recordings themselves were made with them (see the README).
const CLI_HIDDEN_FLAGS: &[&str] = &["--max-turns"];

/// Every `-x` / `--xyz` in `argv` (up to a bare `--`) appears in the help
/// text as a flag token, or is a known hidden flag.
fn flags_documented(fixture: &str, help: &str, argv: &[String], hidden: &[&str]) -> Result<(), String> {
    for a in argv.iter().take_while(|a| a.as_str() != "--") {
        if !a.starts_with('-') || hidden.contains(&a.as_str()) {
            continue;
        }
        let documented = help.match_indices(a.as_str()).any(|(i, _)| {
            let before = help[..i].chars().last();
            let after = help[i + a.len()..].chars().next();
            matches!(before, Some(' ') | Some('\n') | None) && matches!(after, Some(' ') | Some(',') | Some('\n') | None)
        });
        if !documented {
            return Err(format!(
                "[{fixture}] Claude Code contract broken: flag `{a}` that Octopush passes is not in the CLI's help"
            ));
        }
    }
    Ok(())
}

#[test]
fn stream_json_missing_fields_degrade_without_panicking() {
    let rec = recordings().pop().unwrap();
    let fx = rec.label("stream-json/tool-use.jsonl");
    let events = rec.jsonl("stream-json/tool-use.jsonl");
    let assistant = of_type(&events, "assistant")[0].clone();

    // usage gone → no streamed estimate, and the helper names the field.
    let mut no_usage = assistant.clone();
    no_usage["message"].as_object_mut().unwrap().remove("usage");
    assert!(usage_from_stream_event(&no_usage).is_none());
    let err = try_require(&fx, &no_usage, "message.usage.input_tokens").unwrap_err();
    assert!(err.contains(&fx) && err.contains("message.usage.input_tokens"), "{err}");

    // content gone → no journal entries (not a panic).
    let mut no_content = assistant.clone();
    no_content["message"].as_object_mut().unwrap().remove("content");
    assert!(entries_from_stream_event(&no_content).is_empty());

    // `type` gone from the result → not recognised as the terminal event.
    let mut result = result_event(&fx, &events).clone();
    result.as_object_mut().unwrap().remove("type");
    assert!(!is_result_event(&result));

    // A truncated result line is an Err, never a panic.
    let line = serde_json::to_string(result_event(&fx, &events)).unwrap();
    assert!(parse_cli_result(&line[..line.len() / 2], true, ArtifactKind::Note, "").is_err());
}

// ─── Settling after `result` (background work keeps `-p` open) ───────────

/// Short limits so a settle is observable in a test; idle and cap far away.
const TEST_LIMITS: ReadLimits = ReadLimits {
    idle: std::time::Duration::from_secs(20),
    command_idle: std::time::Duration::from_secs(20),
    cap: std::time::Duration::from_secs(60),
    settle: std::time::Duration::from_millis(150),
};

/// Feed `stream` to the production read loop, bounded so a regression that
/// waits for EOF fails instead of hanging. Returns the end and the number of
/// JSON events handed to `on_event`.
async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(stream: R, dialect: CliDialect) -> (ReadEnd, usize, std::time::Duration) {
    let started = std::time::Instant::now();
    let mut seen = 0usize;
    let end = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        read_stream(stream, dialect, TEST_LIMITS, |_| seen += 1, |_| {}),
    )
    .await
    .expect("read_stream did not settle — it is waiting for the process to exit");
    (end, seen, started.elapsed())
}

/// A recorded stream as stdout bytes, newline-terminated so its last line is
/// complete even when more output (or none) follows on the same pipe.
fn stdout_bytes(rec: &Rec, rel: &str) -> std::io::Cursor<Vec<u8>> {
    let mut bytes = rec.text(rel).into_bytes();
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    std::io::Cursor::new(bytes)
}

#[tokio::test]
async fn stream_json_result_then_an_open_process_settles_with_the_result_usage() {
    use tokio::io::AsyncReadExt;
    for rec in recordings() {
        let fx = rec.label("stream-json/simple.jsonl");
        let events = rec.jsonl("stream-json/simple.jsonl");
        // The recorded stream, then a stdout that stays open and silent —
        // `claude -p` waiting on a background dev server.
        let (_still_open, rx) = tokio::io::duplex(64);
        let stream = stdout_bytes(&rec, "stream-json/simple.jsonl").chain(rx);
        let (end, seen, took) = read_bounded(stream, CliDialect::Claude).await;
        let ReadEnd::Settled(line, _) = end else {
            panic!("[{fx}] expected the stage to settle after its result, got {end:?}");
        };
        assert_eq!(seen, events.len(), "[{fx}] every event still reaches the journal/usage handler");
        assert!(took < std::time::Duration::from_secs(5), "[{fx}] settled after {took:?}");
        let outcome = parse_cli_result(&line, true, ArtifactKind::Note, "")
            .unwrap_or_else(|e| panic!("[{fx}] parse_cli_result rejected the settled line: {e}"));
        assert_eq!(outcome.status, StageStatus::Done, "[{fx}] {:?}", outcome.error);
        let r = result_event(&fx, &events);
        assert_eq!(outcome.input_tokens, require_u64(&fx, r, "usage.input_tokens"), "[{fx}]");
        assert_eq!(outcome.output_tokens, require_u64(&fx, r, "usage.output_tokens"), "[{fx}]");
        assert!(outcome.cost_usd > 0.0, "[{fx}] total_cost_usd not carried");
    }
}

#[tokio::test]
async fn stream_json_output_after_result_does_not_hold_the_stage_open() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rec = recordings().pop().unwrap();
    let fx = rec.label("stream-json/simple.jsonl");
    // A background server that keeps logging: each line would reset an idle
    // timer, but the settle grace counts from the result.
    let (mut server, rx) = tokio::io::duplex(1024);
    let logger = tokio::spawn(async move {
        while server.write_all(b"[vite] page reload src/App.tsx\n").await.is_ok() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    });
    let stream = stdout_bytes(&rec, "stream-json/simple.jsonl").chain(rx);
    let (end, _, took) = read_bounded(stream, CliDialect::Claude).await;
    logger.abort();
    assert!(matches!(end, ReadEnd::Settled(..)), "[{fx}] expected a settle, got {end:?}");
    assert!(took < std::time::Duration::from_secs(5), "[{fx}] settled after {took:?}");
}

#[tokio::test]
async fn stream_json_result_then_eof_is_a_clean_exit_not_a_settle() {
    let rec = recordings().pop().unwrap();
    let fx = rec.label("stream-json/simple.jsonl");
    let stream = stdout_bytes(&rec, "stream-json/simple.jsonl");
    let (end, _, _) = read_bounded(stream, CliDialect::Claude).await;
    assert!(matches!(end, ReadEnd::Eof(Some(_), _)), "[{fx}] got {end:?}");
}

#[test]
fn claude_stage_env_ceils_background_waits_below_the_settle_grace() {
    let env = CliDialect::Claude.stage_env();
    let ceiling = env
        .iter()
        .find(|(k, _)| *k == "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS")
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| panic!("no background-wait ceiling in {env:?}"));
    assert_eq!(ceiling, "25000");
    assert_eq!(ReadLimits::STAGE.settle, std::time::Duration::from_secs(30));
    // The CLI's own clean exit must come before the runner stops it.
    let ceiling = std::time::Duration::from_millis(ceiling.parse().unwrap());
    assert!(ceiling < ReadLimits::STAGE.settle, "{ceiling:?} ≥ {:?}", ReadLimits::STAGE.settle);
    assert!(CliDialect::Codex.stage_env().is_empty());
}

#[test]
fn claude_stage_env_disables_fast_mode() {
    let env = CliDialect::Claude.stage_env();
    let fast = env.iter().find(|(k, _)| *k == "CLAUDE_CODE_DISABLE_FAST_MODE").map(|(_, v)| v.as_str());
    assert_eq!(fast, Some("1"), "{env:?}");
    assert!(!CliDialect::Codex.stage_env().iter().any(|(k, _)| *k == "CLAUDE_CODE_DISABLE_FAST_MODE"));
}

#[test]
fn claude_stage_env_keeps_mcp_tasks_inside_their_tool_call() {
    // 2.1.319 backgrounds MCP tasks right away; a stage settled on its
    // `result` must not hand on work still running. `stage_env` takes no
    // resume flag, so fresh and `--resume` spawns get the same pin.
    let env = CliDialect::Claude.stage_env();
    let pin = env
        .iter()
        .find(|(k, _)| *k == "CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND")
        .map(|(_, v)| v.as_str());
    assert_eq!(pin, Some("1"), "{env:?}");
    assert!(!CliDialect::Codex.stage_env().iter().any(|(k, _)| *k == "CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND"));
}

#[test]
fn claude_stage_env_keeps_the_skills_the_stage_started_with() {
    // 2.1.321 reloads `.claude/skills` in headless sessions when their files
    // change; a stage writing its own worktree must not rewrite its own rules.
    // `stage_env` takes no resume flag, so fresh and `--resume` spawns match.
    let env = CliDialect::Claude.stage_env();
    let pin = env.iter().find(|(k, _)| *k == "CLAUDE_CODE_PLUGIN_DIR_WATCH").map(|(_, v)| v.as_str());
    assert_eq!(pin, Some("0"), "{env:?}");
    assert!(!CliDialect::Codex.stage_env().iter().any(|(k, _)| *k == "CLAUDE_CODE_PLUGIN_DIR_WATCH"));
}

// ─── Gateway models' context window (#790) ──
//
// 2.1.323: "Changed the context window assumed for a model ID that Claude
// Code doesn't recognize from 200K to 1M; use `/autocompact` to compact
// earlier, or `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` to keep 200K" and "Changed
// sessions on other vendors' models with a smaller window: once full, they
// can fail every turn until `/clear`, so set `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`
// before they fill". 2.1.325: "Changed `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to
// also set the context window of unrecognized model IDs that start with
// `claude-`, such as a gateway's `claude-sonnet-latest`".

#[test]
fn context_window_variables_are_the_documented_names() {
    assert_eq!(MAX_CONTEXT_TOKENS_ENV, "CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    assert_eq!(DISABLE_1M_CONTEXT_ENV, "CLAUDE_CODE_DISABLE_1M_CONTEXT");
}

#[test]
fn a_builtin_claude_model_gets_no_context_window_variable() {
    // Claude Code knows the builtin catalog's ids and their windows, also
    // behind a gateway or Bedrock prefix (the builtin check normalizes).
    for model in [
        "claude-sonnet-5",
        "claude-opus-5-5",
        "claude-haiku-4-5",
        "bedrock/claude-haiku-4-5",
        "us.anthropic.claude-haiku-4-5-v1:0",
    ] {
        assert!(is_builtin_claude_model(model), "{model}");
        let env = stage_spawn_env_for(model);
        assert!(!env.contains_key(MAX_CONTEXT_TOKENS_ENV) && !env.contains_key(DISABLE_1M_CONTEXT_ENV), "{model}: {env:?}");
    }
    assert!(!is_builtin_claude_model("claude-sonnet-latest"));
    assert!(!is_builtin_claude_model("gpt-4o"));
    assert!(context_window_env("claude-haiku-4-5", true, Some(200_000), None, |_| false).is_empty());
}

#[test]
fn a_gateway_model_gets_the_variable_for_its_window() {
    let none = |_: &str| false;
    let max = |w: &str| (MAX_CONTEXT_TOKENS_ENV, w.to_string());
    let disable = (DISABLE_1M_CONTEXT_ENV, "1".to_string());
    // Ids that don't start with `claude-` already honoured the max-tokens
    // variable before 2.1.325 (that entry says it "also" covers `claude-`
    // ids): never the process-wide DISABLE_1M switch, whatever the CLI version.
    for v in [None, Some("2.1.323"), Some("2.1.325")] {
        assert_eq!(context_window_env("gpt-4o", false, Some(128_000), v, none), vec![max("128000")], "{v:?}");
        assert_eq!(context_window_env("kimi-k3", false, Some(512_000), v, none), vec![max("512000")], "{v:?}");
    }
    // A `claude-` gateway id on 2.1.325+: the variable alone.
    let new = Some("2.1.325");
    assert_eq!(context_window_env("claude-sonnet-latest", false, Some(200_000), new, none), vec![max("200000")]);
    assert_eq!(context_window_env("claude-internal-128k", false, Some(128_000), Some("2.2.0"), none), vec![max("128000")]);
    assert_eq!(context_window_env("claude-gateway-512k", false, Some(512_000), new, none), vec![max("512000")]);
    // Below 2.1.325 (or an unknown version) Claude Code ignores it for a
    // `claude-` id, so a window up to 200K also keeps 200K; below 200K
    // can't be expressed there, and 200K–1M gets only the ignored variable.
    for old in [Some("2.1.323"), Some("2.1.324"), None] {
        assert_eq!(
            context_window_env("claude-sonnet-latest", false, Some(200_000), old, none),
            vec![max("200000"), disable.clone()],
            "{old:?}"
        );
        assert_eq!(
            context_window_env("claude-internal-128k", false, Some(128_000), old, none),
            vec![max("128000"), disable.clone()],
            "{old:?}"
        );
        assert_eq!(context_window_env("claude-gateway-512k", false, Some(512_000), old, none), vec![max("512000")], "{old:?}");
    }
    // A 1M window and an unknown one: nothing.
    assert!(context_window_env("claude-sonnet-latest", false, Some(1_000_000), new, none).is_empty());
    assert!(context_window_env("gpt-4o", false, Some(1_000_000), new, none).is_empty());
    assert!(context_window_env("claude-sonnet-latest", false, None, None, none).is_empty());
    assert!(context_window_env("claude-sonnet-latest", false, Some(0), None, none).is_empty());
}

#[test]
fn a_users_own_context_window_export_is_never_overridden() {
    let set = |k: &str| k == MAX_CONTEXT_TOKENS_ENV;
    assert!(context_window_env("claude-sonnet-latest", false, Some(200_000), Some("2.1.325"), set).is_empty());
    assert!(context_window_env("gpt-4o", false, Some(128_000), None, set).is_empty());
    // Only the variable the user set is left alone.
    assert_eq!(
        context_window_env("claude-sonnet-latest", false, Some(200_000), Some("2.1.323"), set),
        vec![(DISABLE_1M_CONTEXT_ENV, "1".to_string())]
    );
    let set = |k: &str| k == DISABLE_1M_CONTEXT_ENV;
    assert_eq!(
        context_window_env("claude-sonnet-latest", false, Some(200_000), Some("2.1.323"), set),
        vec![(MAX_CONTEXT_TOKENS_ENV, "200000".to_string())]
    );
}

#[test]
fn codex_stages_get_no_context_window_variable() {
    let mut command = tokio::process::Command::new("codex");
    apply_stage_env(&mut command, CliDialect::Codex, "gpt-4o", None, false, None);
    let keys: Vec<String> = command.as_std().get_envs().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    assert!(!keys.iter().any(|k| k == MAX_CONTEXT_TOKENS_ENV || k == DISABLE_1M_CONTEXT_ENV), "{keys:?}");
}

#[test]
fn a_custom_gateway_model_reaches_the_spawn_with_its_catalog_window() {
    // The user's own provider entry (a LiteLLM gateway) gives the window.
    let cfg = crate::provider_router::TestConfigDir::new();
    let model = |id: &str, ctx: u64| {
        serde_json::json!({"id": id, "displayName": id, "inputCostPerM": 3.0, "outputCostPerM": 15.0, "maxContext": ctx})
    };
    let providers = serde_json::json!([{
        "name": "gateway", "apiBase": "https://gateway.example", "apiKeyEnv": "GATEWAY_KEY", "enabled": true,
        "models": [model("claude-sonnet-latest", 200_000), model("team-llama", 128_000), model("claude-sonnet-5", 100_000)],
    }]);
    std::fs::write(cfg.path().join("providers.json"), providers.to_string()).unwrap();
    // (Whether DISABLE_1M joins it depends on the probed CLI version; the
    // pure `context_window_env` tests pin that.)
    let env = stage_spawn_env_for("claude-sonnet-latest");
    assert_eq!(env.get(MAX_CONTEXT_TOKENS_ENV), Some(&Some("200000".to_string())), "{env:?}");
    let env = stage_spawn_env_for("team-llama");
    assert_eq!(env.get(MAX_CONTEXT_TOKENS_ENV), Some(&Some("128000".to_string())), "{env:?}");
    assert!(!env.contains_key(DISABLE_1M_CONTEXT_ENV), "a non-`claude-` id never gets the process-wide switch");
    // A builtin id stays untouched even when a custom entry repeats it.
    let env = stage_spawn_env_for("claude-sonnet-5");
    assert!(!env.contains_key(MAX_CONTEXT_TOKENS_ENV) && !env.contains_key(DISABLE_1M_CONTEXT_ENV), "{env:?}");
    // An id no catalog lists: nothing.
    let env = stage_spawn_env_for("claude-unknown-gateway");
    assert!(!env.contains_key(MAX_CONTEXT_TOKENS_ENV) && !env.contains_key(DISABLE_1M_CONTEXT_ENV), "{env:?}");
}

/// [`stage_spawn_env`] for a Claude stage on `model`.
fn stage_spawn_env_for(model: &str) -> HashMap<String, Option<String>> {
    let mut command = tokio::process::Command::new("claude");
    apply_stage_env(&mut command, CliDialect::Claude, model, None, false, None);
    command
        .as_std()
        .get_envs()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
        .collect()
}

#[test]
fn claude_stage_env_turns_off_subagent_progress_summaries() {
    // 2.1.323: "Added `CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES` (available
    // since 2.1.318): set it to `1` to turn off subagent progress summaries and
    // the requests that write them". No stage reads them (#722).
    const KEY: &str = "CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES";
    let env = CliDialect::Claude.stage_env();
    assert_eq!(env.iter().find(|(k, _)| *k == KEY).map(|(_, v)| v.as_str()), Some("1"), "{env:?}");
    assert!(!CliDialect::Codex.stage_env().iter().any(|(k, _)| *k == KEY));
    // Set on the spawn whatever the quiet opt-in or effort, so a fresh and a
    // `--resume` run (one `apply_stage_env`, no resume flag) both get it, over
    // any inherited value; it's never removed.
    for (effort, quiet) in [(None, false), (Some(crate::providers::Effort::High), true)] {
        let spawn = stage_spawn_env(CliDialect::Claude, effort, quiet);
        assert_eq!(spawn.get(KEY), Some(&Some("1".to_string())), "{spawn:?}");
    }
    assert!(!stage_spawn_env(CliDialect::Codex, None, true).contains_key(KEY));
    // No stream event is read as a progress summary: a `task_summary`-style
    // system event journals nothing.
    let summary = serde_json::json!({"type": "system", "subtype": "task_summary", "summary": "Reading files"});
    assert!(entries_from_stream_event(&summary).is_empty());
}

// ─── Quiet Claude Code (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, #703) ──

/// The stage process's explicit env after [`apply_stage_env`]: `Some(v)` for a
/// set variable, `None` for a removed one; absent keys are inherited.
fn stage_spawn_env(
    dialect: CliDialect,
    effort: Option<crate::providers::Effort>,
    quiet: bool,
) -> HashMap<String, Option<String>> {
    let mut command = tokio::process::Command::new("claude");
    apply_stage_env(&mut command, dialect, "claude-sonnet-5", effort, quiet, None);
    command
        .as_std()
        .get_envs()
        .map(|(k, v)| {
            (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))
        })
        .collect()
}

#[test]
fn quiet_claude_code_sets_the_documented_variable_on_claude_stages_only() {
    assert_eq!(QUIET_TRAFFIC_ENV, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
    assert_eq!(CliDialect::Claude.stage_quiet_env(true), vec![(QUIET_TRAFFIC_ENV, "1".to_string())]);
    // Off writes nothing: the docs say even `0`/`false` still disables the
    // traffic, so the only off state is the variable left alone.
    assert!(CliDialect::Claude.stage_quiet_env(false).is_empty());
    assert!(CliDialect::Codex.stage_quiet_env(true).is_empty());
    assert!(CliDialect::Codex.stage_quiet_env(false).is_empty());
    // The quiet pin is its own opt-in, never part of the always-on pins.
    assert!(!CliDialect::Claude.stage_env().iter().any(|(k, _)| *k == QUIET_TRAFFIC_ENV));
}

#[test]
fn quiet_claude_code_reaches_a_fresh_stage_spawn() {
    // A fresh stage: no session, usually no effort override.
    for effort in [None, Some(crate::providers::Effort::Medium)] {
        let on = stage_spawn_env(CliDialect::Claude, effort, true);
        assert_eq!(on.get(QUIET_TRAFFIC_ENV), Some(&Some("1".to_string())), "fresh, effort {effort:?}: {on:?}");
        let off = stage_spawn_env(CliDialect::Claude, effort, false);
        assert!(!off.contains_key(QUIET_TRAFFIC_ENV), "fresh off must neither set nor remove it: {off:?}");
        // The always-on pins ride along either way.
        assert_eq!(on.get("CLAUDE_CODE_DISABLE_FAST_MODE"), Some(&Some("1".to_string())));
        assert_eq!(off.get("CLAUDE_CODE_DISABLE_FAST_MODE"), Some(&Some("1".to_string())));
    }
}

#[test]
fn quiet_claude_code_reaches_a_resumed_stage_spawn() {
    // A `--resume` run builds a different argv but spawns through the same
    // `apply_stage_env`, which takes no resume flag: the env must match the
    // fresh run's exactly, quiet pin included.
    use crate::providers::Effort;
    let fresh_args = build_cli_args("claude-sonnet-5", "sys", 25, false);
    let resume_args = build_cli_args_resume("claude-sonnet-5", "sess-1", 25, false);
    assert!(resume_args.iter().any(|a| a == "--resume"), "{resume_args:?}");
    assert!(!fresh_args.iter().chain(&resume_args).any(|a| a.contains(QUIET_TRAFFIC_ENV)), "never an argv flag");
    for effort in [None, Some(Effort::High)] {
        let resumed = stage_spawn_env(CliDialect::Claude, effort, true);
        assert_eq!(resumed.get(QUIET_TRAFFIC_ENV), Some(&Some("1".to_string())), "resumed, effort {effort:?}");
        assert_eq!(resumed, stage_spawn_env(CliDialect::Claude, effort, true), "deterministic");
        assert!(!stage_spawn_env(CliDialect::Claude, effort, false).contains_key(QUIET_TRAFFIC_ENV));
    }
    // The effort override still drops the user's inherited export beside it.
    let resumed = stage_spawn_env(CliDialect::Claude, Some(Effort::High), true);
    assert_eq!(resumed.get("CLAUDE_CODE_EFFORT_LEVEL"), Some(&None));
}

#[test]
fn quiet_claude_code_never_reaches_a_codex_stage_spawn() {
    for effort in [None, Some(crate::providers::Effort::High)] {
        for quiet in [true, false] {
            let env = stage_spawn_env(CliDialect::Codex, effort, quiet);
            assert!(!env.contains_key(QUIET_TRAFFIC_ENV), "codex, quiet {quiet}: {env:?}");
        }
    }
}

// ─── Codex CLI effort (`-c model_reasoning_effort`) ──────────────────────

/// A writer outside a sandboxed mission.
const CODEX_WS: CodexWriteScope = CodexWriteScope::Workspace;

#[test]
fn codex_writer_runs_in_its_workspace_write_sandbox() {
    use crate::providers::Effort;
    let head = ["exec", "--json", "--skip-git-repo-check", "-m", "gpt-6.1-terra"];
    // Only `--sandbox` is a flag (the read-only path has always passed it);
    // the rest are `-c` config overrides, which `codex exec` takes like the
    // effort, rather than `--ask-for-approval`/`--add-dir`, which it may not.
    let sandbox = [
        "--sandbox",
        "workspace-write",
        "-c",
        "approval_policy=\"never\"",
        "-c",
        "sandbox_workspace_write.network_access=true",
    ];
    let plain = CliDialect::Codex.argv("gpt-6.1-terra", "system", 25, false, CODEX_WS);
    assert_eq!(plain, [&head[..], &sandbox[..], &["-"][..]].concat(), "{plain:?}");
    assert!(!plain.iter().any(|a| a == "--ask-for-approval" || a == "--add-dir"), "{plain:?}");
    // No extra writable roots: Codex can't deny a path inside one, so a
    // worktree's git dir (its `commondir`, `config.worktree`) is never granted.
    assert!(!plain.iter().any(|a| a.contains("writable_roots") || a.contains(".git")), "{plain:?}");
    // The effort override sits after the sandbox settings, before the stdin marker.
    let mut argv = plain.clone();
    CliDialect::Codex.push_effort_args(&mut argv, "gpt-6.1-terra", Some(Effort::High));
    let effort = ["-c", "model_reasoning_effort=\"high\""];
    assert_eq!(argv, [&head[..], &sandbox[..], &effort[..], &["-"][..]].concat(), "{argv:?}");
    // Inside a sandboxed mission the bypass flag stays (Seatbelt confines it).
    let mission = CliDialect::Codex.argv("gpt-6.1-terra", "system", 25, false, CodexWriteScope::MissionSandbox);
    assert_eq!(mission, [&head[..], &["--dangerously-bypass-approvals-and-sandbox", "-"][..]].concat(), "{mission:?}");
    // Read-only is unchanged, in or out of a sandboxed mission (inside one the
    // stage is refused before launch: Codex's sandbox can't nest there).
    for scope in [CODEX_WS, CodexWriteScope::MissionSandbox] {
        let ro = CliDialect::Codex.argv("gpt-6.1-terra", "system", 25, true, scope);
        assert_eq!(ro, [&head[..], &["--sandbox", "read-only", "-"][..]].concat(), "{ro:?}");
    }
}

#[test]
fn codex_argv_carries_the_effort_override_before_the_stdin_marker() {
    use crate::providers::Effort;
    for read_only in [false, true] {
        let mut argv = CliDialect::Codex.argv("gpt-5.5", "system", 25, read_only, CODEX_WS);
        CliDialect::Codex.push_effort_args(&mut argv, "gpt-5.5", Some(Effort::High));
        let n = argv.len();
        assert_eq!(argv[n - 1], "-", "the prompt still comes from stdin: {argv:?}");
        assert_eq!(argv[n - 3..n - 1], ["-c", "model_reasoning_effort=\"high\""], "{argv:?}");
        assert_eq!(argv[..2], ["exec", "--json"], "{argv:?}");
        // A one-off override, nothing in the environment.
        assert!(CliDialect::Codex.stage_effort_env(Some(Effort::High)).is_empty());
        assert!(CliDialect::Codex.stage_env_remove(Some(Effort::High)).is_empty());
    }
}

#[test]
fn codex_argv_without_an_effort_keeps_codexs_own_default() {
    let plain = CliDialect::Codex.argv("gpt-5.5", "system", 25, false, CODEX_WS);
    let mut argv = plain.clone();
    CliDialect::Codex.push_effort_args(&mut argv, "gpt-5.5", None);
    assert_eq!(argv, plain);
    assert!(!argv.iter().any(|a| a.contains("model_reasoning_effort")), "{argv:?}");
}

#[test]
fn codex_argv_on_a_model_outside_the_catalog_carries_no_override() {
    // Codex sends the level to the API unchanged, so on a model whose levels
    // its catalog doesn't list (gpt-5-codex, o3, a non-reasoning model) the
    // stage keeps Codex's default rather than risk a rejected level.
    use crate::providers::Effort;
    for model in ["gpt-5-codex", "o3", "o4-mini", "gpt-4o"] {
        for effort in [Effort::Low, Effort::High, Effort::Xhigh, Effort::Max] {
            let plain = CliDialect::Codex.argv(model, "system", 25, false, CODEX_WS);
            let mut argv = plain.clone();
            CliDialect::Codex.push_effort_args(&mut argv, model, Some(effort));
            assert_eq!(argv, plain, "[{model} {effort:?}]");
            assert!(!argv.iter().any(|a| a.contains("model_reasoning_effort")), "{argv:?}");
        }
    }
}

#[test]
fn codex_argv_maps_max_to_the_models_top_level() {
    use crate::providers::Effort;
    // Levels per Codex's catalog (models.json @ a7a9d82): gpt-5.5 tops out at
    // xhigh; gpt-5.6-sol, gpt-6.1-terra and codex-auto-review list max.
    for (model, level) in [("gpt-5.5", "xhigh"), ("gpt-6.1-terra", "max"), ("gpt-5.6-sol", "max"), ("codex-auto-review", "max")] {
        let mut argv = CliDialect::Codex.argv(model, "system", 25, false, CODEX_WS);
        CliDialect::Codex.push_effort_args(&mut argv, model, Some(Effort::Max));
        let want = format!("model_reasoning_effort=\"{level}\"");
        assert!(argv.contains(&want), "[{model}] {argv:?}");
    }
}

#[test]
fn claude_argv_appends_the_effort_flag_at_the_end() {
    use crate::providers::Effort;
    let mut argv = build_cli_args_resume("claude-haiku-4-5", "aaaaaaaa-0000-4000-8000-000000000001", 3, false);
    CliDialect::Claude.push_effort_args(&mut argv, "claude-haiku-4-5", Some(Effort::Low));
    assert_eq!(argv[argv.len() - 2..], ["--effort", "low"], "{argv:?}");
}

// ─── `rate_limit_event` → Claude plan windows ────────────────────────────

const SUBSCRIBER_REL: &str = "stream-json/subscriber-rate-limit.jsonl";

#[test]
fn rate_limit_event_reduced_to_its_type_yields_no_plan_windows() {
    // The real recordings ran on an API key; their rate-limit events are
    // type-only and must not invent a plan.
    for rec in recordings() {
        for rel in ["stream-json/simple.jsonl", "stream-json/tool-use.jsonl", "stream-json/resume.jsonl"] {
            let fx = rec.label(rel);
            let events = rec.jsonl(rel);
            assert!(!of_type(&events, "rate_limit_event").is_empty(), "[{fx}] expected a rate_limit_event");
            for e in &events {
                assert!(plan_windows_from_stream_event(e).is_empty(), "[{fx}] plan windows from {e}");
            }
        }
    }
}

#[test]
fn rate_limit_event_with_unified_windows_reports_both_windows() {
    // Synthetic fixture (see the README) — pinned to the recording that has it.
    let rec = recording("2.1.314");
    let fx = rec.label(SUBSCRIBER_REL);
    let events = rec.jsonl(SUBSCRIBER_REL);
    let init = events.iter().find(|e| e["subtype"] == "init").unwrap();
    assert_eq!(cli_auth_from_init(init), Some(CliAuth::Subscription), "[{fx}] apiKeySource none ⇒ a Claude plan");
    let rl = of_type(&events, "rate_limit_event");
    for f in ["status", "resetsAt", "rateLimitType"] {
        require(&fx, rl[0], &format!("rate_limit_info.{f}"));
    }
    let w = plan_windows_from_stream_event(rl[0]);
    assert_eq!(w.len(), 2, "[{fx}] {w:?}");
    assert_eq!(w[0].kind, "five_hour");
    assert_eq!(w[0].utilization, Some(0.62), "[{fx}] utilization from unifiedWindows");
    assert_eq!(w[0].resets_at, Some(1793551200));
    assert_eq!(w[0].status.as_deref(), Some("allowed"));
    assert_eq!(w[0].overage_status.as_deref(), Some("rejected"));
    assert!(!w[0].using_overage);
    assert_eq!(w[1].kind, "seven_day");
    assert_eq!(w[1].utilization, Some(0.31));
    assert_eq!(w[1].resets_at, Some(1793988000));
    assert_eq!(w[1].status.as_deref(), Some("allowed"), "[{fx}] nothing is limited ⇒ every window is allowed");
}

#[test]
fn rate_limit_event_without_unified_windows_uses_top_level_utilization() {
    let rec = recording("2.1.314");
    let fx = rec.label(SUBSCRIBER_REL);
    let events = rec.jsonl(SUBSCRIBER_REL);
    let rl = of_type(&events, "rate_limit_event");
    let w = plan_windows_from_stream_event(rl[1]);
    assert_eq!(w.len(), 1, "[{fx}] {w:?}");
    assert_eq!((w[0].kind.as_str(), w[0].utilization), ("five_hour", Some(0.84)));
    assert_eq!(w[0].status.as_deref(), Some("allowed_warning"));

    // Neither top-level nor unified utilization: the window is still kept.
    let w = plan_windows_from_stream_event(rl[2]);
    assert_eq!(w.len(), 1, "[{fx}] {w:?}");
    assert_eq!(w[0].kind, "seven_day_fixture_tier", "[{fx}] an unknown rateLimitType is kept as-is");
    assert_eq!(w[0].utilization, None);
    assert_eq!(w[0].status.as_deref(), Some("rejected"));
    assert!(w[0].using_overage);
}

// ─── A Claude plan wall (`rejected`) → plan-limit park (#731) ─────────────

const REJECTED_REL: &str = "stream-json/subscriber-rate-limit-rejected.jsonl";

/// Feed a fixture's events to the production plan-limit watch.
fn plan_watch(events: &[Value]) -> crate::orchestrator::cli_runner::PlanLimitWatch {
    let mut watch = crate::orchestrator::cli_runner::PlanLimitWatch::default();
    for e in events {
        watch.observe(e);
    }
    watch
}

#[test]
fn a_rejected_plan_window_halts_the_stage_as_a_plan_limit() {
    use crate::orchestrator::cli_runner::{apply_plan_limit, is_plan_limit, PlanLimit};
    let rec = recording("2.1.314");
    let fx = rec.label(REJECTED_REL);
    let events = rec.jsonl(REJECTED_REL);
    let init = events.iter().find(|e| e["subtype"] == "init").unwrap();
    assert_eq!(cli_auth_from_init(init), Some(CliAuth::Subscription), "[{fx}]");
    let rl = of_type(&events, "rate_limit_event");
    for f in ["status", "resetsAt", "rateLimitType", "isUsingOverage"] {
        require(&fx, rl[1], &format!("rate_limit_info.{f}"));
    }
    let notice = events.iter().find(|e| e["error"] == "rate_limit").expect("the CLI's limit notice");
    assert_eq!(notice["message"]["model"], "<synthetic>", "[{fx}]");

    let watch = plan_watch(&events);
    assert_eq!(
        watch.limit(),
        Some(&PlanLimit { window: "five_hour".into(), resets_at: 1793551200 }),
        "[{fx}] the rejected window and its reset"
    );

    let result = events.iter().find(|e| is_result_event(e)).unwrap().to_string();
    let parsed = parse_cli_result(&result, true, ArtifactKind::Diff, "").unwrap();
    let out = apply_plan_limit(parsed, &watch);
    assert!(matches!(out.status, StageStatus::Failed), "[{fx}] {:?}", out.status);
    let err = out.error.as_deref().unwrap();
    assert!(is_plan_limit(err), "[{fx}] {err}");
    assert!(err.starts_with("Paused by your Claude plan — the 5-hour window"), "[{fx}] {err}");
    assert!(err.contains("You've hit your 5-hour limit"), "[{fx}] the CLI's own words follow: {err}");
    assert_eq!(out.session_id.as_deref(), Some("aaaaaaaa-0000-4000-8000-000000000007"), "[{fx}] session kept for Resume");
    assert_eq!(out.cost_usd, 0.0045, "[{fx}] spend kept");
    assert_eq!(out.cli.plan_limit.as_ref().map(|l| l.resets_at), Some(1793551200));

    // A success-shaped result (`is_error: false`) whose reply is the limit
    // notice is the same stop, not finished work handed to the next stage.
    let mut ok = events.iter().find(|e| is_result_event(e)).unwrap().clone();
    ok["is_error"] = Value::Bool(false);
    let parsed = parse_cli_result(&ok.to_string(), true, ArtifactKind::Diff, "").unwrap();
    assert!(matches!(parsed.status, StageStatus::Done));
    let out = apply_plan_limit(parsed, &watch);
    assert!(matches!(out.status, StageStatus::Failed), "[{fx}] success-shaped stop");
    assert!(out.artifact.text.is_empty(), "[{fx}] the notice is not an artifact");
    assert!(out.cli.plan_limit.is_some());
}

#[test]
fn a_rejected_window_covered_by_extra_usage_is_not_a_plan_limit() {
    // `subscriber-rate-limit.jsonl`'s third event: rejected, but
    // `isUsingOverage: true` — extra usage serves the request.
    let rec = recording("2.1.314");
    let fx = rec.label(SUBSCRIBER_REL);
    let events = rec.jsonl(SUBSCRIBER_REL);
    let watch = plan_watch(&events);
    assert_eq!(watch.limit(), None, "[{fx}]");
    let result = events.iter().find(|e| is_result_event(e)).unwrap().to_string();
    let parsed = parse_cli_result(&result, true, ArtifactKind::Note, "").unwrap();
    let out = crate::orchestrator::cli_runner::apply_plan_limit(parsed, &watch);
    assert!(matches!(out.status, StageStatus::Done), "[{fx}] finished work is untouched");
    assert!(out.cli.plan_limit.is_none());
}

#[test]
fn a_window_allowed_again_clears_the_wall_and_other_failures_keep_their_cause() {
    use crate::orchestrator::cli_runner::apply_plan_limit;
    let rec = recording("2.1.314");
    let mut events = rec.jsonl(REJECTED_REL);
    let mut allowed = of_type(&events, "rate_limit_event")[1].clone();
    allowed["rate_limit_info"]["status"] = Value::from("allowed");
    let result = events.pop().unwrap();
    events.push(allowed);
    assert_eq!(plan_watch(&events).limit(), None, "the same window allowed again");

    // A budget stop during a rejected window stays a budget stop.
    let watch = plan_watch(&rec.jsonl(REJECTED_REL));
    let mut budget = result.clone();
    budget["subtype"] = Value::from(crate::orchestrator::cli_runner::BUDGET_STOP_SUBTYPE);
    let parsed = parse_cli_result(&budget.to_string(), true, ArtifactKind::Note, "").unwrap();
    let out = apply_plan_limit(parsed, &watch);
    assert!(crate::orchestrator::cli_runner::is_budget_stop(out.error.as_deref().unwrap()));
    assert!(out.cli.plan_limit.is_none());

    // The real API-key recordings never show a plan wall.
    for r in recordings() {
        for rel in ["stream-json/simple.jsonl", "stream-json/api-retry.jsonl"] {
            if r.dir.join(rel).exists() {
                assert_eq!(plan_watch(&r.jsonl(rel)).limit(), None, "[{}]", r.label(rel));
            }
        }
    }
}

#[test]
fn rate_limit_event_missing_fields_degrade_without_panicking() {
    let rec = recording("2.1.314");
    let events = rec.jsonl(SUBSCRIBER_REL);
    let full = of_type(&events, "rate_limit_event")[0].clone();

    let mut no_info = full.clone();
    no_info.as_object_mut().unwrap().remove("rate_limit_info");
    assert!(plan_windows_from_stream_event(&no_info).is_empty());

    // Only unifiedWindows: both windows, no status (the subject is unknown
    // and nothing says it is allowed).
    let mut only_unified = full.clone();
    let info = only_unified["rate_limit_info"].as_object_mut().unwrap();
    for k in ["status", "rateLimitType", "resetsAt"] {
        info.remove(k);
    }
    let w = plan_windows_from_stream_event(&only_unified);
    assert_eq!(w.iter().map(|x| x.kind.as_str()).collect::<Vec<_>>(), ["five_hour", "seven_day"]);
    assert!(w.iter().all(|x| x.status.is_none()));

    // A rejected subject window: the other unified windows get no status.
    let mut rejected = full.clone();
    rejected["rate_limit_info"]["status"] = Value::from("rejected");
    let w = plan_windows_from_stream_event(&rejected);
    assert_eq!(w[0].status.as_deref(), Some("rejected"));
    assert_eq!(w[1].status, None);

    // resetsAt in milliseconds reads as the same second.
    let mut ms = full.clone();
    ms["rate_limit_info"]["resetsAt"] = Value::from(1_793_551_200_000_i64);
    ms["rate_limit_info"].as_object_mut().unwrap().remove("unifiedWindows");
    assert_eq!(plan_windows_from_stream_event(&ms)[0].resets_at, Some(1793551200));

    // A non-object rate_limit_info or window is ignored.
    let mut junk = full.clone();
    junk["rate_limit_info"]["unifiedWindows"]["five_hour"] = Value::from(7);
    junk["rate_limit_info"].as_object_mut().unwrap().remove("rateLimitType");
    assert_eq!(plan_windows_from_stream_event(&junk).len(), 1);
    junk["rate_limit_info"] = Value::from("x");
    assert!(plan_windows_from_stream_event(&junk).is_empty());
}

// ─── `result.credential_expires_at` → claude.ai sign-in end ──────────────

const LOGIN_EXPIRY_REL: &str = "stream-json/subscriber-login-expiry.jsonl";

#[test]
fn result_credential_expires_at_reports_the_sign_in_end() {
    use crate::orchestrator::cli_runner::credential_expiry_from_result;
    // Synthetic fixture (see the README) — pinned to the recording that has it.
    let rec = recording("2.1.314");
    let fx = rec.label(LOGIN_EXPIRY_REL);
    let events = rec.jsonl(LOGIN_EXPIRY_REL);
    check_stream_shape(&fx, &events);
    let (_, _, outcome) = replay(&fx, &events);
    assert_eq!(outcome.status, StageStatus::Done, "[{fx}] the field must not disturb the stage: {:?}", outcome.error);
    let r = result_event(&fx, &events);
    require_str(&fx, r, "credential_expires_at");
    let want = chrono::DateTime::parse_from_rfc3339("2026-12-12T09:00:00Z").unwrap().timestamp();
    assert_eq!(credential_expiry_from_result(r), Some(want), "[{fx}]");
    // Only the result event carries it.
    for e in events.iter().filter(|e| !is_result_event(e)) {
        assert_eq!(credential_expiry_from_result(e), None, "[{fx}] {e}");
    }

    // Epoch seconds or milliseconds read as the same moment.
    let mut secs = r.clone();
    secs["credential_expires_at"] = Value::from(want);
    assert_eq!(credential_expiry_from_result(&secs), Some(want));
    secs["credential_expires_at"] = Value::from(want * 1000);
    assert_eq!(credential_expiry_from_result(&secs), Some(want));
}

#[test]
fn result_without_credential_expires_at_reports_nothing() {
    use crate::orchestrator::cli_runner::credential_expiry_from_result;
    // Older CLIs (every real recording) and API-key sessions don't send it.
    for rec in recordings() {
        for rel in ["stream-json/simple.jsonl", "stream-json/tool-use.jsonl", "stream-json/resume.jsonl", "stream-json/error-unknown-model.jsonl"] {
            let fx = rec.label(rel);
            let events = rec.jsonl(rel);
            assert_eq!(credential_expiry_from_result(result_event(&fx, &events)), None, "[{fx}]");
        }
    }
    // An unreadable value is no value, never a panic.
    let rec = recording("2.1.314");
    let events = rec.jsonl(LOGIN_EXPIRY_REL);
    let mut r = result_event(&rec.label(LOGIN_EXPIRY_REL), &events).clone();
    for junk in [Value::Null, Value::from("next month"), Value::from(""), Value::from(true), serde_json::json!({}), Value::from(0)] {
        r["credential_expires_at"] = junk.clone();
        assert_eq!(credential_expiry_from_result(&r), None, "{junk}");
    }
}

// ─── `claude auth status` → `loginExpiresAt` (claude.ai sign-in end) ───────

const AUTH_STATUS_VERSION: &str = "2.1.319";

#[test]
fn auth_status_signed_in_reports_the_sign_in_end() {
    use crate::agent_adapter::{parse_claude_auth_status as parse, ClaudeLoginProbe::SignedIn};
    // Synthetic fixture (see the 2.1.319 README).
    let rec = synthesized(AUTH_STATUS_VERSION);
    let rel = "auth-status/signed-in.json";
    let fx = rec.label(rel);
    let mut v = rec.json(rel);
    require_str(&fx, &v, "loginExpiresAt");
    let want = chrono::DateTime::parse_from_rfc3339("2026-12-12T09:00:00Z").unwrap().timestamp();
    assert_eq!(parse(&rec.text(rel)), SignedIn(want), "[{fx}]");
    // A warning on stderr (joined after stdout) doesn't hide it.
    assert_eq!(parse(&format!("{}\nwarning: something\n", rec.text(rel))), SignedIn(want), "[{fx}]");

    // Epoch seconds or milliseconds read as the same moment.
    v["loginExpiresAt"] = Value::from(want);
    assert_eq!(parse(&v.to_string()), SignedIn(want));
    v["loginExpiresAt"] = Value::from(want * 1000);
    assert_eq!(parse(&v.to_string()), SignedIn(want));
}

#[test]
fn auth_status_signed_out_is_told_apart_from_unknown() {
    use crate::agent_adapter::{parse_claude_auth_status as parse, ClaudeLoginProbe::*};
    let rec = synthesized(AUTH_STATUS_VERSION);
    for rel in ["auth-status/signed-out.json", "auth-status/no-login-expires-at.json"] {
        let fx = rec.label(rel);
        assert!(rec.json(rel).get("loggedIn").is_some_and(Value::is_boolean), "[{fx}] loggedIn");
    }
    assert_eq!(parse(&rec.text("auth-status/signed-out.json")), SignedOut);
    // An older CLI (before 2.1.318) is signed in but never says until when.
    assert_eq!(parse(&rec.text("auth-status/no-login-expires-at.json")), Unknown);

    // Signed out: a leftover date is never read as a sign-in.
    let mut out = rec.json("auth-status/signed-out.json");
    out["loginExpiresAt"] = Value::from(1_797_000_000_i64);
    assert_eq!(parse(&out.to_string()), SignedOut);

    // An unreadable value, or output that isn't the object, is unknown, never a panic.
    let mut v = rec.json("auth-status/signed-in.json");
    for junk in [Value::Null, Value::from("next month"), Value::from(""), Value::from(true), serde_json::json!({}), Value::from(0)] {
        v["loginExpiresAt"] = junk.clone();
        assert_eq!(parse(&v.to_string()), Unknown, "{junk}");
    }
    for text in ["", "Logged in using claude.ai", "Not logged in", "error: unknown command 'auth'", "} {", "{not json}"] {
        assert_eq!(parse(text), Unknown, "{text:?}");
    }
}

// ─── `system/init` `model` → the model a stage ran on (#791) ──

#[test]
fn init_events_name_the_model_the_session_runs_on() {
    // Every recorded init carries `model`, and a stage that asked for that
    // model (or its family alias) reads as not substituted.
    use crate::orchestrator::cli_runner::{init_model, substituted_model};
    for rec in recordings() {
        for rel in ["stream-json/simple.jsonl", "stream-json/tool-use.jsonl"] {
            let fx = rec.label(rel);
            let events = rec.jsonl(rel);
            let init = events.iter().find(|e| e["subtype"] == "init").unwrap_or_else(|| panic!("[{fx}] no init"));
            let model = init_model(init).unwrap_or_else(|| panic!("[{fx}] init without a model: {init}"));
            assert_eq!(substituted_model(model, init), None, "[{fx}]");
        }
    }
    // The 2.1.314 retry fixture's init: `claude-sonnet-4-5`.
    let rec = recording("2.1.314");
    let events = rec.jsonl(API_RETRY_REL);
    let init = &events[0];
    assert_eq!(init_model(init), Some("claude-sonnet-4-5"), "[{}]", rec.label(API_RETRY_REL));
    assert_eq!(substituted_model("sonnet", init), None);
    assert_eq!(substituted_model("claude-sonnet-4-5-20250929", init), None);
    assert_eq!(substituted_model("claude-opus-5-5", init).as_deref(), Some("claude-sonnet-4-5"));
}

// ─── `system/api_retry`, `system/notification` and `system/init` load errors → journal notices ──

const API_RETRY_REL: &str = "stream-json/api-retry.jsonl";
const LOAD_ERRORS_REL: &str = "stream-json/init-with-load-errors.jsonl";

fn notice_texts(entries: &[Value]) -> Vec<String> {
    kind_entries(entries, "notice").iter().map(|e| e["text"].as_str().unwrap().to_string()).collect()
}

#[test]
fn real_recordings_system_events_journal_no_notices() {
    // `status`, `thinking_tokens`, `task_summary`, … and an error-free init
    // stay silent.
    for rec in recordings() {
        for rel in ["stream-json/simple.jsonl", "stream-json/tool-use.jsonl", "stream-json/resume.jsonl", "stream-json/error-unknown-model.jsonl"] {
            let fx = rec.label(rel);
            let events = rec.jsonl(rel);
            let (entries, _, _) = replay(&fx, &events);
            assert!(notice_texts(&entries).is_empty(), "[{fx}] {entries:?}");
        }
    }
}

#[test]
fn api_retry_events_journal_a_throttled_retry_notice() {
    // Synthetic fixture (see the README) — pinned to the recording that has it.
    let rec = recording("2.1.314");
    let fx = rec.label(API_RETRY_REL);
    let events = rec.jsonl(API_RETRY_REL);
    check_stream_shape(&fx, &events);
    let retries: Vec<&Value> = events.iter().filter(|e| e["subtype"] == "api_retry").collect();
    for r in &retries {
        for f in ["attempt", "max_retries", "retry_delay_ms"] {
            require_u64(&fx, r, f);
        }
        require_str(&fx, r, "error");
    }
    // The delay each retry waits out stretches the runner's idle window.
    let delays: Vec<Option<u64>> = retries.iter().map(|r| api_retry_delay(r).map(|d| d.as_millis() as u64)).collect();
    assert_eq!(delays, [Some(520), Some(1130), Some(30_000), Some(2000)], "[{fx}]");
    assert!(events.iter().filter(|e| e["subtype"] != "api_retry").all(|e| api_retry_delay(e).is_none()), "[{fx}]");
    let (entries, _, outcome) = replay(&fx, &events);
    assert_eq!(outcome.status, StageStatus::Done, "[{fx}] {:?}", outcome.error);
    assert_eq!(notice_texts(&entries), [
        "retrying · overloaded · attempt 1/10 · in 1s",
        "retrying · overloaded · attempt 2/10 · in 2s",
        "retrying · rate_limit · attempt 3/10 · in 30s",
        "retrying · fixture_unknown_cause · attempt 4/10 · in 2s",
    ], "[{fx}]");

    // As the runner journals them, arriving within one second: the second
    // `overloaded` retry collapses into the first.
    let mut th = RetryThrottle::default();
    let t0 = std::time::Instant::now();
    let shown: Vec<String> = events
        .iter()
        .enumerate()
        .filter(|(i, e)| th.allow(e, t0 + std::time::Duration::from_millis(*i as u64 * 100)))
        .flat_map(|(_, e)| entries_from_stream_event(e))
        .filter(|e| e["kind"] == "notice")
        .map(|e| e["text"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(shown.len(), 3, "[{fx}] {shown:?}");
    assert!(shown[0].contains("attempt 1/10") && shown[1].contains("rate_limit"), "[{fx}] {shown:?}");
}

const NOTIFICATION_REL: &str = "stream-json/notification.jsonl";

#[test]
fn notification_events_journal_their_message() {
    // Synthetic fixture (see the README) — pinned to the recording that has it.
    let rec = recording("2.1.314");
    let fx = rec.label(NOTIFICATION_REL);
    let events = rec.jsonl(NOTIFICATION_REL);
    check_stream_shape(&fx, &events);
    let notes: Vec<&Value> = events.iter().filter(|e| e["subtype"] == "notification").collect();
    assert_eq!(notes.len(), 3, "[{fx}]");
    require_str(&fx, notes[0], "text");
    let (entries, _, outcome) = replay(&fx, &events);
    assert_eq!(outcome.status, StageStatus::Done, "[{fx}] {:?}", outcome.error);
    // A notification with no text journals nothing.
    assert_eq!(notice_texts(&entries), [
        "Fast mode disabled · usage credits exhausted",
        "fixture notice under message",
    ], "[{fx}]");
    // Notifications aren't retries: the throttle never drops them.
    let mut th = RetryThrottle::default();
    let t0 = std::time::Instant::now();
    assert!(notes.iter().all(|e| th.allow(e, t0) && th.allow(e, t0)), "[{fx}]");
}

/// The version whose `SessionStart` / `SessionEnd` payloads were recorded
/// live (see its README).
const SESSION_HOOKS_VERSION: &str = "2.1.327";

/// The session hooks (`SessionStart`, `SessionEnd`) say which Claude Code
/// session a Run terminal runs. Recorded payloads, through the hook binary's
/// path and the poller's bookkeeping, in the order Claude Code fired them.
#[test]
fn session_hook_payloads_move_the_terminal_between_sessions() {
    use crate::agent_adapter::{parse_hook_event, HookSignal};
    use crate::claude_hooks::{record_hook_from, remember_sessions};
    let rec = synthesized(SESSION_HOOKS_VERSION);
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let db = crate::db::Db::open(tmp.path()).unwrap();
    let current = || db.terminal_claude_session("term-1").unwrap().map(|(s, _)| s);
    let session_in = |rel: &str| {
        let payload = rec.json(rel);
        require_str(&rec.label(rel), &payload, "transcript_path");
        require_str(&rec.label(rel), &payload, "cwd");
        require_str(&rec.label(rel), &payload, "session_id").to_string()
    };
    // `claude` starts, `/clear`, `/exit`: the terminal UI (`cli`).
    let steps = [
        ("hooks/session-start-startup.json", HookSignal::SessionStarted, "source", "startup"),
        ("hooks/session-end-clear.json", HookSignal::SessionEnded, "reason", "clear"),
        ("hooks/session-start-clear.json", HookSignal::SessionStarted, "source", "clear"),
        ("hooks/session-end-exit.json", HookSignal::SessionEnded, "reason", "prompt_input_exit"),
    ];
    let first = session_in(steps[0].0);
    let second = session_in(steps[2].0);
    assert_ne!(first, second, "`/clear` gives the process a new session id");
    assert_eq!(session_in(steps[1].0), first, "the end names the session that ended");
    let mut seen = Vec::new();
    for (rel, want, field, value) in steps {
        let fx = rec.label(rel);
        let payload = rec.json(rel);
        assert_eq!(payload[field], value, "[{fx}] {field}");
        let event = parse_hook_event(&payload, None).unwrap_or_else(|| panic!("[{fx}] maps to no signal"));
        assert_eq!(event.signal, want, "[{fx}]");
        assert!(record_hook_from(&db, Some("term-1"), None, Some("cli"), &rec.text(rel)), "[{fx}]");
        let rows = db.drain_hook_signals().unwrap();
        assert_eq!(rows.len(), 1, "[{fx}]");
        assert_eq!(rows[0].signal, want.as_str(), "[{fx}]");
        remember_sessions(&db, &rows);
        seen.push(current());
    }
    assert_eq!(seen, [Some(first), None, Some(second), None], "start · /clear (end, start) · /exit");

    // Print mode fires both events too, and inherits the terminal's id when
    // an agent runs it. Its hook's environment says `sdk-cli`: both are
    // queued as an end of that session, which sets it aside (never the
    // terminal's session, never a rival of it) and links nothing.
    std::thread::sleep(std::time::Duration::from_millis(3));
    record_hook_from(&db, Some("term-1"), None, Some("cli"), &rec.text("hooks/session-start-startup.json"));
    remember_sessions(&db, &db.drain_hook_signals().unwrap());
    let nested = session_in("hooks/session-start-print.json");
    for rel in ["hooks/session-start-print.json", "hooks/session-end-print.json"] {
        let fx = rec.label(rel);
        assert!(parse_hook_event(&rec.json(rel), None).is_some_and(|e| e.signal.is_session()), "[{fx}]");
        assert!(record_hook_from(&db, Some("term-1"), None, Some("sdk-cli"), &rec.text(rel)), "[{fx}]");
        let rows = db.drain_hook_signals().unwrap();
        assert_eq!(rows.len(), 1, "[{fx}]");
        assert_eq!(
            (rows[0].signal.as_str(), rows[0].session_id.as_deref()),
            (HookSignal::SessionEnded.as_str(), Some(nested.as_str())),
            "[{fx}] print mode is set aside, not linked",
        );
        remember_sessions(&db, &rows);
        assert_eq!(current(), Some(session_in("hooks/session-start-startup.json")), "[{fx}] the terminal keeps its own session");
    }
}

#[test]
fn hook_payloads_map_to_attention_signals() {
    use crate::agent_adapter::{parse_hook_event, HookSignal};
    // Synthetic fixtures (see the README) — pinned to the recording that has them.
    let rec = recording("2.1.314");
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let db = crate::db::Db::open(tmp.path()).unwrap();
    // `kind` is the `--kind` the hook is registered with: one per
    // `Notification` matcher, none for `Stop`.
    for (rel, kind, want) in [
        ("hooks/notification-permission.json", Some("permission"), HookSignal::NeedsPermission),
        ("hooks/notification-idle.json", Some("input"), HookSignal::NeedsInput),
        ("hooks/stop.json", None, HookSignal::Settled),
    ] {
        let fx = rec.label(rel);
        let payload = rec.json(rel);
        let session = require_str(&fx, &payload, "session_id");
        require_str(&fx, &payload, "cwd");
        let event = parse_hook_event(&payload, kind).unwrap_or_else(|| panic!("[{fx}] maps to no signal"));
        assert_eq!(event.signal, want, "[{fx}]");
        assert_eq!(event.session_id.as_deref(), Some(session), "[{fx}]");
        // Without `--kind` (a hook installed before it), `notification_type` still maps.
        assert_eq!(parse_hook_event(&payload, None).map(|e| e.signal), Some(want), "[{fx}] without --kind");
        // With `--kind`, the signal doesn't depend on `notification_type` at all.
        let mut untyped = payload.clone();
        untyped.as_object_mut().unwrap().remove("notification_type");
        assert_eq!(parse_hook_event(&untyped, kind).map(|e| e.signal), Some(want), "[{fx}] without notification_type");
        // The hook binary's path: queued for the terminal, message text dropped.
        assert!(crate::claude_hooks::record_hook(&db, Some("term-1"), kind, &rec.text(rel)), "[{fx}]");
        let rows = db.drain_hook_signals().unwrap();
        assert_eq!(rows.len(), 1, "[{fx}]");
        assert_eq!((rows[0].terminal_id.as_str(), rows[0].signal.as_str()), ("term-1", want.as_str()), "[{fx}]");
        if let Some(message) = payload["message"].as_str() {
            assert!(!format!("{rows:?}").contains(message), "[{fx}] message text must not be stored");
        }
    }
}

#[test]
fn init_load_errors_journal_one_notice_each() {
    let rec = recording("2.1.314");
    let fx = rec.label(LOAD_ERRORS_REL);
    let events = rec.jsonl(LOAD_ERRORS_REL);
    check_stream_shape(&fx, &events);
    let init = events.iter().find(|e| e["subtype"] == "init").unwrap();
    require_str(&fx, init, "mcp_server_errors.0.name");
    require_str(&fx, init, "plugin_errors.0.plugin");
    let (entries, _, _) = replay(&fx, &events);
    assert_eq!(notice_texts(&entries), [
        "MCP server 'fixture-missing' skipped: spawn fixture-missing-mcp ENOENT",
        "MCP server 'fixture-badconfig' skipped: invalid config: \"command\" is required",
        "plugin 'fixture-plugin' failed to load: plugin.json: missing \"name\"",
    ], "[{fx}]");
    // The init's other readers are unaffected.
    assert_eq!(cli_auth_from_init(init), Some(CliAuth::ApiKey), "[{fx}]");
}

#[test]
fn init_api_key_source_classifies_the_session() {
    let rec = recordings().pop().unwrap();
    let fx = rec.label("stream-json/simple.jsonl");
    let mut init = rec.jsonl("stream-json/simple.jsonl").into_iter().find(|e| e["subtype"] == "init").unwrap();
    // The scrubber drops `apiKeySource` from the recordings: unknown, not a guess.
    assert_eq!(cli_auth_from_init(&init), None, "[{fx}]");
    init["apiKeySource"] = Value::from("ANTHROPIC_API_KEY");
    assert_eq!(cli_auth_from_init(&init), Some(CliAuth::ApiKey));
    init["apiKeySource"] = Value::from("none");
    assert_eq!(cli_auth_from_init(&init), Some(CliAuth::Subscription));
    init["subtype"] = Value::from("status");
    assert_eq!(cli_auth_from_init(&init), None, "only system/init classifies");
}

// ─── Transcript JSONL ─────────────────────────────────────────────────────

fn transcript_file(rec: &Rec) -> (String, PathBuf) {
    let dir = rec.path("transcript");
    let file = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .unwrap_or_else(|| panic!("[{}] no <session>.jsonl", rec.label("transcript/")));
    let rel = format!("transcript/{}", file.file_name().unwrap().to_string_lossy());
    (rel, file)
}

#[test]
fn transcript_jsonl_yields_one_ledger_row_per_api_call() {
    for rec in recordings() {
        let (rel, path) = transcript_file(&rec);
        let fx = rec.label(&rel);
        let lines = rec.jsonl(&rel);
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        let mut billed_requests: HashSet<String> = HashSet::new();
        for l in of_type(&lines, "assistant") {
            let model = require_str(&fx, l, "message.model");
            require_str(&fx, l, "message.id");
            require_str(&fx, l, "timestamp");
            require_str(&fx, l, "sessionId");
            let total: u64 = USAGE_FIELDS.iter().map(|f| require_u64(&fx, l, &format!("message.usage.{f}"))).sum();
            if model.starts_with('<') || total == 0 {
                continue; // synthetic error turn — bills nothing
            }
            billed_requests.insert(require_str(&fx, l, "requestId").to_string());
            let line = serde_json::to_string(l).unwrap();
            assert!(
                crate::transcripts::parse_transcript_line(&line, &stem).is_some(),
                "[{fx}] parse_transcript_line rejected a billed assistant line"
            );
        }
        assert!(!billed_requests.is_empty(), "[{fx}] no billed assistant lines");

        let (rows, offset) = crate::transcripts::read_new_entries(&path, 0)
            .unwrap_or_else(|e| panic!("[{fx}] read_new_entries failed: {e}"));
        assert_eq!(offset, std::fs::metadata(&path).unwrap().len(), "[{fx}] every complete line should be consumed");
        assert_eq!(rows.len(), billed_requests.len(), "[{fx}] one row per billed request id: {rows:?}");
        for r in &rows {
            assert!(r.key.starts_with("cc:req_"), "[{fx}] ledger key should be keyed on requestId, got {}", r.key);
            assert!(r.model.starts_with("claude-"), "[{fx}] model `{}`", r.model);
            assert_eq!(r.session_id, stem, "[{fx}] session id");
            assert_eq!(r.cwd.as_deref(), Some("/Users/dev/project"), "[{fx}] cwd");
            assert!(r.message_id.as_deref().is_some_and(|m| m.starts_with("msg_")), "[{fx}] message id");
            assert!(chrono::DateTime::parse_from_rfc3339(&r.ts_utc).is_ok(), "[{fx}] timestamp {}", r.ts_utc);
            assert!(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens > 0);
        }
        // The recording's cwd maps to the directory name Claude Code uses.
        assert_eq!(crate::transcripts::project_dir_name("/Users/dev/project"), "-Users-dev-project");
    }
}

/// The Run Companion's context meter reads a session's last main-thread
/// prompt from the end of its transcript (`transcripts::last_prompt`): the
/// recording's main-thread lines say `isSidechain: false`, and its last
/// billed message is the one the reader returns.
#[test]
fn transcript_tail_gives_the_sessions_last_main_thread_prompt() {
    for rec in recordings() {
        let (rel, path) = transcript_file(&rec);
        let fx = rec.label(&rel);
        let lines = rec.jsonl(&rel);
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        let mut expected: Option<u64> = None;
        for l in of_type(&lines, "assistant") {
            assert_eq!(l.get("isSidechain").and_then(Value::as_bool), Some(false), "[{fx}] a main-thread line says isSidechain: false");
            let model = require_str(&fx, l, "message.model");
            let total: u64 = USAGE_FIELDS.iter().map(|f| require_u64(&fx, l, &format!("message.usage.{f}"))).sum();
            if model.starts_with('<') || total == 0 {
                continue;
            }
            let prompt = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
                .iter()
                .map(|f| require_u64(&fx, l, &format!("message.usage.{f}")))
                .sum();
            expected = Some(prompt);
        }
        // Laid out as Claude Code does: <projects>/<cwd, sanitized>/<session>.jsonl.
        let root = tempfile::tempdir().unwrap();
        let cwd = "/Users/dev/project";
        let dir = root.path().join(crate::transcripts::project_dir_name(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(&path, dir.join(format!("{stem}.jsonl"))).unwrap();
        let got = crate::transcripts::last_prompt(root.path(), cwd, &stem);
        assert_eq!(got.as_ref().map(|p| p.tokens), expected, "[{fx}] last prompt");
        assert!(got.is_some_and(|p| p.model.starts_with("claude-")), "[{fx}] its model");
    }
}

#[test]
fn transcript_line_missing_fields_is_skipped_not_a_panic() {
    let rec = recordings().pop().unwrap();
    let (rel, path) = transcript_file(&rec);
    let fx = rec.label(&rel);
    let stem = path.file_stem().unwrap().to_string_lossy().to_string();
    let lines = rec.jsonl(&rel);
    let billed = of_type(&lines, "assistant")
        .into_iter()
        .find(|l| l.pointer("/message/model").and_then(Value::as_str).is_some_and(|m| m.starts_with("claude-")))
        .unwrap()
        .clone();
    let parse = |v: &Value| crate::transcripts::parse_transcript_line(&serde_json::to_string(v).unwrap(), &stem);
    assert!(parse(&billed).is_some());

    let mut no_usage = billed.clone();
    no_usage["message"].as_object_mut().unwrap().remove("usage");
    assert!(parse(&no_usage).is_none());
    assert!(try_require(&fx, &no_usage, "message.usage").unwrap_err().contains("message.usage"));

    let mut no_ts = billed.clone();
    no_ts.as_object_mut().unwrap().remove("timestamp");
    assert!(parse(&no_ts).is_none());

    let mut no_ids = billed.clone();
    no_ids.as_object_mut().unwrap().remove("requestId");
    no_ids["message"].as_object_mut().unwrap().remove("id");
    assert!(parse(&no_ids).is_none(), "a row with no request or message id cannot be keyed");
}

const FAST_MODE_REL: &str = "transcript-synthetic/fast-mode.jsonl";

#[test]
fn transcript_fast_mode_turns_carry_their_speed() {
    // Synthetic fixture (see the README) — pinned to the recording that has it.
    let rec = recording("2.1.314");
    let fx = rec.label(FAST_MODE_REL);
    for l in of_type(&rec.jsonl(FAST_MODE_REL), "assistant") {
        require_str(&fx, l, "message.usage.speed");
    }
    let (rows, _) = crate::transcripts::read_new_entries(&rec.path(FAST_MODE_REL), 0)
        .unwrap_or_else(|e| panic!("[{fx}] read_new_entries failed: {e}"));
    let speeds: Vec<(&str, Option<&str>)> = rows.iter().map(|r| (r.model.as_str(), r.speed.as_deref())).collect();
    assert_eq!(
        speeds,
        [
            ("claude-opus-5", Some("fast")),
            ("claude-opus-4-8", Some("fast")),
            ("claude-opus-5-5", Some("fast")),
            ("claude-opus-5", Some("standard")),
        ],
        "[{fx}] one row per request, with its usage.speed"
    );
    assert_eq!(rows[1].cache_creation_1h_tokens, 2_000, "[{fx}] 1-hour writes on a fast turn");

    // No `speed` field (every older transcript): no speed, priced as before.
    let rel = transcript_file(&rec).0;
    let stem = "s";
    for l in of_type(&rec.jsonl(&rel), "assistant") {
        if let Some(u) = crate::transcripts::parse_transcript_line(&serde_json::to_string(l).unwrap(), stem) {
            assert_eq!(u.speed, None, "[{}] the real recording reports no speed", rec.label(&rel));
        }
    }
}

// ─── PTY `Total cost:` tail ──────────────────────────────────────────────

#[test]
fn pty_tui_positions_words_with_cursor_moves() {
    // Real bytes from v2.1.314's TUI: the words of a line are placed with
    // `ESC[<col>G`, not separated by spaces.
    for rec in recordings() {
        let fx = rec.label("pty/tui-render-sample.ansi");
        let raw = rec.text("pty/tui-render-sample.ansi");
        assert!(!raw.contains("Welcome to Claude Code"), "[{fx}] the TUI now writes literal spaces — the screen_text normalisation may be unnecessary");
        let screen = crate::token_engine::screen_text(&raw);
        assert!(screen.contains("Welcome to Claude Code"), "[{fx}] screen_text did not recover the words: {screen:?}");
    }
}

#[test]
fn pty_total_cost_tail_is_scraped() {
    for rec in recordings() {
        for rel in ["pty/total-cost-tail.ansi", "pty/total-cost-tail.txt"] {
            let fx = rec.label(rel);
            let tail = rec.text(rel);
            let ev = ClaudeCodeAdapter
                .parse_token_usage("sess-fixture", &tail)
                .unwrap_or_else(|| panic!("[{fx}] Claude Code contract broken: no `Total cost: $…` found in the PTY tail"));
            assert!((ev.cost_usd - 0.0323).abs() < 1e-9, "[{fx}] cost {}", ev.cost_usd);
            assert_eq!(ev.model, "unknown");
        }
    }
}

#[test]
fn pty_tail_without_the_cost_line_scrapes_nothing() {
    // Pinned to the recording whose TUI sample is known to hold no summary
    // (a later real capture may well contain one).
    let rec = recording("2.1.314");
    let tail = rec.text("pty/total-cost-tail.ansi");
    let no_label = tail.replace("cost:", "spend:");
    assert!(crate::token_engine::scan_pty_output("s", no_label.as_bytes()).is_none());
    let no_amount = tail.replace('$', "");
    assert!(crate::token_engine::scan_pty_output("s", no_amount.as_bytes()).is_none());
    assert!(crate::token_engine::scan_pty_output("s", rec.text("pty/tui-render-sample.ansi").as_bytes()).is_none());
}

// ─── SKILL.md / agents frontmatter ───────────────────────────────────────

const SKILL_REL: &str = "definitions/skills/fixture-skill/SKILL.md";
const AGENT_REL: &str = "definitions/agents/fixture-reviewer.md";

#[test]
fn definitions_parse_and_claude_code_loads_the_same_files() {
    for rec in recordings() {
        let skill_fx = rec.label(SKILL_REL);
        let skill = crate::skills::parse_skill(&rec.text(SKILL_REL), "project")
            .unwrap_or_else(|| panic!("[{skill_fx}] parse_skill rejected the file (frontmatter `name` missing?)"));
        assert_eq!(skill.name, "fixture-skill", "[{skill_fx}] name");
        assert!(!skill.description.is_empty(), "[{skill_fx}] description");
        assert_eq!(skill.allowed_tools.as_deref(), Some(&["Read".to_string(), "Grep".to_string()][..]), "[{skill_fx}] allowed-tools");
        assert!(skill.body.contains("\n---\n") && skill.body.contains("- The rule above"), "[{skill_fx}] body lost its rule/list: {:?}", skill.body);

        let agent_fx = rec.label(AGENT_REL);
        let agent = crate::skills::agents::parse_agent_definition(&rec.text(AGENT_REL), "project")
            .unwrap_or_else(|| panic!("[{agent_fx}] parse_agent_definition rejected the file"));
        assert_eq!(agent.name, "fixture-reviewer", "[{agent_fx}] name");
        assert_eq!(agent.model.as_deref(), Some("haiku"), "[{agent_fx}] model");
        assert_eq!(agent.effort, Some(crate::providers::Effort::Low), "[{agent_fx}] custom `effort:` key");
        assert_eq!(agent.max_turns, Some(4), "[{agent_fx}] max-turns");
        assert_eq!(
            agent.tools.as_deref(),
            Some(&["read_file".to_string(), "grep".to_string(), "glob".to_string()][..]),
            "[{agent_fx}] tools"
        );
        assert_eq!(agent.mcp, crate::skills::agents::McpGrant::Only(vec!["mcp__octopush".into()]), "[{agent_fx}] mcp grant");

        // Discovery from a worktree layout finds both.
        let wt = tempfile::tempdir().unwrap();
        for (rel, dst) in [(SKILL_REL, ".claude/skills/fixture-skill/SKILL.md"), (AGENT_REL, ".claude/agents/fixture-reviewer.md")] {
            let to = wt.path().join(dst);
            std::fs::create_dir_all(to.parent().unwrap()).unwrap();
            std::fs::copy(rec.path(rel), &to).unwrap();
        }
        assert!(crate::skills::scan_skills(wt.path()).iter().any(|s| s.name == "fixture-skill" && s.source == "project"));
        assert!(crate::skills::agents::scan_agent_definitions(wt.path()).iter().any(|a| a.name == "fixture-reviewer" && a.source == "project"));

        // And Claude Code itself loaded these exact files (its init event lists them).
        let init_fx = rec.label("stream-json/init-with-definitions.jsonl");
        let init = rec.jsonl("stream-json/init-with-definitions.jsonl").into_iter().next().unwrap();
        let listed = |k: &str| -> Vec<String> {
            require(&init_fx, &init, k).as_array().unwrap().iter().filter_map(|x| x.as_str().map(str::to_string)).collect()
        };
        assert!(listed("agents").contains(&"fixture-reviewer".to_string()), "[{init_fx}] Claude Code did not load the agent file");
        assert!(listed("skills").contains(&"fixture-skill".to_string()), "[{init_fx}] Claude Code did not load the skill file");
    }
}

#[test]
fn definitions_missing_fields_are_rejected_not_a_panic() {
    let rec = recordings().pop().unwrap();
    let skill = rec.text(SKILL_REL);
    let agent = rec.text(AGENT_REL);
    let drop_line = |s: &str, key: &str| s.lines().filter(|l| !l.starts_with(key)).collect::<Vec<_>>().join("\n");

    assert!(crate::skills::parse_skill(&drop_line(&skill, "name:"), "project").is_none());
    assert!(crate::skills::agents::parse_agent_definition(&drop_line(&agent, "name:"), "project").is_none());
    // No closing fence → malformed, rejected.
    let unclosed = agent.replacen("\n---\n", "\n", 1);
    assert!(crate::skills::agents::parse_agent_definition(&unclosed, "project").is_none());
    // Unknown effort → no effort, the rest intact.
    let bogus = agent.replace("effort: low", "effort: ludicrous");
    let d = crate::skills::agents::parse_agent_definition(&bogus, "project").unwrap();
    assert_eq!(d.effort, None);
    assert_eq!(d.max_turns, Some(4));
    // Removing `effort:` altogether is also fine.
    assert_eq!(crate::skills::agents::parse_agent_definition(&drop_line(&agent, "effort:"), "project").unwrap().effort, None);
}

// ─── `claude mcp add` argv ───────────────────────────────────────────────

const MCP_BINARY: &str = "/Users/dev/Applications/Octopush.app/Contents/MacOS/octopush-mcp";

fn mcp_add_argv() -> Vec<String> {
    crate::mcp_setup::mcp_add_args(Path::new(MCP_BINARY))
        .into_iter()
        .map(|a| a.to_string_lossy().to_string())
        .collect()
}

#[test]
fn mcp_add_argv_matches_the_recorded_registration() {
    let argv = mcp_add_argv();
    assert_eq!(argv, ["mcp", "add", crate::mcp_setup::SERVER_NAME, "-s", "user", "--", MCP_BINARY]);
    assert_eq!(
        crate::mcp_setup::manual_command(Some(MCP_BINARY)),
        format!("claude {} \"{MCP_BINARY}\"", argv[..argv.len() - 1].join(" ")),
        "the copy-paste command must be the same registration"
    );
    for rec in recordings() {
        let help_fx = rec.label("mcp/mcp-add-help.txt");
        let help = rec.text("mcp/mcp-add-help.txt");
        assert!(help.contains("<name> <commandOrUrl> [args...]"), "[{help_fx}] `mcp add` positional shape changed");
        if let Err(e) = flags_documented(&help_fx, &help, &argv, &[]) {
            panic!("{e}");
        }
        assert!(help.contains("user"), "[{help_fx}] `user` is no longer a scope");

        // What the recorded `mcp add` (same argv) wrote to the user config.
        let cfg_fx = rec.label("mcp/mcp-config.json");
        let cfg = rec.json("mcp/mcp-config.json");
        let entry = require(&cfg_fx, &cfg, &format!("mcpServers.{}", crate::mcp_setup::SERVER_NAME));
        assert_eq!(require_str(&cfg_fx, entry, "command"), MCP_BINARY, "[{cfg_fx}] command");
        assert_eq!(require_str(&cfg_fx, entry, "type"), "stdio", "[{cfg_fx}] transport");
        assert_eq!(require(&cfg_fx, entry, "args").as_array().map(Vec::len), Some(0), "[{cfg_fx}] args");
        // `is_registered` relies on `mcp get octopush` succeeding; the
        // recorded output names the server at user scope.
        let get = rec.text("mcp/mcp-get.txt");
        assert!(get.contains("octopush:") && get.contains("Scope: User"), "[{}] {get}", rec.label("mcp/mcp-get.txt"));
        // Connect skips remove → add when `mcp get` already shows this exact registration.
        assert!(
            crate::mcp_setup::registered_with(&get, Path::new(MCP_BINARY)),
            "[{}] recorded `mcp get` no longer parses as our registration: {get}",
            rec.label("mcp/mcp-get.txt")
        );
    }
}

#[test]
fn the_recorder_registers_with_the_same_argv() {
    // `scripts/record-claude-fixtures.sh` cannot call into Rust cheaply, so
    // it spells the argv out; this keeps the two from drifting apart.
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/record-claude-fixtures.sh");
    let text = std::fs::read_to_string(&script).expect("scripts/record-claude-fixtures.sh");
    let argv = mcp_add_argv();
    let spelled = format!("{} \"$MCP_BIN\"", argv[..argv.len() - 1].join(" "));
    assert!(
        text.contains(&spelled),
        "scripts/record-claude-fixtures.sh must record `claude {spelled}` (mcp_setup::mcp_add_args)"
    );
    assert!(text.contains(&format!("MCP_BIN=\"{MCP_BINARY}\"")), "recorder's MCP_BIN must be {MCP_BINARY}");
}

#[test]
fn mcp_contract_breaks_are_reported_clearly() {
    let rec = recordings().pop().unwrap();
    let fx = rec.label("mcp/mcp-add-help.txt");
    let help = rec.text("mcp/mcp-add-help.txt").replace("-s, --scope", "--scope");
    let err = flags_documented(&fx, &help, &mcp_add_argv(), &[]).unwrap_err();
    assert!(err.contains(&fx) && err.contains("`-s`"), "{err}");

    let cfg_fx = rec.label("mcp/mcp-config.json");
    let mut cfg = rec.json("mcp/mcp-config.json");
    cfg["mcpServers"]["octopush"].as_object_mut().unwrap().remove("command");
    let err = try_require(&cfg_fx, &cfg["mcpServers"]["octopush"], "command").unwrap_err();
    assert!(err.contains(&cfg_fx) && err.contains("`command`"), "{err}");
}
