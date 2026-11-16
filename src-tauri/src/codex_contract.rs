//! Contract tests: recorded Codex CLI output, run through the REAL code.
//!
//! Octopush builds `codex exec` argv and folds its `--json` stream. Each
//! surface has a fixture under `tests/fixtures/codex/<cli-version>/` (see the
//! README there for which files are real recordings and which are synthetic)
//! and a test here that feeds it to the production function, so a change in
//! Codex's flags or events shows up as one red test naming the fixture.
//!
//! | Surface | Production code |
//! |---|---|
//! | `codex exec --help`, `codex exec resume --help` (the flags the argv uses) | `CliDialect::argv` / `resume_argv` / `push_flags` |
//! | `codex exec resume --help` (the probe) | `agent_adapter::codex_help_lists_exec_resume` |
//! | `codex exec resume` with an unknown session (stderr, exit 1) | `cli_runner::codex_resume_failure` |
//! | the resumed `--json` stream | `codex_fold_event`, `codex_usage_from_event`, `usage_since`, `build_codex_outcome` |

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::agent_adapter::codex_help_lists_exec_resume;
use crate::orchestrator::cli_runner::{
    build_codex_outcome, codex_fold_event, codex_resume_failure, codex_resume_skip_reason, codex_session_usage,
    codex_usage_from_event, codex_resume_failure_notice, codex_writable_root_args, is_resume_problem, is_usage_unreported, merge_resume_fallback,
    sum_usage, usage_drift_notice, usage_since, CliDialect, CliUsage, CodexAccum, CodexWriteScope,
};
use crate::orchestrator::types::{ArtifactKind, SessionUsage, StageStatus};

struct Rec {
    dir: PathBuf,
    version: String,
}

impl Rec {
    fn label(&self, rel: &str) -> String {
        format!("codex/{}/{rel}", self.version)
    }
    fn text(&self, rel: &str) -> String {
        std::fs::read_to_string(self.dir.join(rel))
            .unwrap_or_else(|e| panic!("[{}] fixture missing or unreadable: {e}", self.label(rel)))
    }
    fn jsonl(&self, rel: &str) -> Vec<Value> {
        self.text(rel)
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, l)| {
                serde_json::from_str(l).unwrap_or_else(|e| panic!("[{}:{}] line is not JSON: {e}", self.label(rel), i + 1))
            })
            .collect()
    }
}

/// Every recorded Codex version (a directory with a `VERSION` file).
fn recordings() -> Vec<Rec> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex");
    let mut out: Vec<Rec> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("fixture root {} unreadable: {e}", root.display()))
        .flatten()
        .filter(|e| e.path().join("VERSION").exists())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let version = std::fs::read_to_string(e.path().join("VERSION")).unwrap().trim().to_string();
            assert_eq!(version, name, "[codex/{name}/VERSION] says `{version}`");
            Rec { dir: e.path(), version }
        })
        .collect();
    assert!(!out.is_empty(), "no Codex fixture versions under {}", root.display());
    out.sort_by(|a, b| a.version.cmp(&b.version));
    out
}

/// The flags (not values) in `args`: `-m`, `--json`, …; never the `-` stdin marker.
fn flags(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).filter(|a| a.starts_with('-') && *a != "-").collect()
}

/// True when the help text lists `flag` as an option (`-m, --model`, `--json`).
fn help_lists(help: &str, flag: &str) -> bool {
    help.lines().map(str::trim_start).any(|l| {
        l.starts_with(&format!("{flag} ")) || l.starts_with(&format!("{flag},")) || l == flag || l.contains(&format!(", {flag}"))
    })
}

const SESSION: &str = "01a1e4ff-fb0a-7ab2-aa00-7b42b409160a";

#[test]
fn version_file_matches_the_recorded_cli() {
    for r in recordings() {
        let v = r.text("version.txt");
        assert_eq!(v.trim(), format!("codex-cli {}", r.version), "[{}]", r.label("version.txt"));
    }
}

