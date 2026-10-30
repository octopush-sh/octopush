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

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::agent_adapter::{AgentAdapter, ClaudeCodeAdapter};
use crate::orchestrator::cli_runner::{
    build_cli_args, build_cli_args_resume, is_result_event, parse_cli_result, usage_from_stream_event,
};
use crate::orchestrator::live::entries_from_stream_event;
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
/// root is a recording: one without a `VERSION` file, or whose `VERSION`
/// disagrees with its name, is a broken recording and fails here.
fn recordings() -> Vec<Rec> {
    let root = fixture_root();
    let mut out: Vec<Rec> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("fixture root {} unreadable: {e}", root.display()))
        .flatten()
        .filter(|e| e.path().is_dir())
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

#[test]
fn versions_sort_numerically() {
    let mut v = vec!["2.1.10", "2.1.9", "2.0.100", "10.0.0"];
    v.sort_by_key(|s| semver_key(s));
    assert_eq!(v, ["2.0.100", "2.1.9", "2.1.10", "10.0.0"]);
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
        assert!(
            usage_from_stream_event(a).is_some(),
            "[{fixture}] usage_from_stream_event returned None for an assistant event"
        );
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
fn stream_json_argv_flags_are_all_known_to_the_cli() {
    for rec in recordings() {
        let fx = rec.label("cli-help.txt");
        let help = rec.text("cli-help.txt");
        for argv in [
            build_cli_args("claude-haiku-4-5", "system", 3, true),
            build_cli_args_resume("claude-haiku-4-5", "aaaaaaaa-0000-4000-8000-000000000001", 3, true),
        ] {
            if let Err(e) = flags_documented(&fx, &help, &argv, CLI_HIDDEN_FLAGS) {
                panic!("{e}");
            }
        }
        for value in ["stream-json", "bypassPermissions"] {
            assert!(help.contains(value), "[{fx}] `claude --help` no longer mentions `{value}`");
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
