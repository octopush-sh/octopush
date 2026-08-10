//! The `AgentRunner` abstraction and its API-substrate implementation.

use crate::chat_engine::resolve_provider;
use crate::error::AppResult;
use crate::orchestrator::agentic::run_agentic_loop;
use crate::orchestrator::events::EventSink;
use crate::orchestrator::types::{
    ArtifactKind, StageArtifact, StageInput, StageOutcome, StageSpec, StageStatus,
};
use std::path::PathBuf;
use std::sync::Arc;

/// Re-export compose_system_prompt from roles so callers can use it without
/// importing the roles module directly.
pub use crate::orchestrator::roles::compose_system_prompt;

/// Everything a runner needs to execute one stage, beyond the `StageSpec`.
pub struct StageContext {
    pub workspace_path: PathBuf,
    /// The original run task (seed for stage 1, context for later stages).
    pub task: String,
    pub client: reqwest::Client,
    /// Sink for live progress events (e.g. the CLI substrate streams its output).
    pub events: Arc<dyn EventSink>,
    pub run_id: String,
    pub stage_id: String,
    /// Director stop signal: set by `stop_current_stage`/`abort_run` while the
    /// stage is in flight. Substrates must check it and halt promptly.
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    /// The mission's execution isolation (`none` | `sandbox` | …). Re-derived per
    /// stage from the DB, so the detached worker sees it too. Only the CLI
    /// substrate acts on it (it wraps the spawn in a sandbox); `ApiRunner`
    /// ignores it (it never spawns a subprocess).
    pub exec_isolation: String,
    /// Directories a sandbox may write to (the workspace worktree at minimum).
    pub allowed_write_roots: Vec<String>,
    /// Skills the run's brief named (`/slug`), resolved against this worktree
    /// when the stage starts. Both substrates append their instructions to the
    /// stage's system prompt.
    pub skills: Vec<crate::skills::Skill>,
    /// Remaining run-budget headroom (USD) when this stage started, when the
    /// run has a budget. The API substrate stops opening new tool turns once
    /// the stage's own spend crosses it (see `run_agentic_loop`); the CLI
    /// substrate cannot be metered mid-flight and relies on the between-stage
    /// gate plus `--max-turns`.
    pub spend_limit: Option<f64>,
    /// Completed upstream stages this stage may consult via the `ask_stage`
    /// tool (API substrate): archived artifact + journal digest + the model
    /// that produced them.
    pub peers: Vec<crate::orchestrator::agentic::PeerStage>,
}

/// The error message for a stage whose agentic work ended without a final
/// answer: a director stop, or iteration exhaustion.
pub fn unfinished_stage_error(cancelled: bool, max_iterations: usize) -> String {
    if cancelled {
        "stopped by the director — review the work journal, then accept, re-run, or abort".to_string()
    } else {
        format!(
            "agentic loop hit {max_iterations} iterations without finishing — review the work journal, then re-run or abort"
        )
    }
}

/// Uniform execution contract — both API and (future) CLI substrates implement it.
#[async_trait::async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageInput,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome>;
}


/// Cap (chars) on a single full-detail dossier section fed to a stage.
/// Generous enough for a full plan or review (~4k tokens), tight enough that
/// a runaway artifact can't blow up every later stage's prompt. Truncation
/// keeps head + tail — intent and conclusions survive; boilerplate middles
/// are what get dropped.
pub(crate) const SECTION_CAP_CHARS: usize = 16_000;

/// Cap for an older same-kind section (kept for context, not the primary
/// input — see `InputSection::full_detail`).
pub(crate) const COMPACT_SECTION_CAP_CHARS: usize = 4_000;

/// Middle-truncate `s` to `cap` chars on char boundaries.
pub(crate) fn cap_to(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let head_budget = cap * 3 / 4;
    let tail_budget = cap - head_budget;
    let mut head_end = head_budget.min(s.len());
    while !s.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = s.len() - tail_budget;
    while !s.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    format!(
        "{}\n… [section truncated for length — the beginning and end are preserved] …\n{}",
        &s[..head_end],
        &s[tail_start..],
    )
}

