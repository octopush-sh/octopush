# Direct Mode — Live Orchestration View

**Date:** 2026-06-09
**Status:** Design proposal, pending implementation plan
**Scope:** Make every running Direct stage stream its work live — a structured activity feed rendered as a work journal (`§ TOOL` cards) in the focus pane and a pulsing active stage with a live "current activity" line in the track — unified across the API and CLI substrates. First of the Direct UX sub-projects (the others: run navigation/multi-run; pipeline builder). Builds on the merged review-loop work.

---

## 1. Summary

Today the **API substrate** (`orchestrator/agentic.rs::run_agentic_loop`) *"persists nothing and emits no events — it just runs and returns a result."* So a Direct run's **default path is a black box**: the focus pane shows `working…`, the track shows a static `running` card with cost frozen at `$0.00`, until each stage finishes. The CLI substrate streams (added earlier), but the default does not. This is the opacity the user feels — Direct reads like a spinner, not like watching a team build.

This spec makes a running stage **stream its work live** as a structured activity feed: the model's narration + each tool call (read / edit / grep / bash) with a compact result, plus the review **verdict** on completion. The feed renders as:
- **Focus pane = work journal:** narration as prose, each tool call as a `§ TOOL · hint` card with its result.
- **Track = alive:** the active stage **pulses**, shows a **timer** and a one-line **current activity**; on completion shows the result/verdict.

One structured channel feeds **both** API and CLI substrates.

### Goals
- See the agent work in real time on the **default (API)** path, not just CLI.
- A single **structured** live channel both substrates emit on; the frontend owns presentation.
- Focus pane work journal with `§ TOOL` cards + compact results.
- Track liveness: pulse, timer, current-activity, verdict-on-complete.
- **Control legibility:** what each stage is doing, decided, and why it paused.

### Non-goals (other sub-projects / deferred)
- **Live cost tick-by-tick** — cost still updates on stage completion (`run://cost`).
- **Run navigation / multi-run** (separate sub-project) and **pipeline builder** (separate sub-project).
- A full raw terminal transcript (the journal is curated, not raw).

---

## 2. Event model — structured `run://log`

The CLI streaming work emits `run://log` as a **pre-rendered string** (`{ runId, stageId, line: "§ Edit src/x.rs" }`) — presentation baked into the backend (a smell the CLI-streaming review flagged). This spec evolves the payload to a **structured entry** so the frontend renders the `§` cards and both substrates stay presentation-light:

```
run://log payload:
  { runId, stageId, reset: true }                      // clear the feed on (re)start
  | { runId, stageId, entry: LiveEntry }               // one activity entry

LiveEntry =
  | { kind: "text",        text: string }              // model narration
  | { kind: "tool",        tool: string, hint: string } // hint = first descriptive arg
  | { kind: "tool_result", ok: boolean, detail: string } // short summary or error
  | { kind: "notice",      text: string }              // e.g. "Verdict: changes requested"
```

### `LiveEmitter` (backend helper, `orchestrator/`)
A small struct wrapping the pieces already on `StageContext` (events sink + run_id + stage_id, all added in the review-loop L1 work):

```rust
pub struct LiveEmitter<'a> {
    events: &'a dyn EventSink,
    run_id: &'a str,
    stage_id: &'a str,
}
impl<'a> LiveEmitter<'a> {
    fn emit_entry(&self, entry: serde_json::Value) {
        self.events.emit("run://log",
            serde_json::json!({ "runId": self.run_id, "stageId": self.stage_id, "entry": entry }));
    }
    pub fn text(&self, s: &str)                 // {kind:"text", text}
    pub fn tool(&self, name: &str, hint: &str)  // {kind:"tool", tool, hint}
    pub fn tool_result(&self, ok: bool, detail: &str)
    pub fn notice(&self, s: &str)
}
```
Empty text is skipped. Both runners build a `LiveEmitter` from `ctx` and use it.

---

## 3. Backend

### 3.1 ApiRunner + `run_agentic_loop` (the default path — the core change)
`run_agentic_loop` gains an `emitter: &LiveEmitter` parameter. Exact emission points (per the current loop in `agentic.rs`):
- After `provider.complete(...)` returns `resp`: if `resp.text` is non-empty → `emitter.text(resp.text.trim())` (the narration that precedes tool calls).
- In the `for u in &resp.tool_uses` loop: **before** `execute_tool` → `emitter.tool(&u.name, &hint_from(&u.input))`; **after** → `emitter.tool_result(!result_is_error, &summarize(&result))`.
- The final answer (`is_final`) needs no entry — the settled artifact is the final text.

`ApiRunner::run` builds the emitter from `ctx` and passes it into `run_agentic_loop`. After the loop, if `outcome.verdict` is present (auto-mode review) → `emitter.notice(...)`.

`hint_from(input)` and `summarize(result)` are **pure, unit-tested** helpers. `hint_from` reuses the loop-review `TOOL_HINT_KEYS` idea (prefer `command`/`file_path`/`path`/`pattern`/…); promote it to a shared module so CLI and API share one implementation. `summarize` returns ≤120 chars: the error text if the tool errored, else a terse success (e.g. first line / "N lines" / "ok").

