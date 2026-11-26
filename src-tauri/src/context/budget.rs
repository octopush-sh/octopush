//! The per-model context budget of Talk's director (B1).
//!
//! At each round boundary the guard estimates how much of the model's window
//! the next request fills: the last response's real prompt size, plus
//! chars/3.5 of what changed since, times a per-model calibration that
//! converges on the provider's own counts. Past the soft threshold, older
//! tool results are replaced by stubs in the request only (the stored rows
//! never change), and each stub names its row for `recall_tool_output`. A
//! context-length error lowers the window trusted for the model, and the
//! request is stubbed to fit and sent once more. The calibration and the
//! lowered window are kept per model in `app_meta`.
//!
//! Sub-agents and Direct stages keep `orchestrator::agentic::compact_history`
//! until B8. The guard shares its size measure (`message_chars`), its soft
//! threshold and its assumed window.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::orchestrator::agentic::{message_chars, CONTEXT_FILL_RATIO_PCT, DEFAULT_CONTEXT_TOKENS};
use crate::providers::{Effort, LlmContent, LlmMessage, LlmResponse, LlmTool};

/// The window (tokens) assumed for a model the catalog doesn't list: low,
/// since small local models are the ones an overgrown history stops.
pub const DEFAULT_WINDOW_TOKENS: u64 = DEFAULT_CONTEXT_TOKENS as u64;
/// Share (%) of the usable window past which older tool results are stubbed.
pub const SOFT_PCT: u64 = CONTEXT_FILL_RATIO_PCT as u64;
/// Past this share (%), only the newest round is kept whole.
pub const HARD_PCT: u64 = 90;
/// Stubbing stops at this share (%), well under the soft threshold, so the
/// prompt-cache rewrite a stub costs happens now and then, not every round.
pub const TARGET_PCT: u64 = 50;
/// Characters per token in the estimate, before calibration.
pub const CHARS_PER_TOKEN: f64 = 3.5;
/// The whole rounds at the end of a request that are never stubbed.
pub const KEEP_ROUNDS: usize = 2;
/// A result this size or smaller stays whole: its stub would save little.
const STUB_MIN_CHARS: usize = 1_000;
/// What a stub keeps of its result, head and tail.
const STUB_KEEP_CHARS: usize = 600;
/// The weight of the newest reading in the calibration's moving average.
const CALIBRATION_WEIGHT: f64 = 0.3;
/// The range of one reading, so a provider that reports nonsense can't
/// swing the estimate.
const CALIBRATION_RANGE: (f64, f64) = (0.25, 4.0);
/// The lowest window an error without figures lowers a model to.
const MIN_WINDOW_TOKENS: u64 = 4_096;
/// A context-length error without figures: the window is taken as this
/// share (%) of the estimate of the request that failed.
const UNREPORTED_WINDOW_PCT: u64 = 85;

/// What every request of a turn carries besides its messages (chars): the
/// system prompt and the tool definitions.
pub fn fixed_chars(system: &str, tools: &[LlmTool]) -> usize {
    system.len() + serde_json::to_string(tools).map_or(0, |s| s.len())
}

fn request_chars(fixed_chars: usize, messages: &[LlmMessage]) -> usize { fixed_chars + messages.iter().map(message_chars).sum::<usize>() }

/// How much of a model's window a request may fill.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextBudget {
    /// The window trusted for the model (tokens).
    pub window: u64,
    /// The catalog doesn't list the model, so `window` is
    /// [`DEFAULT_WINDOW_TOKENS`].
    pub assumed: bool,
    /// The output the request asks for, kept free of the prompt.
    pub reserve: u64,
    /// The output cap asked for, before the clamp to half the window.
    asked: u64,
}

impl ContextBudget {
    /// The budget of a request on a model with the catalog's `window`
    /// (`None`: unknown) and output cap `max_tokens` (`0`: the effort's
    /// default cap). usable = window − output reserve.
    pub fn for_model(window: Option<u64>, max_tokens: u32, effort: Option<Effort>) -> Self {
        let known = window.filter(|w| *w > 0);
        let asked = if max_tokens > 0 { max_tokens } else { crate::orchestrator::agentic::max_tokens_for(effort) };
        Self { window: 0, assumed: known.is_none(), reserve: 0, asked: u64::from(asked) }
            .with_window(known.unwrap_or(DEFAULT_WINDOW_TOKENS))
    }