/// Middle-truncate `s` to [`SECTION_CAP_CHARS`] on char boundaries.
pub(crate) fn cap_section(s: &str) -> String {
    cap_to(s, SECTION_CAP_CHARS)
}

/// Human-readable role for prompt attribution ("plan_review" → "plan review").
fn role_words(role: &str) -> String {
    role.replace('_', " ")
}

/// Repo agent-convention files surfaced to API-substrate stages, in priority
/// order. The Claude CLI reads these itself; an API-substrate agent (any
/// OpenAI-compat model) never saw them — so it wrote code ignoring the
/// project's own rules and the next reviewer bounced it for that. Mirrored
/// files (CLAUDE.md and AGENTS.md are often identical) dedupe by content.
const CONVENTION_FILES: &[&str] = &["CLAUDE.md", "AGENTS.md", "CONVENTIONS.md"];

/// The project-conventions section appended to an API-substrate stage's system
/// prompt: each convention file found at the workspace root, capped, deduped.
/// Empty string when none exist.
pub(crate) fn repo_conventions_section(workspace_path: &std::path::Path) -> String {
    let mut out = String::new();
    let mut seen: Vec<String> = Vec::new();
    for name in CONVENTION_FILES {
        let Ok(content) = std::fs::read_to_string(workspace_path.join(name)) else {
            continue;
        };
        let trimmed = content.trim();
        if trimmed.is_empty() || seen.iter().any(|s| s == trimmed) {
            continue;
        }
        seen.push(trimmed.to_string());
        out.push_str(&format!(
            "\n\nProject conventions from {name} — follow these while working in this repository:\n{}",
            cap_section(trimmed),
        ));
    }
    out
}

/// The dossier label for a section of the given kind.
fn section_label(kind: &ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::Plan => "The plan to follow",
        ArtifactKind::Review => "Review findings",
        ArtifactKind::Tests => "Tests from an earlier stage",
        ArtifactKind::Diff => "Summary of code changes so far",
        ArtifactKind::Note => "Context",
    }
}

/// Build the user message that seeds a stage: the task, a one-line pipeline
/// map, then the freshest artifact of each kind from earlier stages — each
/// attributed to its producing stage and capped — and finally any reviewer
/// feedback for a re-run. This is the stage's full working context; nothing
/// the pipeline has refined gets shadowed by whatever ran last.
pub fn user_input_for(
    role: &str,
    task: &str,
    input: &StageInput,
    feedback: Option<&str>,
) -> String {
    let mut s = format!("Task: {task}\n\n");
    if !input.breadcrumb.trim().is_empty() {
        s.push_str(&format!("Pipeline: {}\n\n", input.breadcrumb));
    }
    for sec in &input.sections {
        if sec.text.trim().is_empty() {
            continue;
        }
        if sec.full_detail {
            s.push_str(&format!(
                "{} (from the {} stage):\n{}\n\n",
                section_label(&sec.kind),
                role_words(&sec.role),
                cap_section(&sec.text),
            ));
        } else {
            // An earlier same-kind section: kept (compact) instead of being
            // silently evicted — the freshest section of this kind above/below
            // is the primary input.
            s.push_str(&format!(
                "{} (from the {} stage, step {} — earlier context; a fresher section of this kind follows the pipeline order):\n{}\n\n",
                section_label(&sec.kind),
                role_words(&sec.role),
                sec.position + 1,
                cap_to(&sec.text, COMPACT_SECTION_CAP_CHARS),
            ));
        }
    }
    // A reviewer/tester must judge the ACTUAL code: include the live worktree
    // diff when it was captured; otherwise fall back to the tools hint. This
    // is the single owner of the emptiness decision (the producer only maps
    // capture failures to None). BEGIN/END markers instead of a ``` fence —
    // a diff of a markdown file legitimately contains fence lines, which
    // would terminate a fenced block early and spill the rest into the prompt.
    if let Some(diff) = input.worktree_diff.as_deref().filter(|d| !d.trim().is_empty()) {
        let truncated = diff.len() > SECTION_CAP_CHARS;
        s.push_str(
            "The actual code changes in the workspace (git diff, staged + unstaged), between the markers:\n===== BEGIN GIT DIFF =====\n",
        );
        s.push_str(&cap_section(diff));
        s.push_str("\n===== END GIT DIFF =====\n");
        if truncated {
            s.push_str(
                "Note: the diff was too large to include in full (middle omitted) — run `git diff --stat` for the complete file list before judging coverage.\n",
            );
        }
        s.push_str(
            "The workspace is shared by the whole run, so the diff may include work from other stages or branches; weigh what is relevant to your task. Read any changed file with your tools when you need more context than the diff shows.\n\n",
        );
    } else if input.refs_worktree {
        s.push_str("The current code changes are present in the workspace; inspect them with your tools.\n\n");
    }
    // Attempt history BEFORE the current feedback: the history is context,
    // the feedback below is the binding directive for THIS attempt.
    if let Some(h) = input.history.as_deref().filter(|h| !h.trim().is_empty()) {
        s.push_str(&format!(
            "This stage has run before in this run. History of its previous attempts:\n{h}\n"
        ));
        s.push_str(
            "Do not repeat an approach that was already rejected, and do not undo a fix that earlier feedback demanded — that causes the loop to oscillate.\n\n",
        );
    }
    if let Some(fb) = feedback {
        s.push_str(&format!("Reviewer feedback to address this time:\n{fb}\n\n"));
        s.push_str(
            "Your previous attempt's changes may still be present in the workspace — revise them rather than starting over.\n\n",
        );
    }
    let _ = role; // role currently only affects system prompt; reserved for future shaping
    s
}