### 3.2 CliRunner (unify onto the structured channel)
The stream-json read loop currently calls `render_stream_event(value) -> Option<String>` and emits `{ line }`. Replace it: parse each stream-json event into `Vec<LiveEntry>` (`assistant.text` → `text`; `assistant.tool_use` → `tool`; `user.tool_result` → `tool_result`) and emit each via the same `LiveEmitter`. `render_stream_event` is replaced by `entries_from_stream_event(value) -> Vec<LiveEntry>` (pure, unit-tested). The result-event parsing + the `reset`-on-start (review-loop L1) are unchanged.

### 3.3 Orchestrator
No new plumbing: `run_stage_once` already constructs `StageContext { events, run_id, stage_id, … }`. The `run://log { reset: true }` emitted on stage (re)start (L1) now clears the **structured** feed.

---

## 4. Frontend

### 4.1 runsStore
Replace `liveLogByStage: Record<string, string[]>` with `liveByStage: Record<string, LiveEntry[]>`:
- `appendEntry(stageId, entry)` pushes (cap ~200, drop-oldest); `clearLog(stageId)` unchanged.
- `run://log` listener: `reset` → `clearLog`; else `appendEntry(stageId, entry)`.
- `LiveEntry` is a discriminated union in `ipc.ts` matching the Rust payload.

### 4.2 StageFocus — the work journal
Render `liveByStage[stage.id]` while the stage runs:
- `text` / `notice` → prose lines (notice in brass-mono meta voice).
- `tool` → a `§ {TOOL} · {hint}` card (brass `§`, ivory tool name, sage hint); the immediately-following `tool_result` renders as a compact result line inside/under it (`✓`/`✕` + detail).
- Trailing `working…` pulse while `status === "running"`. Autoscroll + `chat-selectable` (both already present).
- **Done** stages keep the existing settled view (artifact text + diff). The journal is the *live* view; the artifact is the *settled output*.

### 4.3 RunTrack — alive
- The active (`running`) stage card: a **pulse** (CSS, respects `prefers-reduced-motion`), a **timer** from `stage.startedAt` (a `useElapsed` hook ticking ~1s), and a one-line **current activity** = the last `tool`/`text` entry of `liveByStage[stage.id]`.
- On completion: show the **result/verdict** when present — verdigris "passed" / brass "changes requested" (read the verdict from the stage's artifact payload set in the loop-L3 work), else a neutral done state. This directly serves the user's "what did it decide / why did it stop."

---

## 5. Data flow

`agent step → LiveEmitter.{text|tool|tool_result|notice} → run://log {entry} (Tauri) → runsStore.appendEntry → StageFocus journal + RunTrack current-activity`. `reset` on (re)start clears the feed. Cost still flows via `run://cost` on completion (unchanged). The same path serves API and CLI.

---

## 6. Backward compatibility / migration

The only consumer of the old `{ line }` payload is StageFocus, via runsStore's `liveLogByStage` (added in the CLI-streaming work). This spec **migrates both** to structured entries — a clean replacement, not an addition; no other consumers exist (grep `liveLogByStage` / `run://log`). Orchestration (linear/gated/auto, checkpoints, cost) is untouched — this is purely the live-feedback channel.

---

## 7. Testing

- **Rust:** pure unit tests for `hint_from`, `summarize`, `entries_from_stream_event`. A `RecordingEmitter` (test `EventSink` that collects entries) asserts `run_agentic_loop` emits `text → tool → tool_result` in order for a scripted fake `LlmProvider` + a tool that returns a known result; assert the verdict `notice` fires for an auto review.
- **Frontend (Vitest):** runsStore `appendEntry`/`clearLog`/`reset` reduction; StageFocus renders each entry kind and groups a `tool` + its `tool_result` into one card; RunTrack shows the active pulse, the current-activity line, and the ticking timer (mock `liveByStage` + `startedAt`); reduced-motion respected.

---

## 8. Phased decomposition (implementation plans)

- **Plan V1 — structured channel + ApiRunner streaming (backend):** `LiveEmitter`; `run_agentic_loop` emission; CliRunner migrated to `entries_from_stream_event`; shared `hint_from`/`summarize`; verdict `notice`. Verified with `RecordingEmitter` + pure-helper tests. (No UI yet — events flow, nothing renders them richly until V2.)
- **Plan V2 — focus-pane work journal (frontend):** `LiveEntry` type in `ipc.ts`; runsStore `liveByStage`; StageFocus `§ TOOL` card journal; migrate off `liveLogByStage`. Vitest.
- **Plan V3 — track liveness (frontend):** RunTrack pulse + `useElapsed` timer + current-activity + verdict-on-complete. Vitest.

Each plan is independently shippable; V1 alone makes the events flow (verifiable via the existing focus-pane log before V2 enriches it).

---

## 9. Open decisions

1. **`tool_result` detail** — length/shape. Recommend ≤120 chars: the error message when `is_error`, else a terse success (first line / "N lines" / "ok").
2. **`notice` for gated stages** — gated reviews have no parsed verdict (L1). Recommend emit `notice` only when a verdict exists (auto); for gated, the checkpoint UI already carries the decision.
3. **Throughput** — a chatty stage emits many entries. Recommend cap ~200 now; add a per-animation-frame coalescing of rapid `text` deltas only if profiling shows render jank (the CLI path already proved moderate rates are fine).

---

## 10. Consistency check (self-review)

- One channel for **API + CLI** ✓. Backend stays **presentation-light** (frontend renders the `§` cards) — fixes the smell the CLI-streaming review flagged ✓. `reset`-on-restart reused ✓. Cost path unchanged ✓. Orchestration semantics untouched ✓. The three plans are independently shippable, V1 observable on its own ✓.