#[test]
fn exec_resume_probe_accepts_the_recorded_help_and_nothing_else() {
    for r in recordings() {
        let resume = r.text("exec-resume-help.txt");
        assert!(codex_help_lists_exec_resume(&resume), "[{}] probe rejects the real help", r.label("exec-resume-help.txt"));
        // `codex exec --help` (no resume usage line) and the top-level help
        // are not the subcommand's help.
        assert!(!codex_help_lists_exec_resume(&r.text("exec-help.txt")));
        assert!(!codex_help_lists_exec_resume(&r.text("cli-help.txt")));
        // `codex exec` lists the subcommand.
        assert!(r.text("exec-help.txt").lines().any(|l| l.trim_start().starts_with("resume ")));
    }
}

#[test]
fn resume_argv_flags_sit_where_the_recorded_help_accepts_them() {
    for r in recordings() {
        let exec = r.text("exec-help.txt");
        let resume = r.text("exec-resume-help.txt");
        // The constraint the argv is built around: `resume` takes no sandbox flag.
        assert!(!help_lists(&resume, "-s") && !help_lists(&resume, "--sandbox"), "[{}]", r.label("exec-resume-help.txt"));
        assert!(r.text("resume/sandbox-after-subcommand.stderr").contains("unexpected argument '-s' found"));

        for (read_only, scope) in [
            (true, CodexWriteScope::Workspace),
            (false, CodexWriteScope::Workspace),
            (false, CodexWriteScope::MissionSandbox),
        ] {
            let d = CliDialect::Codex;
            let fresh = d.argv("gpt-5.5", "", 25, read_only, scope);
            let mut a = d.resume_argv("gpt-5.5", SESSION, 25, read_only, scope).unwrap();
            // What the runner adds: the effort and the writable root.
            d.push_effort_args(&mut a, "gpt-5.5", Some(crate::providers::Effort::High));
            if !read_only && scope == CodexWriteScope::Workspace {
                d.push_flags(&mut a, codex_writable_root_args("/tmp/cache-root"));
            }
            let at = a.iter().position(|x| x == "resume").expect("resume subcommand");
            assert_eq!(a[0], "exec");
            // Everything the fresh run passes, in the same order, before `resume`.
            assert_eq!(a[..at], fresh[..fresh.len() - 1], "{a:?}");
            assert_eq!(a[at + 1], SESSION);
            assert_eq!(a.last().map(String::as_str), Some("-"), "prompt on stdin: {a:?}");
            for f in flags(&a[1..at]) {
                assert!(help_lists(&exec, f), "[{}] `codex exec` doesn't list {f}", r.label("exec-help.txt"));
            }
            for f in flags(&a[at + 1..]) {
                assert!(help_lists(&resume, f), "[{}] `codex exec resume` doesn't list {f}", r.label("exec-resume-help.txt"));
            }
            assert!(a.windows(2).any(|w| w[0] == "-c" && w[1] == "model_reasoning_effort=\"high\""), "{a:?}");
            if read_only {
                assert!(a[..at].windows(2).any(|w| w[0] == "--sandbox" && w[1] == "read-only"), "{a:?}");
            }
        }
    }
}

#[test]
fn unknown_session_falls_back_to_a_fresh_run() {
    for r in recordings() {
        let stdout = r.text("resume/unknown-session.stdout");
        let stderr = r.text("resume/unknown-session.stderr");
        let mut accum = CodexAccum::default();
        for line in stdout.lines().filter(|l| !l.trim().is_empty()) {
            codex_fold_event(&mut accum, &serde_json::from_str(line).unwrap());
        }
        assert!(accum.session_id.is_none() && !accum.activity, "no JSONL at all on an unknown session");
        let out = build_codex_outcome(&accum, CliUsage::default(), false, ArtifactKind::Diff, "gpt-5.5", &stderr);
        assert!(matches!(out.status, StageStatus::Failed));
        assert!(!is_usage_unreported(out.error.as_deref().unwrap()), "nothing ran, nothing spent");
        let why = codex_resume_failure(SESSION, &accum, true, &stderr).expect("falls back");
        assert!(why.contains("no rollout found"), "{why}");
    }
}

#[test]
fn a_resumed_stream_keeps_its_session_id() {
    for r in recordings() {
        let mut fresh = CodexAccum::default();
        for v in r.jsonl("stream-json/fresh-offline.jsonl") {
            codex_fold_event(&mut fresh, &v);
        }
        let mut resumed = CodexAccum::default();
        for v in r.jsonl("stream-json/resume-offline.jsonl") {
            codex_fold_event(&mut resumed, &v);
        }
        assert!(fresh.session_id.is_some());
        assert_eq!(resumed.session_id, fresh.session_id, "[{}]", r.label("stream-json/resume-offline.jsonl"));
        let requested = fresh.session_id.clone().unwrap();
        assert_eq!(codex_resume_failure(&requested, &resumed, false, ""), None);
        // A stream that names another session never counts as resumed.
        assert!(codex_resume_failure("another-id", &resumed, false, "").is_some());
    }
}