/// Parse the LAST `VERDICT: PASS|CHANGES_REQUESTED` line from a review stage's
/// output (case/space tolerant). `None` when absent or malformed — the caller
/// then falls back to a gated checkpoint rather than looping blindly.
pub fn parse_verdict(text: &str) -> Option<crate::orchestrator::types::ReviewVerdict> {
    use crate::orchestrator::types::ReviewVerdict;
    let mut found = None;
    for line in text.lines() {
        let upper = line.trim().to_ascii_uppercase();
        // Tolerate "VERDICT:" and "VERDICT :" (optional space before the colon).
        let Some(after_kw) = upper.strip_prefix("VERDICT") else { continue };
        let Some(rest) = after_kw.trim_start().strip_prefix(':') else { continue };
        let rest = rest.trim();
        // Match the leading token; trailing prose (e.g. "PASS (lgtm)") is tolerated.
        // Check CHANGES_REQUESTED first (distinct token).
        if rest.starts_with("CHANGES_REQUESTED") {
            found = Some(ReviewVerdict::ChangesRequested);
        } else if rest.starts_with("PASS") {
            found = Some(ReviewVerdict::Pass);
        }
    }
    found
}

/// The API substrate: runs a stage through the in-app LLM tool-loop.
pub struct ApiRunner;