    /// The same request on another window. The reserve never takes more
    /// than half of it, so a small local window still leaves room to talk.
    fn with_window(self, window: u64) -> Self {
        Self { window, reserve: self.asked.min(window / 2), ..self }
    }

    pub fn usable(&self) -> u64 { self.window - self.reserve }
    /// `pct` percent of the usable window (tokens).
    pub fn share(&self, pct: u64) -> u64 { self.usable() * pct / 100 }
}

/// What the guard learned about one model, kept in `app_meta` under
/// `context_budget:<model>`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Learned {
    /// Real prompt tokens over the chars/3.5 estimate, as a moving average.
    pub calibration: Option<f64>,
    /// A window lowered by a context-length error (tokens).
    pub window: Option<u64>,
    /// The catalog window `window` was lowered from. Once the catalog says
    /// something else (the model's context size was edited in Settings ›
    /// Models), the lowered window no longer applies.
    pub lowered_from: Option<u64>,
}

fn meta_key(model: &str) -> String { format!("context_budget:{model}") }

/// What was learned about `model`; nothing when unset or unreadable.
pub fn load_learned(db: &Db, model: &str) -> Learned {
    db.meta_get(&meta_key(model)).ok().flatten().and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

pub fn save_learned(db: &Db, model: &str, learned: &Learned) -> AppResult<()> {
    db.meta_set(&meta_key(model), &serde_json::to_string(learned)?)
}

/// What the guard did to a request at a round boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stubbed {
    /// Tool results replaced by stubs.
    pub results: usize,
    /// The estimate before and after (tokens).
    pub before: u64,
    pub after: u64,
}

/// A context-length error the guard answered: the window it now trusts
/// (tokens) and the results it stubbed for the retry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recovery {
    pub window: u64,
    pub lowered: bool,
    pub results: usize,
}

/// One model's guard for one turn.
#[derive(Debug)]
pub struct ContextGuard {
    budget: ContextBudget,
    /// The catalog's window (or the assumed one), before any learned one.
    catalog_window: u64,
    learned: Learned,
    calibration: f64,
    /// The last request answered: its real prompt tokens and its size in chars.
    anchor: Option<(u64, usize)>,
    /// The size in chars of the request in flight.
    in_flight: Option<usize>,
    /// This round already retried after a context-length error.
    retried: bool,
}

fn clamp_reading(ratio: f64) -> f64 { ratio.clamp(CALIBRATION_RANGE.0, CALIBRATION_RANGE.1) }

impl ContextGuard {
    pub fn new(budget: ContextBudget, mut learned: Learned) -> Self {
        let catalog_window = budget.window;
        if learned.lowered_from != Some(catalog_window) {
            learned.window = None;
            learned.lowered_from = None;
        }
        let budget = match learned.window {
            Some(w) if w < catalog_window => budget.with_window(w),
            _ => budget,
        };
        let calibration = learned.calibration.filter(|c| c.is_finite() && *c > 0.0).map_or(1.0, clamp_reading);
        Self { budget, catalog_window, learned, calibration, anchor: None, in_flight: None, retried: false }
    }

    pub fn budget(&self) -> ContextBudget { self.budget }
    pub fn learned(&self) -> &Learned { &self.learned }
    pub fn calibration(&self) -> f64 { self.calibration }

    /// The estimate (tokens) of a request carrying `messages` after
    /// `fixed_chars` of system prompt and tools.
    pub fn estimate(&self, fixed_chars: usize, messages: &[LlmMessage]) -> u64 {
        self.estimate_chars(request_chars(fixed_chars, messages))
    }

    fn estimate_chars(&self, chars: usize) -> u64 {
        let tokens = |c: f64| c / CHARS_PER_TOKEN * self.calibration;
        let estimate = match self.anchor {
            Some((real, at)) => real as f64 + tokens(chars as f64 - at as f64),
            None => tokens(chars as f64),
        };
        estimate.max(0.0).round() as u64
    }