/// Fold a stream the way `CliRunner::run_attempt` does.
fn fold(events: &[Value]) -> (CodexAccum, HashMap<String, CliUsage>) {
    let mut accum = CodexAccum::default();
    let mut map = HashMap::new();
    for v in events {
        codex_fold_event(&mut accum, v);
        if let Some((id, u)) = codex_usage_from_event(v) {
            let key = id.unwrap_or_else(|| format!("anon-{}", map.len()));
            map.insert(key, u);
        }
    }
    (accum, map)
}

#[test]
fn a_resumed_turn_counts_only_its_own_tokens() {
    for r in recordings() {
        let (accum, map) = fold(&r.jsonl("stream-json/resume.jsonl"));
        assert_eq!(accum.session_id.as_deref(), Some(SESSION));
        assert!(!accum.turn_open);
        // What the earlier run had reported (its `turn.completed` total).
        let baseline = SessionUsage { input_tokens: 20_000, output_tokens: 4_000, cache_read_tokens: 100_000, cache_creation_tokens: 0 };
        let total = sum_usage(&map);
        assert_eq!(total.input_tokens, 184_000 - 150_000);
        assert_eq!(total.cache_read_input_tokens, 150_000);
        let (counted, drift) = usage_since(&map, Some(baseline), Some(SESSION), accum.session_id.as_deref());
        assert_eq!(drift, None);
        let own = sum_usage(&counted);
        assert_eq!(own.input_tokens, 34_000 - 20_000);
        assert_eq!(own.cache_read_input_tokens, 50_000);
        assert_eq!(own.output_tokens, 9_100 - 4_000);
        let out = build_codex_outcome(&accum, own, true, ArtifactKind::Diff, "gpt-5.5", "");
        assert!(matches!(out.status, StageStatus::Done), "{:?}", out.error);
        assert!(out.artifact.text.starts_with("Addressed the review"));
        assert_eq!(out.input_tokens, 14_000);
        assert_eq!(codex_resume_failure(SESSION, &accum, false, ""), None);
        // The next resume subtracts the whole running total.
        assert_eq!(
            codex_session_usage(&accum, &total),
            Some(SessionUsage { input_tokens: 34_000, output_tokens: 9_100, cache_read_tokens: 150_000, cache_creation_tokens: 0 })
        );
        // Without a baseline (a fresh run), the map is untouched.
        assert_eq!(usage_since(&map, None, None, accum.session_id.as_deref()), (map.clone(), None));
    }
}

#[test]
fn a_resume_that_fails_before_any_message_falls_back_and_keeps_usage_unknown() {
    for r in recordings() {
        let (accum, map) = fold(&r.jsonl("stream-json/resume-turn-failed.jsonl"));
        let baseline = SessionUsage { input_tokens: 1, ..Default::default() };
        let own = sum_usage(&usage_since(&map, Some(baseline), Some(SESSION), accum.session_id.as_deref()).0);
        let resumed = build_codex_outcome(&accum, own, false, ArtifactKind::Diff, "gpt-5.5", "");
        assert!(matches!(resumed.status, StageStatus::Failed));
        // The turn started and never completed: its spend is unknown (#744).
        assert!(is_usage_unreported(resumed.error.as_deref().unwrap()));
        assert!(codex_session_usage(&accum, &sum_usage(&map)).is_none(), "an open turn leaves the total unknown");
        let why = codex_resume_failure(SESSION, &accum, true, "").expect("falls back once");
        assert!(why.contains("context window"), "{why}");

        // The fresh fallback finished: its result, both attempts' spend, and
        // the resumed attempt's unknown spend still flagged.
        let (fresh_accum, fresh_map) = fold(&r.jsonl("stream-json/resume.jsonl"));
        let fresh = build_codex_outcome(&fresh_accum, sum_usage(&fresh_map), true, ArtifactKind::Diff, "gpt-5.5", "");
        let fresh_input = fresh.input_tokens;
        let merged = merge_resume_fallback(resumed, fresh);
        assert!(matches!(merged.status, StageStatus::Done));
        assert_eq!(merged.input_tokens, fresh_input);
        assert!(merged.cli.usage_unreported);
    }
}