#[async_trait::async_trait]
impl AgentRunner for ApiRunner {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageInput,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        let (provider, api_base, api_key) = resolve_provider(&stage.agent_model)?;
        // API substrate: the `ask_director` escape valve is available, so the
        // carve-out is included (`can_ask_director = true`).
        let mut system = compose_system_prompt(&stage.role_prompt, stage.role_environment, stage.loop_mode.clone(), stage.instructions.as_deref(), true);
        // Repo conventions (CLAUDE.md/AGENTS.md/…): the CLI substrate reads
        // them itself; the API substrate must be handed them explicitly or a
        // non-Claude implementer works blind to the project's rules.
        system.push_str(&repo_conventions_section(&ctx.workspace_path));
        // Skills the brief named reach the stage as instructions, not as a
        // literal `/slug` the agent would have to guess at — resolved here, at
        // the moment this role actually runs.
        system.push_str(&crate::skills::skill_prompt_section(&ctx.skills));
        // An answered ask_director block CONTINUES its saved conversation —
        // the exploration that led to the question is not re-run or re-paid.
        // The director's decisions (already formatted into `feedback`) arrive
        // as the ask's tool_result. A missing/corrupt transcript falls back
        // to the normal fresh-run seeding, where the same feedback text is
        // injected by `user_input_for`.
        let resumed_block = stage.blocked_transcript.as_deref().and_then(|json| {
            serde_json::from_str::<crate::orchestrator::agentic::BlockedTranscript>(json).ok()
        });
        let initial_messages = match &resumed_block {
            // Empty ask id = a CONTINUATION transcript (iteration-cap failure
            // or director stop, now Resumed): pick up exactly where the
            // conversation left off with a fresh turn budget.
            Some(t) if t.ask_tool_use_id.is_empty() => {
                let note = match stage.feedback.as_deref().filter(|f| !f.trim().is_empty()) {
                    Some(fb) => format!(
                        "{fb}\n\nThe director granted a fresh turn budget. Continue EXACTLY from \
                         where you left off — do not start over or redo completed work; finish the \
                         remaining work, then give your final answer."
                    ),
                    None => "The director granted a fresh turn budget. Continue EXACTLY from where \
                             you left off — do not start over or redo completed work; finish the \
                             remaining work, then give your final answer."
                        .to_string(),
                };
                crate::orchestrator::agentic::resume_messages_for_continuation(t, &note)
            }
            Some(t) => {
                let answer = stage
                    .feedback
                    .as_deref()
                    .filter(|f| !f.trim().is_empty())
                    .unwrap_or("The director approved proceeding with your recommended defaults.");
                crate::orchestrator::agentic::resume_messages_for_answered_block(t, answer)
            }
            None => crate::orchestrator::agentic::user_messages(&user_input_for(
                &stage.role,
                &ctx.task,
                input,
                stage.feedback.as_deref(),
            )),
        };

        let emitter = crate::orchestrator::live::LiveEmitter::new(
            ctx.events.as_ref(), &ctx.run_id, &ctx.stage_id);
        if let Some(t) = &resumed_block {
            emitter.notice(if t.ask_tool_use_id.is_empty() {
                "continuing the stage's previous conversation with a fresh turn budget"
            } else {
                "continuing the stage's own conversation with the director's answers"
            });
        }
        // The per-stage tool-turn budget (validated 1..=100 at save time);
        // clamp defensively so a corrupt row can never yield a zero-turn loop.
        let max_iterations = stage.max_iterations.max(1) as usize;
        let result = run_agentic_loop(
            provider.as_ref(),
            &api_base,
            api_key.as_deref(),
            &ctx.client,
            &stage.agent_model,
            &system,
            initial_messages,
            &ctx.workspace_path,
            max_iterations,
            &ctx.cancel,
            &emitter,
            stage.tools.as_deref(),
            stage.effort,
            if ctx.exec_isolation == "sandbox" {
                Some(ctx.allowed_write_roots.as_slice())
            } else {
                None
            },
            matches!(stage.loop_mode, Some(crate::orchestrator::types::LoopMode::Auto)),
            ctx.spend_limit,
            &ctx.peers,
        )
        .await;