    /// The round boundary: every tool_use has its result. Past the soft
    /// threshold, older rounds' results are stubbed, oldest first, until the
    /// estimate is back at [`TARGET_PCT`]. The last [`KEEP_ROUNDS`] rounds
    /// stay whole (past the hard threshold, the last one). `rows` maps a
    /// tool_use id to its stored row. `None` under the soft threshold.
    pub fn before_round(&self, messages: &mut [LlmMessage], fixed_chars: usize, rows: &HashMap<String, i64>) -> Option<Stubbed> {
        let before = self.estimate(fixed_chars, messages);
        if before < self.budget.share(SOFT_PCT) {
            return None;
        }
        let keep = if before >= self.budget.share(HARD_PCT) { 1 } else { KEEP_ROUNDS };
        let results = self.stub_to(messages, fixed_chars, rows, self.budget.share(TARGET_PCT), keep);
        Some(Stubbed { results, before, after: self.estimate(fixed_chars, messages) })
    }

    /// Stub the results of the rounds before the last `keep`, oldest first
    /// and a whole round at a time, until the estimate is at most `target`.
    /// A round is an assistant turn with tool calls and the results up to the
    /// next one. Assistant turns are never edited, so signed thinking goes
    /// out as it came, and every tool_use keeps its result.
    fn stub_to(&self, messages: &mut [LlmMessage], fixed_chars: usize, rows: &HashMap<String, i64>, target: u64, keep: usize) -> usize {
        let starts: Vec<usize> = (0..messages.len())
            .filter(|&i| matches!(messages[i].content, LlmContent::AssistantWithTools { .. }))
            .collect();
        let eligible = starts.len().saturating_sub(keep.max(1));
        let mut stubbed = 0;
        for round in starts.windows(2).take(eligible) {
            if self.estimate(fixed_chars, messages) <= target {
                break;
            }
            for m in &mut messages[round[0] + 1..round[1]] {
                if let LlmContent::ToolResults(results) = &mut m.content {
                    for r in results.iter_mut().filter(|r| r.content.len() > STUB_MIN_CHARS) {
                        r.content = stub(&r.content, rows.get(&r.tool_use_id).copied());
                        stubbed += 1;
                    }
                }
            }
        }
        stubbed
    }

    /// The request about to go out carries `messages`.
    pub fn sent(&mut self, fixed_chars: usize, messages: &[LlmMessage]) {
        self.in_flight = Some(request_chars(fixed_chars, messages));
    }

    /// The answer to the request in flight. Its real prompt size (input,
    /// cache reads and cache writes) anchors the next estimate and updates
    /// the calibration. `true` when what was learned changed.
    pub fn observed(&mut self, response: &LlmResponse) -> bool {
        self.retried = false;
        let real = response.input_tokens + response.cache_read_tokens + response.cache_creation_tokens;
        match self.in_flight.take() {
            Some(chars) => self.reading(real, chars),
            None => false,
        }
    }

    /// One real prompt size (tokens) for a request of `chars`. A server that
    /// reports no usage leaves the estimate as it was.
    fn reading(&mut self, real: u64, chars: usize) -> bool {
        if real == 0 || chars == 0 {
            return false;
        }
        self.anchor = Some((real, chars));
        let ratio = clamp_reading(real as f64 / (chars as f64 / CHARS_PER_TOKEN));
        self.calibration = self.calibration * (1.0 - CALIBRATION_WEIGHT) + ratio * CALIBRATION_WEIGHT;
        self.learned.calibration = Some(self.calibration);
        true
    }

    /// A request that failed. When the provider said the prompt didn't fit
    /// and this round hasn't retried yet: the prompt size it reported (if
    /// any) becomes a reading, the window it reported (or, without one, 85%
    /// of the estimate of the request it refused) becomes the window trusted
    /// for the model, and the request is stubbed to fit it with only the
    /// last round whole. `None` otherwise. With no result stubbed, the same
    /// request would fail again: the caller then ends the turn as before.
    pub fn on_overflow(&mut self, error: &AppError, messages: &mut [LlmMessage], fixed_chars: usize, rows: &HashMap<String, i64>) -> Option<Recovery> {
        let AppError::Provider { kind, message, .. } = error else { return None };
        if self.retried || kind.is_transient() || !is_context_overflow(message) {
            return None;
        }
        self.retried = true;
        let chars = match self.in_flight.take() { Some(chars) => chars, None => request_chars(fixed_chars, messages) };
        let (prompt, limit) = overflow_figures(message);
        if let Some(prompt) = prompt {
            self.reading(prompt, chars);
        }
        let current = self.budget.window;
        let window = match limit {
            Some(limit) if limit < current => limit,
            // The window is right; the reported prompt corrected the estimate.
            Some(_) if prompt.is_some() => current,
            _ => (self.estimate_chars(chars) * UNREPORTED_WINDOW_PCT / 100).max(MIN_WINDOW_TOKENS).min(current),
        };
        let lowered = window < current;
        if lowered {
            self.budget = self.budget.with_window(window);
            self.learned.window = Some(window);
            self.learned.lowered_from = Some(self.catalog_window);
        }
        let results = self.stub_to(messages, fixed_chars, rows, self.budget.share(TARGET_PCT), 1);
        Some(Recovery { window, lowered, results })
    }