#[test]
fn resume_is_skipped_without_the_subcommand_or_a_baseline() {
    assert!(codex_resume_skip_reason(false, true).unwrap().contains("no `codex exec resume`"));
    assert!(codex_resume_skip_reason(true, false).unwrap().contains("never reported usage"));
    assert_eq!(codex_resume_skip_reason(true, true), None);
}

/// The resumed recording's total, minus a baseline above it in one field
/// (usage drift): nothing is subtracted, the raw usage is counted and the
/// reason says why — never a ~0 count.
#[test]
fn a_resumed_total_below_its_baseline_counts_the_raw_usage_and_says_why() {
    for r in recordings() {
        let (accum, map) = fold(&r.jsonl("stream-json/resume.jsonl"));
        let total = sum_usage(&map);
        // Output is above what the session now reports; the rest is below.
        let baseline = SessionUsage { input_tokens: 1, output_tokens: total.output_tokens + 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
        let (counted, drift) = usage_since(&map, Some(baseline), Some(SESSION), accum.session_id.as_deref());
        assert_eq!(sum_usage(&counted), total, "raw usage, nothing subtracted");
        let why = drift.expect("drift is reported");
        assert!(why.contains("below what it had reported"), "{why}");
        assert!(usage_drift_notice(&why).starts_with("Usage not reported exactly"));
        let out = build_codex_outcome(&accum, sum_usage(&counted), true, ArtifactKind::Diff, "gpt-5.5", "");
        assert_eq!(out.input_tokens, total.input_tokens, "not ~0");
    }
}

/// Codex streamed another session id than the one resumed: its total is not
/// a continuation of the stored baseline, so nothing is subtracted.
#[test]
fn a_resumed_stream_for_another_session_counts_the_raw_usage_and_says_why() {
    for r in recordings() {
        let (accum, map) = fold(&r.jsonl("stream-json/resume.jsonl"));
        let total = sum_usage(&map);
        let baseline = SessionUsage { input_tokens: 20_000, output_tokens: 4_000, cache_read_tokens: 100_000, cache_creation_tokens: 0 };
        let other = "00000000-0000-4000-8000-000000000000";
        let (counted, drift) = usage_since(&map, Some(baseline), Some(other), accum.session_id.as_deref());
        assert_eq!(sum_usage(&counted), total, "raw usage, nothing subtracted");
        let why = drift.expect("a session mismatch is reported");
        assert!(why.contains(other) && why.contains(SESSION), "{why}");
    }
}

#[test]
fn the_fallback_notice_says_could_not_resume_only_for_a_resume_problem() {
    for why in [
        "Codex answered with session b, not a",
        "thread/resume: thread/resume failed: no rollout found for thread id x (code -32600)",
        "unexpected argument '-s' found",
        "Codex ran out of room in the model's context window. Start a new thread.",
    ] {
        assert!(is_resume_problem(why), "{why}");
        assert!(codex_resume_failure_notice(why).starts_with("Codex could not resume"), "{why}");
    }
    for why in ["You've hit your usage limit.", "401 Unauthorized", "stream disconnected before completion: error sending request"] {
        assert!(!is_resume_problem(why), "{why}");
        let n = codex_resume_failure_notice(why);
        assert!(n.starts_with("Codex failed before answering on the resumed session"), "{n}");
        assert!(n.contains("running fresh once"), "{n}");
    }
}

#[test]
fn the_resume_prompt_words_answers_and_review_findings_apart() {
    let answers = crate::orchestrator::format_blocker_feedback(None, &["use sqlite".to_string()]);
    let p = CliDialect::Codex.resume_prompt(Some(&answers));
    assert!(p.starts_with("Your director answered your questions:"), "{p}");
    assert!(p.contains("use sqlite"), "{p}");
    assert!(!p.contains("reviewer"), "{p}");
    let p = CliDialect::Codex.resume_prompt(Some("fix the parser"));
    assert!(p.starts_with("A reviewer sent your earlier work"), "{p}");
    assert!(p.contains("fix the parser"), "{p}");
    assert!(!p.contains("director"), "{p}");
}