        match result {
            Ok(r) => {
                // Own spend at the stage model's rate, plus any `ask_stage`
                // peer consultations already priced at each PEER model's rate.
                let cost = crate::orchestrator::cost::stage_cost(
                    &stage.agent_model,
                    r.input_tokens,
                    r.output_tokens,
                    r.cache_read_tokens,
                    r.cache_creation_tokens,
                ) + r.peer_cost_usd;
                // Escape valve: the stage called `ask_director`. This is neither
                // a success nor a failure — it's a block. Carry the questions up
                // so the drive parks the stage as an `awaiting_checkpoint`
                // decision; the spend it burned asking is preserved for the meter.
                if let Some(ask) = r.blocked.clone() {
                    return Ok(StageOutcome {
                        artifact: StageArtifact {
                            kind: ArtifactKind::Note,
                            text: String::new(),
                            payload: None,
                            refs_worktree: false,
                        },
                        input_tokens: r.input_tokens + r.peer_input_tokens,
                        output_tokens: r.output_tokens + r.peer_output_tokens,
                        cost_usd: cost,
                        status: StageStatus::AwaitingCheckpoint,
                        tool_calls: r.tool_calls,
                        error: None,
                        verdict: None,
                        session_id: None,
                        blocked: Some(ask),
                        blocked_transcript: r
                            .blocked_transcript
                            .as_ref()
                            .and_then(|t| serde_json::to_string(t).ok()),
                    });
                }
                // An unfinished loop is a failure, not a thin success: the
                // stage never produced a final answer, so don't hand its
                // placeholder text to the next stage. Usage is preserved for
                // cost accounting; the live journal stays as the evidence.
                // A director stop reads differently from iteration exhaustion.
                if !r.finished {
                    let cancelled = ctx.cancel.load(std::sync::atomic::Ordering::Relaxed);
                    return Ok(StageOutcome {
                        artifact: StageArtifact {
                            kind: ArtifactKind::Note,
                            text: String::new(),
                            payload: None,
                            refs_worktree: false,
                        },
                        input_tokens: r.input_tokens + r.peer_input_tokens,
                        output_tokens: r.output_tokens + r.peer_output_tokens,
                        cost_usd: cost,
                        status: StageStatus::Failed,
                        tool_calls: r.tool_calls,
                        error: Some(unfinished_stage_error(cancelled, max_iterations)),
                        verdict: None,
                        session_id: None,
                        blocked: None,
                        // The spent turns' conversation, so a Resume CONTINUES
                        // here with a fresh budget instead of starting over.
                        blocked_transcript: r
                            .blocked_transcript
                            .as_ref()
                            .and_then(|t| serde_json::to_string(t).ok()),
                    });
                }
                let kind = stage.artifact_kind.clone();
                let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);
                // Structured verdict first (submit_verdict tool call); the
                // text sentinel remains as a fallback for models that wrote
                // the line instead of calling the tool.
                let verdict = r.verdict.clone().or_else(|| parse_verdict(&r.text));
                if let Some(v) = &verdict {
                    emitter.notice(match v {
                        crate::orchestrator::types::ReviewVerdict::Pass => "Verdict: passed",
                        crate::orchestrator::types::ReviewVerdict::ChangesRequested => "Verdict: changes requested",
                    });
                }
                // A forced close at the iteration cap is a REAL but possibly
                // incomplete handoff — annotate it so the next stage (and any
                // reviewer) judges it with the right expectations.
                let text = if r.closed_at_cap {
                    format!(
                        "(this stage hit its tool-turn cap and was closed early — the summary below may be incomplete; verify before relying on it)\n\n{}",
                        r.text
                    )
                } else {
                    r.text.clone()
                };
                Ok(StageOutcome {
                    artifact: StageArtifact {
                        kind,
                        text,
                        payload: None,
                        refs_worktree,
                    },
                    input_tokens: r.input_tokens + r.peer_input_tokens,
                    output_tokens: r.output_tokens + r.peer_output_tokens,
                    cost_usd: cost,
                    status: StageStatus::Done,
                    tool_calls: r.tool_calls,
                    error: None,
                    verdict,
                    session_id: None,
                    blocked: None,
                    blocked_transcript: None,
                })
            }
            Err(e) => Ok(StageOutcome {
                artifact: StageArtifact {
                    kind: ArtifactKind::Note,
                    text: String::new(),
                    payload: None,
                    refs_worktree: false,
                },
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0.0,
                status: StageStatus::Failed,
                tool_calls: vec![],
                error: Some(e.to_string()),
                verdict: None,
                session_id: None,
                blocked: None,
                    blocked_transcript: None,
            }),
        }
    }
}