    /// The Player's line for a request the guard stubbed.
    pub fn stub_notice(&self, s: &Stubbed) -> String {
        let window = if self.budget.assumed && self.learned.window.is_none() {
            format!("an assumed {} tokens: the catalog doesn't list this model's window", short(self.budget.window))
        } else if self.learned.window.is_some() {
            format!("{} tokens, lowered after a prompt this model refused", short(self.budget.window))
        } else {
            format!("{} tokens", short(self.budget.window))
        };
        format!(
            "context window filling ({} of {window}) — shortened {} in this request; the model can recall them",
            short(s.before),
            earlier_results(s.results),
        )
    }

    /// The Player's line for a context-length error the guard answered.
    pub fn recovery_notice(&self, r: &Recovery) -> String {
        let window = if r.lowered { format!(", its window is now taken as {} tokens", short(r.window)) } else { String::new() };
        format!("prompt too long for this model{window} — shortened {}, retrying once", earlier_results(r.results))
    }
}

/// `118k`, or the plain count under a thousand.
fn short(tokens: u64) -> String {
    if tokens >= 1_000 { format!("{}k", (tokens + 500) / 1_000) } else { tokens.to_string() }
}

fn earlier_results(n: usize) -> String { format!("{n} earlier tool result{}", if n == 1 { "" } else { "s" }) }

/// A tool result's stub: its head and tail, with the row to recall it from
/// (`None`: no stored row, so the tool is re-run instead). A pure function
/// of the result and its row, so a stubbed request is byte-stable after it.
pub fn stub(result: &str, row: Option<i64>) -> String {
    let hint = match row {
        Some(id) => format!(" to fit the model's context window{}", crate::chat_history::recall_hint(id)),
        None => " to fit the model's context window — re-run the tool if you need it again".to_string(),
    };
    crate::chat_history::excerpt_head_tail(result, STUB_KEEP_CHARS, &hint)
}

/// Whether a provider's error says the prompt doesn't fit the model's
/// window, in the wordings of the Anthropic API, the OpenAI API and
/// OpenAI-compatible local servers. An output cap above the model's limit is
/// another error and doesn't match.
pub fn is_context_overflow(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    ["prompt is too long", "exceed context limit", "context_length_exceeded", "maximum context length", "context window", "context size", "context length"]
        .iter()
        .any(|p| m.contains(p))
}

static PROMPT_FIGURE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)prompt is too long:\s*(\d+)|context limit:\s*(\d+)|resulted in\s*(\d+)|\((\d+) in the messages|request \((\d+) tokens")
        .expect("prompt figure pattern")
});
static LIMIT_FIGURE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)>\s*(\d+)|maximum context length is\s*(\d+)|context size \((\d+)|context length of (?:only )?(\d+)")
        .expect("limit figure pattern")
});

