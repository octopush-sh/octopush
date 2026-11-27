# Talk engine v2: design

**Status:** adopted by the PM 2026-11-26. Slices are tracked in #1141 (A), #1143 (B), #1145 (C).

Designed against `main` at `4db3d9ac`. `rs/` = `src-tauri/src/`. The in-flight Talk fixes (for example #1169, director reliability, and #1170, MCP tool order and caps) are assumed landed. Nothing here is built.

---

## 0. Decision: the director converges on one loop

**Yes: one loop, two hosts.** `orchestrator/agentic.rs::run_agentic_loop` owns retry, pacing, caps, compaction and forced close. `chat_engine.rs::run_agentic_turn` (about 1,100 lines) re-implements the round cycle around persistence, the shared shell, approvals and the fan-out. Streaming, steering, the context guard and permission modes all need the same seam, the boundary between rounds. Building them twice repeats the drift the audit found.

New module `rs/agent_loop/`. `run_loop(cfg, host)` owns the round cycle, `stream_with_retry`, throttle, truncation recovery, forced close and the transcript. The seam:

```rust
#[async_trait]
pub trait LoopHost: Send + Sync {
    /// Round boundary: every tool_use has its result. Cancel, budget, steer drain,
    /// mode re-read and the context guard happen here and nowhere else.
    async fn before_round(&self, st: &mut LoopState) -> RoundDirective; // Continue | Stop | Close
    fn on_stream(&self, round: usize, ev: &StreamEvent);
    async fn on_assistant_round(&self, round: usize, resp: &LlmResponse) -> AppResult<()>;
    async fn execute_round(&self, round: usize, uses: &[LlmToolUse]) -> Vec<LlmToolResult>;
    fn on_usage(&self, resp: &LlmResponse);
}
```

- `StageHost` (Direct stages, Talk sub-agents) wraps today's executor, `ToolGate` and `ExternalTools`. `run_agentic_loop` stays as a thin wrapper, so `chat_agents.rs` and `runner.rs` don't change.
- `TalkHost` (`rs/talk_host.rs`) carries what is director-only: row persistence, `chat://*` events, the shared shell, `ApprovalBroker`, the `Agent` fan-out, recall, file attribution, `TurnUsage`.

`LoopHost` needs no `AppHandle`, which closes the audit's "no test for `run_agentic_turn`" gap (#1161). The migration is a strangler (slices A3 to A5) behind `talkEngine: "v2" | "legacy"` for one release.

---

## Epic A. Streaming and steering

**Where we go further.** A steer is addressed, checkpointed and attributed. It can target the director or one named running sub-agent of any vendor. The tree is snapshotted at the boundary where it lands, so "rewind files to before I steered" exists. It is a row in the thread, so history and the ledger show what changed course and when. Token streaming itself is **parity**: SSE is the one sensible way, and time to first token is felt on every turn.

**Observed today.** Other agentic tools stream text as it is generated; some deliver a message typed mid-turn at the next tool boundary, and some separate "join the running turn" from "queue for the next one" (the audit's comparison table).

### Architecture

**Provider streaming** (`rs/providers/mod.rs`, new `rs/providers/sse.rs`; reqwest's `stream` feature is already on):

```rust
pub enum StreamEvent { Text(String), ToolStart{index,id,name}, ToolInput{index,partial}, ToolEnd{index}, Reset }
async fn stream(&self, …, req, client, sink: &mut dyn FnMut(StreamEvent)) -> AppResult<LlmResponse>;
```

- The default implementation calls `complete` and emits one `Text`, so a provider that can't stream works unchanged.
- It returns the same assembled `LlmResponse` (usage, `raw_content`), so pricing and replay don't move.
- `stream_with_retry` extends `complete_with_retry`: a transient error mid-stream emits `Reset` and retries; an idle gap over 60 s after a 200 is final, never retried, like a dropped body (the provider may still be generating, so a retry could run and bill the request twice); the request races the turn's cancel.

**Events.** `chat://stream` gains additive `round`, `kind: "text" | "narration"` and `reset`.
- On a round's first `ToolStart` the host emits `kind: "narration"`, and the frontend moves that buffer into the work block (`.octo-fade-in`).
- `chat://tool-start` fires at `ToolStart` with `pending: true`; the hint fills in at `ToolEnd`.
- Deltas are coalesced to one event per 30 ms.

**Stop mid-stream.** Partial text is persisted as an `assistant` row with `partial = 1`, then the `stopped` note, so "continue" has context. Its usage is recorded with `cost_basis = 'estimated'` (already a legal value).

**Inbox** (new `rs/chat_inbox.rs`, held by `ChatEngine`):

```sql
CREATE TABLE IF NOT EXISTS chat_inbox (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL,            -- queue | steer
  target TEXT,                   -- NULL = director, else a sub-agent call_id
  text TEXT NOT NULL, request_json TEXT NOT NULL,   -- model and effort at enqueue time
  state TEXT NOT NULL DEFAULT 'pending',            -- pending | joined | sent | returned
  consumed_message_id INTEGER, created_at TEXT NOT NULL);
ALTER TABLE chat_messages ADD COLUMN joined_turn INTEGER;  -- the turn's user-row id
ALTER TABLE chat_messages ADD COLUMN partial INTEGER;
```

Commands `enqueue_chat_input`, `edit_chat_input`, `remove_chat_input`, `promote_chat_input`, `list_chat_inbox`; event `chat://inbox`.

| Input while a turn runs | Meaning |
|---|---|
| ↵ | **Queue.** FIFO. The backend starts it as a normal turn (own checkpoint, budget gate) when the running turn ends normally. After an error, a Stop or a budget cap it stays queued and visible. `$` lines only queue. |
| ⌘↵ | **Steer.** Joins the running turn at the next round boundary. |
| "Steer now" | Interrupts the round with a round-scoped token, distinct from Stop: an in-flight generation is dropped and re-issued; a running command gets an "interrupted by the user" result. |

**How a steer enters safely.** Only in `before_round`, so never between a `tool_use` and its result, and never in a half-executed round. In one DB transaction the host marks the items `joined`, inserts a `user` row with `joined_turn`, and appends the text to the tail message through a new `LlmContent::ToolResultsThenText(results, text)`. Anthropic serializes it as result blocks then a text block; OpenAI-compatible as tool messages then a user message.

- **Checkpoint.** A snapshot under the steer row's id (`talk_checkpoints::capture_before`, off-runtime, concurrent with the next request, joined before the next round's tools run).
- **Missed boundary.** A steer arriving during the final answer becomes the head of the queue; its tag changes to "sent next".
- **Stop** returns pending steers to the composer as a draft. **Restart** shows pending items and never auto-sends them.
- **History.** `joined_turn` rows belong to their turn and must not advance the "turns ago" count.

**Per-crew steering.** `target = call_id`. `run_subagents` gives each `StageHost` an inbox handle; the same seam applies. Focusing a crew row (`crewFocusByWs`) puts a "to explorer" chip in the composer. A director round blocks on the whole fan-out, so this is the only way to correct one of eight agents without stopping the rest.

**Frontend.** `chatStore` gains `inboxByThread`; `streamBufferByWs` becomes `{round, kind, text}`. `Composer.tsx` drops `disabled={streaming}`; Send crossfades to "Queue". Queued and steered items are ask insets in `ChatCanvas` (`.octo-rise-in`, editable, removable).

### Slices

| # | Slice | Acceptance and tests |
|---|---|---|
| A1 | `StreamEvent`, `LlmProvider::stream` default, `sse.rs`, Anthropic SSE | Fixture transcripts: `anthropic_sse_text_tool_usage`, `partial_tool_json_assembles`, `stream_equals_complete_response`, `mid_stream_overloaded_resets_and_retries`, `idle_gap_is_network_error` |
| A2 | OpenAI-compatible SSE (Chat Completions, Responses) | `openai_sse_*` parity; `provider_without_stream_falls_back` |
| A3 | `agent_loop/`, `LoopHost`, `StageHost`; `run_agentic_loop` as wrapper | Existing `agentic` and `chat_agents` tests pass unchanged; `mock_host_drives_three_rounds` |
| A4 | Extract the director's tool execution into `talk_host.rs`, still called from the old loop | No behaviour change; first unit tests for approval-deny, MCP-off refusal, shell fallback |
| A5 | `TalkHost` on `run_loop` behind `talkEngine`; deltas, live cards, narration reclassify | `first_delta_before_response_ends`, `narration_never_renders_as_answer`, `stop_keeps_partial_row`, `forced_close_unchanged`. FEATURES, changeset |
| A6 | `chat_inbox`, commands, backend queue auto-send | `queue_fifo`, `queue_held_after_stop_or_error`, `queued_turn_meets_budget_gate`, `pending_survives_restart_unsent` |
| A7 | Steer at the boundary, `ToolResultsThenText`, steer checkpoint | `steer_lands_after_tool_results_only`, `steer_row_does_not_age_tool_rows`, `missed_boundary_becomes_queue_head`, `steer_checkpoint_is_not_an_outside_change` |
| A8 | Composer and canvas UI | Vitest: ↵/⌘↵ routing, edit, remove, `$` queues only, reduced motion. Appendix C, `data-tour` |
| A9 | Per-crew steer; "Steer now" | `steer_reaches_only_target_agent`, `dropped_round_executes_no_tools` |

### Risks
- **A5 is the riskiest slice here.** Mitigations: the flag, A3 and A4 landing first with no behaviour change, transcript-fixture tests.
- Event rate with eight streaming sub-agents: coalesce to 150 ms per agent; never persist deltas.
- A steer checkpoint adds snapshot time; budget and skip it like a turn checkpoint.
- Strict providers may reject a user message after tool messages; test per adapter.

### Ten-year version
Steering becomes fleet-level: one instruction addressed to many agents from Mission Control, each landing at its own safe boundary, with a trail of who was told what. The inbox table and the `before_round` seam already have that shape.

---

## Epic B. Context engine

**Where we go further.** Compaction is a visible, reversible event with a receipt. Originals never leave SQLite. The summary is a row showing tokens and dollars before and after. Any summarized span can be restored verbatim, here or in a fork. The model can fetch any original by id or by search. The factual half of the summary (files touched, commands and exit status, sub-agent reports) is computed from checkpoints and tool rows, not recalled by a model. Cache health is a per-turn number on the ledger.

**Observed today.** Other tools compact automatically near the window and on command, replacing earlier conversation with a model-written summary; the replaced content is not offered back (the audit's comparison table).

### Architecture (`rs/context/`)

**1. `transcript.rs`: an append-only transcript.** It replaces `chat_history::build_history` for v2 threads.

```sql
ALTER TABLE chat_messages ADD COLUMN raw_json TEXT;       -- the round's verbatim blocks + origin model
ALTER TABLE chat_messages ADD COLUMN tool_use_id TEXT;
ALTER TABLE chat_messages ADD COLUMN model_view TEXT;     -- the exact capped text the model was given
ALTER TABLE chat_messages ADD COLUMN context_blocks TEXT; -- the @ blocks' spans in content (#1150)
ALTER TABLE chat_messages ADD COLUMN pinned INTEGER;
```

- A tool result is capped **once**, when written (`model_view`, sized from the model's window), and replayed byte-for-byte from then on. The full output stays in `content` for recall.
- Legacy rows render at the fixed settled allowance: a function of the row, never of its age.
- `context_blocks` is the `@` record (shipped with #1150): one entry per block, `{token, kind, label, tokens, start, end, notIncluded?}`, its span in `content` in UTF-16 units. `content` stays the full text the model received; the UI shows the typed part and a chip per block, and `recall_tool_output {message_id, block}` returns a block whole.
- **The accepted exception** to "a function of the row, never of its age": a block of 8k characters or more goes out whole in the turn it was attached to and shortened from the next turn on (head + tail within the settled allowance, with its recall id). The shortened form is a pure function of the block, so the change happens once and the row is byte-stable after it; it costs one cache write from that row on, once. Smaller blocks are never shortened. Shortened blocks count against the thread budget at their settled size from their own turn on.
- So the prefix only grows, and the fresh-to-settled rewrite (audit F7a) disappears by construction.
- `raw_json` is replayed only to its origin model; after a model switch the round is rebuilt from text and tool uses. `ComposerEstimate` prices the whole prompt at the full input rate, so its figure already covers that miss.

**2. A byte-stable prefix.** System = base prompt, memory, doctrine. Everything volatile (this turn's skills, the plan and steps, the permission mode) goes in a turn-context text block in the **tail** user message. The tool list never changes with skills or modes; gating happens at execution (Epic C).

**3. `cache_plan.rs`.** `LlmRequest.cache: bool` becomes `CachePlan { message_points, ttl }`.
- Four breakpoints: tools, system, **the previous request's tail position**, the new tail. With an append-only transcript the previous tail is always a valid prefix, so the read holds however wide the round was (F7b).
- `talkCacheTtl: "auto" | "5m" | "1h"`; auto picks 1 h on system and tools when the thread's median gap between turns exceeds five minutes.
- OpenAI-compatible requests send the thread id as the cache key.
- Confirm each rule against the provider's current documentation when building.

**4. `budget.rs`: the per-model guard.**
- `ContextBudget::for_model(info, max_tokens, effort)`: usable = `max_context` − output reserve; soft 70 %, hard 90 %.
- Estimate = the last response's real prompt size + chars/3.5 of what was appended since, times a per-model calibration (EWMA of real over estimated, in `app_meta`), so local models with unusual tokenizers converge.
- On a context-length 400: record a lowered window for that model, compact, retry once.
- It runs in `before_round` for both hosts and replaces `compact_history`.

**5. `compact.rs`: segments.**

```sql
CREATE TABLE IF NOT EXISTS chat_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
  from_message_id INTEGER NOT NULL, through_message_id INTEGER NOT NULL,
  summary_message_id INTEGER NOT NULL,          -- a chat_messages row, role 'summary'
  kind TEXT NOT NULL,                           -- auto | manual | overflow
  state TEXT NOT NULL DEFAULT 'active',         -- active | restored
  tokens_before INTEGER, tokens_after INTEGER, cost_usd REAL, model TEXT, created_at TEXT NOT NULL);
```

*Kept verbatim:* system, memory and tools; every user-authored message (`context_blocks` excluded); the last three whole turns or 30 % of the soft budget, whichever is larger, never splitting a tool pair or a signed-thinking round; pinned messages; the plan and steps (re-injected from the DB); ids of open approvals and continuable sub-agent runs.

*Summarized:* older narration, tool calls and results, and assistant answers, in two parts.
- **Computed**, zero tokens: files touched (`file_edits` plus a `diff-tree` across the span's checkpoints), commands with exit status, sub-agent reports by call id, an index of originals (`#id · tool · size`).
- **Written:** intent, decisions and their reasons, open questions, by a fast-tier model through `run_subagent_core` with no tools; ledger origin `summary:<segment>`.
- If the writer fails, the computed part plus stubbed `model_view`s is used. The turn never blocks on it.

*Recall:* `recall_tool_output` accepts any covered row id; a new `search_history {query}` runs over an FTS5 index of covered rows. Both are always in the tool list.

*Undo:* `restore_chat_segment(id)` sets `restored` and the transcript ignores the segment. If the originals no longer fit the current model, it is refused with the reason and two exits: restore in a fork, or switch to a larger-window model.

*When:* at turn start past the soft threshold; **opportunistically when the cache has already expired** (gap over the TTL, fill over 50 %), since that request pays a full write anyway; mid-turn only at the hard threshold, mechanically, with the summary deferred to the next boundary.

*Edges:* Stop during summarization leaves no segment (one transaction at the end). Fork copies segments with remapped ids. Edit-and-resend past a boundary deletes the segments it cuts. Rows are never deleted, so checkpoints are untouched.

**Events and UI.** `chat://context {tokens, window, softPct, cacheHitPct}` each round; `chat://compaction {segmentId, phase}`.
- `ChatCanvas`: a `SummaryRow` fold ("Earlier turns summarized · 23 turns · 184k → 9k · $0.01") that opens with the grid-rows idiom to the summary and "Restore the originals". Covered rows stay in the timeline; the fold marks what the model no longer sees verbatim.
- Companion › Conversation shows first-request cache-hit % per turn. A user turn's actions gain "Summarize up to here".

### Slices

| # | Slice | Acceptance and tests |
|---|---|---|
| B1 | `context/budget.rs`; guard in `before_round` (mechanical stubs, recall hint); learned window on a 400 | `guard_triggers_at_soft`, `prompt_too_long_lowers_window_and_retries_once`, `calibration_converges`, `keep_tail_never_splits_a_round` |
| B2 | Columns `raw_json`, `tool_use_id`, `model_view`; `transcript.rs` behind the flag. `context_blocks` (#1150) is the `@` record, and its one deterministic full-to-shortened change is the accepted exception to byte-for-byte replay | `transcript_is_prefix_stable_across_turns` (bytes), `legacy_rows_render_without_model_view`, `raw_replayed_only_to_origin_model` |
| B3 | Turn-context block; `CachePlan` in the Anthropic adapter; OpenAI cache key | `tools_and_system_bytes_identical_across_turns_modes_and_skills`, `previous_tail_is_always_a_breakpoint`, `never_more_than_four` |
| B4 | `chat://context`; cache-hit % and meter in the Companion | `cache_hit_pct_from_spend_events`. Verify on a real thread: first-request reads above 90 % |
| B5 | `chat_segments`, computed summary, `summary` role, `restore_chat_segment` | `originals_never_deleted`, `restore_round_trips_bytes`, `restore_refused_over_window`, `fork_remaps_segments`, `truncate_drops_cut_segments` |
| B6 | Written summary on the fast tier; auto, opportunistic, manual triggers; `SummaryRow` | `summary_billed_to_origin`, `writer_failure_falls_back`, `stop_leaves_no_segment`, `cold_cache_triggers_early`. FEATURES, changeset |
| B7 | Recall for any row; `search_history`; pins. `context_blocks` is the `@` record (shipped with #1150, recall by `message_id` + `block`), shortened once from the turn after it was sent | `recall_covers_summarized_rows`, `search_finds_original_text`, `pinned_row_survives` |
| B8 | Sub-agents and Direct stages on `budget.rs`; sub-agent originals recallable from `chat_agent_runs` | Compaction tests ported; `subagent_recall_after_compaction` |

### Risks
- **Stored shapes change**, all additively, with old-shape read tests. `summary` is a new role: confirm `buildTimeline` ignores unknown roles before B5.
- A written summary can mislead; hence computed facts, the visible fold, and restore.
- Bundled SQLite must include FTS5; otherwise B7 falls back to `LIKE`.
- A one-hour TTL costs more to write; judge `auto` on `spend_events` before it becomes the default.

### Ten-year version
Runs last days and crews span vendors, so the scarce thing is shared memory with provenance. The append-only transcript with addressable originals becomes one project memory any agent can query, with a record of where each fact came from.

---

## Epic C. Plan mode, the step ledger and permission modes

**Where we go further.** A plan is an object Octopush executes and audits, not a paragraph the model promises to follow. Each approved step is bound to a checkpoint pair, so it can be rewound or opened in Review on its own. Each step has an assignee (a crew role, any vendor) and its real cost from the ledger. The whole plan can be handed to a crew in its own worktree, where it runs as gated stages and shows in Mission Control. "Plan only" is enforced by the macOS sandbox on every command, not only by filtering tools.

**Observed today.** Other tools offer a planning posture that blocks edits until a plan is approved, a model-maintained checklist, and several permission postures from ask-everything to no prompts (the audit's comparison table).

### Architecture

**`rs/permissions.rs`: one pure policy.**

```rust
pub enum Mode { Plan, Ask, Edit }                  // UI: Plan only · Ask first · Edit freely
pub enum Decision { Allow, Ask { reason, preview }, Deny { message } }
pub fn decide(mode: Mode, call: &ToolCall, ctx: &PolicyCtx) -> Decision;
```

- Tool classes: Read, Write, Exec, Net (MCP), Delegate, Meta.
- **Plan:** Write is denied. Exec runs under the existing read-only seatbelt profile (`sandbox_roots = Some([])`), so no command allowlist is needed. MCP runs only when the server sets `readOnlyHint` (already parsed in `mcp/mod.rs`). Delegate is limited to read-only agent types under the same sandbox.
- **Ask:** Write and Exec park on `ApprovalBroker`; an edit's card carries its diff. **Edit:** today's behaviour.
- `ModeGate` implements `ToolGate` for both hosts, so sub-agents inherit the thread's mode. The tool list does not change with the mode; a denial is a fixed tool result.
- Storage: `chat_threads.permission_mode TEXT` (NULL = `edit`); a `talkDefaultMode` setting. A read-only mission forces Plan: a mode can narrow a mission's isolation, never widen it.
- A mode change mid-turn applies at the next `before_round` and writes a quiet note row (role `stopped`, the role Talk's quiet notes use today).
- All modes are on Free (VISION principle 4). A classifier-backed mode and `.claude/settings.json` rules fit `Decision` later.

**Plans and steps are one concept: the todo list is the plan's steps.**

```sql
CREATE TABLE IF NOT EXISTS chat_plans (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, version INTEGER NOT NULL,
  state TEXT NOT NULL,                 -- draft | approved | superseded | handed_off
  source TEXT NOT NULL,                -- planned | adhoc
  body_md TEXT NOT NULL, source_message_id INTEGER, approved_at TEXT, run_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_plan_steps (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo', -- todo | doing | done | skipped | blocked
  assignee TEXT, before_ref TEXT, after_ref TEXT,
  started_message_id INTEGER, done_message_id INTEGER, updated_at TEXT NOT NULL);
ALTER TABLE spend_events ADD COLUMN step_id TEXT;
```

Two director-only Meta tools (our names):
- **`propose_plan {summary, steps[{text, assignee?}]}`** stops the round the way `ask_director` does: asking supersedes acting. The turn parks on a **plan card**, in the approval-card family and on the same attention path, so it reaches Mission Control's needs-you band under the single-beacon rule.
- **`update_steps {updates[], add[]}`** maintains statuses; outside Plan mode it can start an ad-hoc list.

**The plan card.** The user can edit, reorder and delete steps and comment per step (the `gateCommentsStore` pattern); the human-edited version is what returns to the model. Upright-serif CTAs: "Carry it out here" (Ask first or Edit freely; the same turn resumes), "Hand it to a crew", "Keep planning" (with feedback).

**Checkpoint binding** (`talk_checkpoints.rs`). A step turning `doing` snapshots to `refs/octopush/talk/<thread>/step-<id>`; turning `done`, to `step-<id>-after`; same budget and skip marker as turn checkpoints. `preview` and `rewind` are generalized to take a ref. `rewind_talk_step` resets that step and later ones to `todo`: state follows the files. In Review, `ReviewSource` (today `"working" | "committed"`) gains `{kind: "span", from, to, label}` for "This turn" and "This step"; per-hunk revert works only where the reverse hunk applies cleanly.

**Cost binding.** `record_usage` and `record_subagent_spend` stamp `step_id` while exactly one step is `doing`. `Agent` gains an optional `step`, so crew rows and their spend attach to it.

**Hand-off to a crew.** v1: `handoff_plan(planId)` prefills the Direct launcher (`runsStore.setLauncherPrefill`); the human launches; the plan becomes `handed_off` with its `run_id`; the card shows that run's `StageDots`; a quiet note row links to its Review when it settles. v2: steps become proposed stages (an implementer per step group, a reviewer gate, `checkpoint = true`), editable before launch.

**Failure and cancel.** Stop on a parked plan card leaves the plan `draft`; the card persists and can start a new turn. A step left `doing` when a turn ends is marked `blocked` and its after-ref is still captured, so partial work can be reviewed or rewound. Fork copies plans up to the fork point. Compaction never summarizes the plan.

**UI.** The mode control sits in the composer bar (lucide icon, label, `title`). ⌘⌥P cycles the modes, only while the focus is in the Composer (#1231). It isn't ⇧⇥, which moves the focus backwards in forms and dialogs (the PM's decision on #1145). A `TurnPlan` strip above the Player shows `StageDots` and the current step in serif (the `doing` dot holds the scope's one beacon), and folds into a ledger row after the turn. A Companion › Conversation section lists steps with cost and two icon actions: Review, Rewind.

### Slices

| # | Slice | Acceptance and tests |
|---|---|---|
| C1 | `permissions.rs`, `ModeGate`, `permission_mode`; Plan and Edit enforced in both hosts | Table test over mode × class; `plan_mode_command_cannot_write` (seatbelt), `plan_mode_denies_unhinted_mcp`, `subagent_inherits_mode`, `null_mode_is_edit`, `tool_list_identical_across_modes` |
| C2 | Ask first with a diff preview; composer mode control | `ask_edit_parks_with_diff`, `deny_returns_fixed_result`, `mode_switch_applies_next_round_with_note`. Appendix C, `data-tour` |
| C3 | `chat_plans` and steps; `update_steps`; `chat://plan`; `TurnPlan` strip and fold | `adhoc_list_created_outside_plan_mode`, `plan_survives_compaction`, reduced motion, single beacon |
| C4 | `propose_plan` parks the turn; plan card; attention path | `propose_plan_discards_sibling_tools`, `edited_plan_is_what_the_model_receives`, `stop_keeps_draft`, `card_rehydrates_after_reload` |
| C5 | Step checkpoints; `rewind_talk_step`; ref-based rewind | `step_refs_written_on_doing_and_done`, `rewind_resets_later_steps`, `blocked_step_keeps_after_ref`, `step_refs_pruned_with_thread` |
| C6 | Review span source; clean-apply hunk revert | `span_diff_between_refs`, `reverse_hunk_refused_when_changed` |
| C7 | `spend_events.step_id`; per-step cost; `Agent.step` | `spend_stamped_only_with_one_doing_step`, `subagent_spend_attaches_to_step` |
| C8 | Hand-off v1, then v2 | `handoff_sets_state_and_run_id`, `settled_run_adds_note`, `steps_map_to_stages_with_gate` |

### Risks
- **Security-relevant:** C1 and C2 deserve the independent high-risk review. Until the audit's F8 items (#1147) land, Ask first is a workflow aid, not a security boundary, and the copy must not imply otherwise.
- Seatbelt read-only can break commands that write caches inside the worktree; keep temp roots writable and name the cause in the denial.
- Models may not keep statuses current, so cost stamping needs exactly one `doing` step, and rewind uses refs, never the model's word.
- Step snapshots multiply refs; reuse the 30-day prune and the budget.

### Ten-year version
The step ledger becomes a signed work record: for every change, who planned it, which agent and model did it, what it cost, who approved it, and the tree before and after. A plan can also go to two crews on different vendors in two worktrees, judged side by side in Review and on the ledger.

---

## Build order

1. **A1, B1 and C1 are independent** (provider-only, guard-only, policy-only) and can start in parallel.
2. A3 to A5, the convergence, come before A6+, B2+ and C3+: each plugs into `before_round`, `execute_round` or `TalkHost` persistence.
3. B2 and B3 come before B5: compaction on a rewritten prefix wastes the cache it exists to protect.
4. C5 and C6 can ship before C4; per-turn Review is useful alone.

Every slice stays under 800 changed lines, updates `docs/FEATURES.md`, and adds a changeset when user-visible. No new top-level chrome; existing motion primitives and tokens only.

---

## Unverified assumptions

These three are flagged above and are not settled. Check each before the slice that rests on it.

1. **Provider cache rules (B3).** The four breakpoints, the TTL choice and the OpenAI-compatible cache key follow the providers' rules as we understand them. Confirm each against the provider's current documentation when building.
2. **Unknown roles in the timeline (B5).** `summary` is a new role. Confirm that `buildTimeline` ignores roles it doesn't know before B5 ships it.
3. **FTS5 in the bundled SQLite (B7).** `search_history` needs FTS5 in the SQLite that `rusqlite` bundles. If it is missing, B7 falls back to `LIKE`.