/// The prompt size and the window (tokens) a context-length error reports,
/// where it reports them.
fn overflow_figures(message: &str) -> (Option<u64>, Option<u64>) {
    fn first(re: &Regex, message: &str) -> Option<u64> {
        re.captures_iter(message)
            .filter_map(|c| c.iter().skip(1).flatten().next().and_then(|g| g.as_str().parse::<u64>().ok()))
            .find(|n| *n >= 512)
    }
    (first(&PROMPT_FIGURE, message), first(&LIMIT_FIGURE, message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ProviderErrorKind;
    use crate::providers::{LlmRole, LlmStopReason, LlmToolResult, LlmToolUse};
    use serde_json::json;

    fn user(text: &str) -> LlmMessage { LlmMessage { role: LlmRole::User, content: LlmContent::Text(text.into()) } }

    /// One round: an assistant turn calling `ids` (signed thinking first when
    /// `thinking`), then their results of `chars` each.
    fn round(ids: &[&str], chars: &[usize], thinking: bool) -> Vec<LlmMessage> {
        let tool_uses: Vec<LlmToolUse> = ids
            .iter()
            .map(|id| LlmToolUse { id: id.to_string(), name: "read_file".into(), input: json!({ "path": "a.rs" }) })
            .collect();
        let mut raw = Vec::new();
        if thinking {
            raw.push(json!({ "type": "thinking", "thinking": "look first", "signature": "sig" }));
            for u in &tool_uses {
                raw.push(json!({ "type": "tool_use", "id": u.id, "name": u.name, "input": u.input }));
            }
        }
        let results = ids
            .iter()
            .zip(chars)
            .map(|(id, n)| LlmToolResult { tool_use_id: id.to_string(), content: "r".repeat(*n), is_error: false })
            .collect();
        vec![
            LlmMessage {
                role: LlmRole::Assistant,
                content: LlmContent::AssistantWithTools { raw, text: String::new(), tool_uses },
            },
            LlmMessage { role: LlmRole::User, content: LlmContent::ToolResults(results) },
        ]
    }

    /// An answer whose prompt was `prompt` tokens, mostly cache reads.
    fn response(prompt: u64) -> LlmResponse {
        LlmResponse {
            text: String::new(), tool_uses: Vec::new(), stop_reason: LlmStopReason::ToolUse, output_tokens: 40,
            input_tokens: prompt / 10, cache_read_tokens: prompt - prompt / 10, cache_creation_tokens: 0,
            rate_limit: None, raw_content: Vec::new(),
        }
    }

    fn results_of(m: &LlmMessage) -> Vec<String> {
        match &m.content {
            LlmContent::ToolResults(rs) => rs.iter().map(|r| r.content.clone()).collect(),
            _ => Vec::new(),
        }
    }

    fn is_stub(s: &str) -> bool { s.contains("to fit the model's context window") }
    /// Tool call `t<i>`'s stored row is `100 + i`.
    fn rows(n: i64) -> HashMap<String, i64> { (1..=n).map(|i| (format!("t{i}"), 100 + i)).collect() }
    fn provider_error(kind: ProviderErrorKind, message: &str) -> AppError {
        AppError::Provider { kind, retry_after: None, message: message.into() }
    }

    #[test]
    fn guard_triggers_at_soft() {
        // usable 18k, soft 12.6k, target 9k tokens.
        let budget = ContextBudget::for_model(Some(20_000), 2_000, None);
        assert_eq!((budget.usable(), budget.share(SOFT_PCT), budget.share(HARD_PCT)), (18_000, 12_600, 16_200));
        let guard = ContextGuard::new(budget, Learned::default());
        let mut messages = vec![user("fix the build")];
        for i in 1..=4 {
            messages.extend(round(&[format!("t{i}").as_str()], &[9_000], false));
        }
        // About 10.3k tokens: under the soft threshold, nothing changes.
        let untouched = messages.clone();
        assert_eq!(guard.before_round(&mut messages, 0, &rows(5)), None);
        assert_eq!(format!("{messages:?}"), format!("{untouched:?}"));

        // A fifth round crosses it: the oldest rounds are stubbed until the
        // estimate is back at the target, and each stub names its row.
        messages.extend(round(&["t5"], &[9_000], false));
        let s = guard.before_round(&mut messages, 0, &rows(5)).expect("past the soft threshold");
        assert!(s.before >= budget.share(SOFT_PCT), "{s:?}");
        assert_eq!(s.results, 2, "{s:?}");
        assert!(s.after <= budget.share(TARGET_PCT), "{s:?}");
        let r1 = &results_of(&messages[2])[0];
        assert!(is_stub(r1) && r1.contains("call recall_tool_output with message_id 101"), "{r1}");
        assert!(r1.len() < STUB_MIN_CHARS, "a stub is never stubbed again: {}", r1.len());
        assert!(results_of(&messages[4])[0].contains("message_id 102"));
        // The third round wasn't needed; the last two are never touched.
        for i in [6, 8, 10] {
            assert_eq!(results_of(&messages[i])[0], "r".repeat(9_000), "message {i}");
        }
        let line = guard.stub_notice(&s);
        assert!(line.starts_with("context window filling (13k of 20k tokens) — shortened 2 earlier tool results"), "{line}");

        // An unknown model runs on the assumed window, and the line says so.
        let assumed = ContextGuard::new(ContextBudget::for_model(None, 2_000, None), Learned::default());
        assert_eq!(assumed.budget().window, DEFAULT_WINDOW_TOKENS);
        assert!(assumed.stub_notice(&s).contains("an assumed 100k tokens: the catalog doesn't list this model's window"));
    }

    #[test]
    fn prompt_too_long_lowers_window_and_retries_once() {
        let budget = ContextBudget::for_model(Some(200_000), 8_000, None);
        let mut guard = ContextGuard::new(budget, Learned::default());
        let mut messages = vec![user("refactor the parser")];
        for i in 1..=6 {
            messages.extend(round(&[format!("t{i}").as_str()], &[60_000], false));
        }
        // About 103k tokens by the estimate: the guard sees no need to act.
        assert_eq!(guard.before_round(&mut messages, 0, &rows(6)), None);
        guard.sent(0, &messages);

        let too_long = provider_error(
            ProviderErrorKind::BadRequest,
            r#"Anthropic API error 400 Bad Request: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 150000 tokens > 120000 maximum"}}"#,
        );
        let last_round = format!("{:?}", &messages[11..]);
        let r = guard.on_overflow(&too_long, &mut messages, 0, &rows(6)).expect("recovers the first time");
        assert_eq!((r.window, r.lowered), (120_000, true));
        assert!(r.results > 0, "{r:?}");
        assert!(guard.estimate(0, &messages) <= guard.budget().usable() / 2, "fits the lowered window");
        assert_eq!(format!("{:?}", &messages[11..]), last_round, "the newest round stays whole");
        assert_eq!(guard.learned().window, Some(120_000));
        assert_eq!(guard.learned().lowered_from, Some(200_000));
        assert!(guard.recovery_notice(&r).starts_with("prompt too long for this model, its window is now taken as 120k tokens"));

        // Once: the same round failing again ends the turn.
        guard.sent(0, &messages);
        assert_eq!(guard.on_overflow(&too_long, &mut messages, 0, &rows(6)), None);
        // An answered round may recover again later.
        assert!(guard.observed(&response(60_000)));
        guard.sent(0, &messages);
        assert!(guard.on_overflow(&too_long, &mut messages, 0, &rows(6)).is_some());

        // Other failures are not context errors, whatever their numbers.
        let mut fresh = ContextGuard::new(budget, Learned::default());
        for e in [
            provider_error(ProviderErrorKind::BadRequest, "max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens"),
            provider_error(ProviderErrorKind::RateLimit, "prompt is too long"),
            AppError::Other("prompt is too long".into()),
        ] {
            assert_eq!(fresh.on_overflow(&e, &mut messages, 0, &rows(6)), None, "{e}");
        }

        // A window lowered from another catalog window no longer applies.
        let learned = guard.learned().clone();
        assert_eq!(ContextGuard::new(budget, learned.clone()).budget().window, 120_000);
        let edited = ContextGuard::new(ContextBudget::for_model(Some(256_000), 8_000, None), learned);
        assert_eq!((edited.budget().window, edited.learned().window), (256_000, None));
    }

    #[test]
    fn reads_figures_from_context_length_errors() {
        let cases: [(&str, Option<u64>, Option<u64>); 5] = [
            ("prompt is too long: 215000 tokens > 200000 maximum", Some(215_000), Some(200_000)),
            (
                "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again",
                Some(188_240),
                Some(200_000),
            ),
            (
                "This model's maximum context length is 128000 tokens. However, your messages resulted in 130567 tokens.",
                Some(130_567),
                Some(128_000),
            ),
            ("request (9000 tokens) exceeds the available context size (8192 tokens)", Some(9_000), Some(8_192)),
            ("context length exceeded", None, None),
        ];
        for (message, prompt, limit) in cases {
            assert!(is_context_overflow(message), "{message}");
            assert_eq!(overflow_figures(message), (prompt, limit), "{message}");
        }

        // Without figures, the window is taken as 85% of what was refused.
        let budget = ContextBudget::for_model(None, 32_768, None);
        let mut guard = ContextGuard::new(budget, Learned::default());
        let mut messages = vec![user("go")];
        for i in 1..=3 {
            messages.extend(round(&[format!("t{i}").as_str()], &[14_000], false));
        }
        guard.sent(0, &messages);
        let sent = guard.estimate(0, &messages);
        let e = provider_error(ProviderErrorKind::BadRequest, "OpenAI-compat API error 400: context length exceeded");
        let r = guard.on_overflow(&e, &mut messages, 0, &rows(3)).expect("recovers");
        assert_eq!(r.window, sent * 85 / 100);
        assert!(r.lowered && r.results > 0, "{r:?}");
        // The reserve never takes more than half of a small window.
        assert_eq!(guard.budget().reserve, r.window / 2);
    }

    #[test]
    fn calibration_converges() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let model = "local-model-q4";
        let mut guard = ContextGuard::new(ContextBudget::for_model(Some(10_000_000), 4_096, None), load_learned(&db, model));
        assert_eq!(guard.calibration(), 1.0);
        // This model's tokenizer counts 1.6x the chars/3.5 estimate.
        let mut messages = vec![user("explain the module")];
        let fixed = 2_000;
        for i in 0..25 {
            messages.extend(round(&[format!("t{i}").as_str()], &[7_000], false));
            guard.sent(fixed, &messages);
            let real = (request_chars(fixed, &messages) as f64 / CHARS_PER_TOKEN * 1.6).round() as u64;
            assert!(guard.observed(&response(real)));
            save_learned(&db, model, guard.learned()).unwrap();
        }
        assert!((guard.calibration() - 1.6).abs() < 0.01, "{}", guard.calibration());
        // The next request's estimate lands on the provider's count.
        messages.extend(round(&["next"], &[7_000], false));
        let real = request_chars(fixed, &messages) as f64 / CHARS_PER_TOKEN * 1.6;
        let estimate = guard.estimate(fixed, &messages) as f64;
        assert!((estimate - real).abs() / real < 0.01, "{estimate} vs {real}");

        // Kept per model: a new turn starts calibrated, another model doesn't.
        let next_turn = ContextGuard::new(ContextBudget::for_model(Some(10_000_000), 4_096, None), load_learned(&db, model));
        assert!((next_turn.calibration() - 1.6).abs() < 0.01);
        assert_eq!(load_learned(&db, "another-model"), Learned::default());
        // A server that reports no usage leaves the estimate alone.
        guard.sent(fixed, &messages);
        assert!(!guard.observed(&response(0)));
    }

    #[test]
    fn keep_tail_never_splits_a_round() {
        let mut messages = vec![user("review the crate")];
        messages.extend(round(&["t1", "t2"], &[20_000, 20_000], true));
        messages.extend(round(&["t3", "t4", "t5"], &[20_000, 500, 20_000], false));
        messages.extend(round(&["t6"], &[20_000], true));
        messages.extend(round(&["t7", "t8"], &[20_000, 20_000], true));
        let original = messages.clone();
        let assistants = [1, 3, 5, 7];
        let check = |messages: &[LlmMessage], whole_from: usize| {
            for i in assistants {
                assert_eq!(format!("{:?}", messages[i]), format!("{:?}", original[i]), "assistant turn {i} is never edited");
            }
            for (i, m) in messages.iter().enumerate().skip(1) {
                let results = results_of(m);
                if i >= whole_from {
                    assert_eq!(format!("{m:?}"), format!("{:?}", original[i]), "message {i} is in the kept tail");
                } else if !results.is_empty() {
                    // A round goes whole or not at all: every large result
                    // of it is stubbed, a small one stays as it was.
                    for (r, o) in results.iter().zip(results_of(&original[i])) {
                        assert_eq!(is_stub(r), o.len() > STUB_MIN_CHARS, "message {i}");
                    }
                }
            }
        };

        // Between soft and hard: the last two rounds stay whole.
        let mut between = messages.clone();
        let guard = ContextGuard::new(ContextBudget::for_model(Some(52_000), 2_000, None), Learned::default());
        let s = guard.before_round(&mut between, 0, &rows(8)).expect("past soft");
        assert!(s.before < guard.budget().share(HARD_PCT), "{s:?}");
        assert_eq!(s.results, 4, "two whole rounds: {s:?}");
        check(&between, 5);

        // Past hard: only the newest round stays whole.
        let guard = ContextGuard::new(ContextBudget::for_model(Some(30_000), 2_000, None), Learned::default());
        let s = guard.before_round(&mut messages, 0, &rows(8)).expect("past hard");
        assert!(s.before >= guard.budget().share(HARD_PCT), "{s:?}");
        assert_eq!(s.results, 5, "{s:?}");
        check(&messages, 7);
    }
}
