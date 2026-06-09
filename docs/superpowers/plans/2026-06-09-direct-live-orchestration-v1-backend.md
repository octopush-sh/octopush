# Live Orchestration View — Plan V1 (backend: structured live event channel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a running Direct stage stream its work as **structured** `run://log` activity entries — emitted by BOTH the API substrate (`run_agentic_loop`, which today emits nothing) and the CLI substrate — so the frontend (Plans V2/V3) can render a `§ TOOL` work journal and a live track.

**Architecture:** A small `LiveEmitter` (wraps the `EventSink` + run/stage ids already on `StageContext`) emits `run://log` with a structured `entry` (`text | tool | tool_result | notice`). `run_agentic_loop` emits per step; `ApiRunner` builds the emitter and passes it down + a verdict `notice`. `CliRunner` is migrated from emitting a pre-rendered `{line}` string to emitting the same structured entries. Pure helpers (`tool_hint`, `summarize`, `entries_from_stream_event`) are shared and unit-tested. Backend stays presentation-light; the frontend owns the `§` card rendering.

**Tech Stack:** Rust (tokio, serde_json, async-trait), the existing `src-tauri/src/orchestrator/` + `providers/` modules.

**Spec:** `docs/superpowers/specs/2026-06-09-direct-live-orchestration-view-design.md`. This plan = §8 "Plan V1". V2 (focus-pane journal) and V3 (track liveness) are separate plans.

---

## File map
- **Create** `src-tauri/src/orchestrator/live.rs` — `LiveEmitter`, the entry payload builders, and the pure helpers `tool_hint`, `summarize`, `entries_from_stream_event`.
- **Modify** `src-tauri/src/orchestrator/mod.rs` — `mod live;` declaration.
- **Modify** `src-tauri/src/orchestrator/agentic.rs` — `run_agentic_loop` gains an `emitter: &LiveEmitter` param + emission points.
- **Modify** `src-tauri/src/orchestrator/runner.rs` — `ApiRunner::run` builds the emitter, passes it, emits the verdict notice.
- **Modify** `src-tauri/src/orchestrator/cli_runner.rs` — migrate the stream read-loop from `render_stream_event`→`{line}` to `entries_from_stream_event`→structured entries via `LiveEmitter`.
- **Modify** `src-tauri/src/tests.rs` — tests per task.

No frontend in V1. The events flow but are rendered by the existing (line-oriented) focus-pane log until V2 enriches it — so V1 must NOT break the existing `run://log` consumer beyond the payload shape change (V2 migrates the consumer; until then the old `liveLogByStage` string consumer will simply ignore `entry` payloads — acceptable for an internal dev build between V1 and V2).

---

### Task 1: `LiveEmitter` + structured entries + pure helpers (`live.rs`)

**Files:** Create `src-tauri/src/orchestrator/live.rs`; modify `src-tauri/src/orchestrator/mod.rs`; test in `src-tauri/src/tests.rs`.

- [ ] **Step 1 — Write the failing tests.** Add a new module at the end of `src-tauri/src/tests.rs`:
```rust
#[cfg(test)]
mod live_tests {
    use crate::orchestrator::events::EventSink;
    use crate::orchestrator::live::{entries_from_stream_event, summarize, tool_hint, LiveEmitter};
    use parking_lot::Mutex;
    use serde_json::{json, Value};

    struct Recorder { events: Mutex<Vec<(String, Value)>> }
    impl EventSink for Recorder {
        fn emit(&self, event: &str, payload: Value) { self.events.lock().push((event.to_string(), payload)); }
    }

    #[test]
    fn live_emitter_emits_structured_run_log_entries() {
        let rec = Recorder { events: Mutex::new(vec![]) };
        let em = LiveEmitter::new(&rec, "run1", "stageA");
        em.text("  reading the code  ");
        em.tool("Edit", "src/auth.rs");
        em.tool_result(true, "12 lines");
        em.notice("Verdict: changes requested");
        em.text("   "); // blank → skipped

        let ev = rec.events.lock();
        assert_eq!(ev.len(), 4); // blank text skipped
        for (name, _) in ev.iter() { assert_eq!(name, "run://log"); }
        assert_eq!(ev[0].1, json!({"runId":"run1","stageId":"stageA","entry":{"kind":"text","text":"reading the code"}}));
        assert_eq!(ev[1].1, json!({"runId":"run1","stageId":"stageA","entry":{"kind":"tool","tool":"Edit","hint":"src/auth.rs"}}));
        assert_eq!(ev[2].1, json!({"runId":"run1","stageId":"stageA","entry":{"kind":"tool_result","ok":true,"detail":"12 lines"}}));
        assert_eq!(ev[3].1, json!({"runId":"run1","stageId":"stageA","entry":{"kind":"notice","text":"Verdict: changes requested"}}));
    }

    #[test]
    fn tool_hint_prefers_descriptive_keys_and_summarize_caps() {
        assert_eq!(tool_hint(&json!({"content":"AAAA","file_path":"src/x.rs"})), "src/x.rs");
        assert_eq!(tool_hint(&json!({"command":"cargo test"})), "cargo test");
        assert_eq!(tool_hint(&json!({})), "");
        // summarize: first line, capped at 120 chars
        assert_eq!(summarize("ok\nmore"), "ok");
        let long = "x".repeat(200);
        assert_eq!(summarize(&long).chars().count(), 120);
    }

    #[test]
    fn entries_from_stream_event_maps_assistant_and_skips_result() {
        // assistant text + tool_use → [text, tool]
        let asst = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"reviewing"},
            {"type":"tool_use","name":"Read","input":{"file_path":"src/a.rs"}}
        ]}});
        let es = entries_from_stream_event(&asst);
        assert_eq!(es.len(), 2);
        assert_eq!(es[0], json!({"kind":"text","text":"reviewing"}));
        assert_eq!(es[1], json!({"kind":"tool","tool":"Read","hint":"src/a.rs"}));
        // user tool_result → [tool_result]
        let user = json!({"type":"user","message":{"content":[
            {"type":"tool_result","is_error":false,"content":"42 lines"}
        ]}});
        let ue = entries_from_stream_event(&user);
        assert_eq!(ue.len(), 1);
        assert_eq!(ue[0], json!({"kind":"tool_result","ok":true,"detail":"42 lines"}));
        // result/system → none
        assert!(entries_from_stream_event(&json!({"type":"result","subtype":"success"})).is_empty());
        assert!(entries_from_stream_event(&json!({"type":"system","subtype":"init"})).is_empty());
    }
}
```

- [ ] **Step 2 — Run, confirm FAIL (module/types missing):** `cd src-tauri && cargo test --lib live_tests 2>&1 | tail -20`

- [ ] **Step 3 — Create `src-tauri/src/orchestrator/live.rs`:**
```rust
//! The structured live-activity channel for Direct runs. Both substrates emit
//! `run://log` entries through `LiveEmitter`; the frontend renders the cards.

use crate::orchestrator::events::EventSink;
use serde_json::{json, Value};

/// Frontend event name for live per-stage activity (mirrors `RUN_EVENTS.log`).
pub const RUN_LOG_EVENT: &str = "run://log";

/// Tool-input keys to surface as the one-line hint, in priority order.
const TOOL_HINT_KEYS: &[&str] = &["command", "file_path", "path", "pattern", "query", "url", "prompt"];

/// Emits structured `run://log` activity entries for one stage.
pub struct LiveEmitter<'a> {
    events: &'a dyn EventSink,
    run_id: &'a str,
    stage_id: &'a str,
}

impl<'a> LiveEmitter<'a> {
    pub fn new(events: &'a dyn EventSink, run_id: &'a str, stage_id: &'a str) -> Self {
        Self { events, run_id, stage_id }
    }
    fn emit_entry(&self, entry: Value) {
        self.events.emit(
            RUN_LOG_EVENT,
            json!({ "runId": self.run_id, "stageId": self.stage_id, "entry": entry }),
        );
    }
    pub fn text(&self, s: &str) {
        let t = s.trim();
        if !t.is_empty() {
            self.emit_entry(json!({ "kind": "text", "text": t }));
        }
    }
    pub fn tool(&self, name: &str, hint: &str) {
        self.emit_entry(json!({ "kind": "tool", "tool": name, "hint": hint }));
    }
    pub fn tool_result(&self, ok: bool, detail: &str) {
        self.emit_entry(json!({ "kind": "tool_result", "ok": ok, "detail": detail }));
    }
    pub fn notice(&self, s: &str) {
        let t = s.trim();
        if !t.is_empty() {
            self.emit_entry(json!({ "kind": "notice", "text": t }));
        }
    }
}

/// A descriptive one-line hint from a tool-call input object (path/command/…),
/// else the first string value, else "".
pub fn tool_hint(input: &Value) -> String {
    let Some(obj) = input.as_object() else { return String::new() };
    let pick = TOOL_HINT_KEYS
        .iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
        .or_else(|| obj.values().find_map(Value::as_str))
        .unwrap_or("");
    let first = pick.lines().next().unwrap_or(pick);
    first.chars().take(120).collect()
}

/// First line of a tool result, capped to 120 chars — for the result detail line.
pub fn summarize(result: &str) -> String {
    let first = result.trim().lines().next().unwrap_or("").trim();
    first.chars().take(120).collect()
}

/// Map ONE claude `--output-format stream-json` event to zero or more entries
/// (as the JSON values `LiveEmitter` would emit). `assistant` → text + tool
/// entries; `user` tool_result → tool_result entries; everything else → none.
pub fn entries_from_stream_event(v: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let kind = v.get("type").and_then(Value::as_str);
    let content = v.get("message").and_then(|m| m.get("content")).and_then(Value::as_array);
    let Some(content) = content else { return out };
    match kind {
        Some("assistant") => {
            for block in content {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(Value::as_str) {
                            let t = t.trim();
                            if !t.is_empty() {
                                out.push(json!({ "kind": "text", "text": t }));
                            }
                        }
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let hint = block.get("input").map(tool_hint).unwrap_or_default();
                        out.push(json!({ "kind": "tool", "tool": name, "hint": hint }));
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            for block in content {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    let ok = !block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    let detail = block.get("content").and_then(Value::as_str).map(summarize).unwrap_or_default();
                    out.push(json!({ "kind": "tool_result", "ok": ok, "detail": detail }));
                }
            }
        }
        _ => {}
    }
    out
}
```

- [ ] **Step 4 — Declare the module.** In `src-tauri/src/orchestrator/mod.rs`, add `pub mod live;` alongside the other `pub mod` declarations (near `pub mod events;`).

- [ ] **Step 5 — Run the tests, confirm PASS, then the suite:** `cd src-tauri && cargo test --lib live_tests 2>&1 | tail -10` then `cargo test --lib 2>&1 | tail -5`. (Ignore the ~5 `pty_*` `PermissionDenied` sandbox failures if present.)

- [ ] **Step 6 — Commit:**
```bash
git add src-tauri/src/orchestrator/live.rs src-tauri/src/orchestrator/mod.rs src-tauri/src/tests.rs
git commit -m "feat(direct/live-v1): LiveEmitter + structured entries + tool_hint/summarize/stream-event helpers"
```

---

### Task 2: `run_agentic_loop` + `ApiRunner` emit live activity (the default path)

**Files:** Modify `src-tauri/src/orchestrator/agentic.rs`, `src-tauri/src/orchestrator/runner.rs`; test in `src-tauri/src/tests.rs`.

- [ ] **Step 1 — Write the failing test** (add to `mod live_tests`). It scripts a fake provider: turn 1 returns text + a tool_use, turn 2 returns a final answer; it asserts the loop emits `text → tool → tool_result` and does NOT emit the final answer text:
```rust
    use crate::orchestrator::agentic::run_agentic_loop;
    use crate::providers::{LlmProvider, LlmRequest, LlmResponse, LlmStopReason, LlmToolUse};
    use std::collections::VecDeque;

    struct ScriptedProvider { turns: Mutex<VecDeque<LlmResponse>> }
    #[async_trait::async_trait]
    impl LlmProvider for ScriptedProvider {
        async fn complete(&self, _b: &str, _k: Option<&str>, _r: &LlmRequest, _c: &reqwest::Client)
            -> crate::error::AppResult<LlmResponse> {
            Ok(self.turns.lock().pop_front().expect("ScriptedProvider ran out of turns"))
        }
    }
    fn resp(text: &str, tools: Vec<LlmToolUse>, stop: LlmStopReason) -> LlmResponse {
        LlmResponse { text: text.into(), tool_uses: tools, stop_reason: stop,
            input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }
    }

    #[tokio::test]
    async fn agentic_loop_streams_text_tool_and_result() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {}\n").unwrap();

        let provider = ScriptedProvider { turns: Mutex::new(VecDeque::from(vec![
            resp("inspecting the change",
                 vec![LlmToolUse { id: "t1".into(), name: "Read".into(),
                       input: serde_json::json!({"file_path": "a.rs"}) }],
                 LlmStopReason::ToolUse),
            resp("looks good", vec![], LlmStopReason::EndTurn),
        ])) };

        let rec = Recorder { events: Mutex::new(vec![]) };
        let em = LiveEmitter::new(&rec, "r", "s");
        let client = reqwest::Client::new();
        let out = run_agentic_loop(&provider, "http://x", None, &client, "m",
                                   "sys", "do it", dir.path(), 10, &em).await.unwrap();

        assert_eq!(out.text, "looks good"); // final answer is the artifact, not a live entry
        let kinds: Vec<String> = rec.events.lock().iter()
            .map(|(_, p)| p["entry"]["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, vec!["text", "tool", "tool_result"]);
        // the tool entry carries the name + hint
        let tool = &rec.events.lock()[1].1["entry"];
        assert_eq!(tool["tool"], "Read");
        assert_eq!(tool["hint"], "a.rs");
    }
```
> Note: the test asserts entry KINDS/order, so it is robust to whatever `execute_tool("Read", …)` actually returns. If `Read` is not the tool name `execute_tool` dispatches, read `src-tauri/src/chat_engine` for the real read-tool name + input key and adjust the `name`/`input` here — the assertions on kinds/order stay the same.

- [ ] **Step 2 — Run, confirm FAIL (arity: `run_agentic_loop` takes no `emitter`):** `cd src-tauri && cargo test --lib agentic_loop_streams 2>&1 | tail -20`

- [ ] **Step 3 — Add the `emitter` param + emission points to `run_agentic_loop`** (`agentic.rs`). Append `emitter: &crate::orchestrator::live::LiveEmitter<'_>` as the final parameter. Then:
  - Right after `let resp = provider.complete(...).await?;` and the token accumulation, emit the narration: `emitter.text(&resp.text);`
  - In `for u in &resp.tool_uses { … }`, BEFORE `let result = execute_tool(...)`, add `emitter.tool(&u.name, &crate::orchestrator::live::tool_hint(&u.input));`. AFTER computing `result`, add `emitter.tool_result(true, &crate::orchestrator::live::summarize(&result));`
    (V1 note: the loop sets `is_error: false` for tool results, so the API path reports `ok: true`; the result detail still shows any error text. Threading real tool error-ness is a follow-up. The CLI path (Task 3) reports the true `is_error`.)
  - Do NOT emit for the `is_final` return or the truncation-retry branch.

- [ ] **Step 4 — Thread the emitter from `ApiRunner::run`** (`runner.rs`). Where it currently calls `run_agentic_loop(provider.as_ref(), &api_base, …, MAX_STAGE_ITERATIONS)`, first build the emitter from `ctx` and pass it last:
```rust
        let emitter = crate::orchestrator::live::LiveEmitter::new(
            ctx.events.as_ref(), &ctx.run_id, &ctx.stage_id);
        let result = run_agentic_loop(
            provider.as_ref(), &api_base, api_key.as_deref(), &ctx.client,
            &stage.agent_model, &system, &user, &ctx.workspace_path,
            MAX_STAGE_ITERATIONS, &emitter,
        ).await;
```
  Then, in the `Ok(r)` arm after building the outcome, emit the verdict notice when present:
```rust
                if let Some(v) = &outcome_verdict {
                    emitter.notice(match v {
                        crate::orchestrator::types::ReviewVerdict::Pass => "Verdict: passed",
                        crate::orchestrator::types::ReviewVerdict::ChangesRequested => "Verdict: changes requested",
                    });
                }
```
  where `outcome_verdict` is the `verdict` you already compute via `parse_verdict(&r.text)` (reuse the existing binding; if it's currently inlined into the `StageOutcome { verdict: … }` literal, lift it to a `let verdict = parse_verdict(&r.text);` above and use it in both the literal and the notice). `ctx.events` is `Arc<dyn EventSink>` so `ctx.events.as_ref()` gives `&dyn EventSink`.

- [ ] **Step 5 — Run the test + suite:** `cd src-tauri && cargo test --lib agentic_loop_streams 2>&1 | tail -15` then `cargo test --lib 2>&1 | tail -5`. No new warnings (`cargo build 2>&1 | grep -iE "warning" | grep -v "never used.*\bids\b"`).

- [ ] **Step 6 — Commit:**
```bash
git add src-tauri/src/orchestrator/agentic.rs src-tauri/src/orchestrator/runner.rs src-tauri/src/tests.rs
git commit -m "feat(direct/live-v1): API substrate streams its agentic loop (text/tool/tool_result + verdict notice)"
```

---

### Task 3: Migrate `CliRunner` onto the structured channel

**Files:** Modify `src-tauri/src/orchestrator/cli_runner.rs`; test in `src-tauri/src/tests.rs`.

Context: `CliRunner::run` streams `claude --output-format stream-json` stdout line-by-line and currently emits `run://log` as a pre-rendered string via `render_stream_event(value) -> Option<String>` → `ctx.events.emit(RUN_LOG_EVENT, json!({runId, stageId, line}))`. Replace that emission with structured entries from the shared `entries_from_stream_event` (Task 1), via `LiveEmitter`. Keep the result-event parsing (`is_result_event` / `parse_cli_result`) and the `reset`-on-start unchanged.

- [ ] **Step 1 — Write/extend the failing test.** `entries_from_stream_event` is already covered by Task 1; here assert the CLI path produces `tool_result` with the real `is_error` flag (the differentiator vs the API path):
```rust
    #[test]
    fn cli_stream_tool_result_reflects_is_error() {
        let err = serde_json::json!({"type":"user","message":{"content":[
            {"type":"tool_result","is_error":true,"content":"boom: file not found"}
        ]}});
        let es = crate::orchestrator::live::entries_from_stream_event(&err);
        assert_eq!(es.len(), 1);
        assert_eq!(es[0]["kind"], "tool_result");
        assert_eq!(es[0]["ok"], false);
        assert_eq!(es[0]["detail"], "boom: file not found");
    }
```
- [ ] **Step 2 — Run, confirm PASS already** (the helper exists from Task 1): `cd src-tauri && cargo test --lib cli_stream_tool_result 2>&1 | tail -8`. (This test pins the contract the CLI runner relies on; the behavior change is in the runner wiring below, which is integration-verified by build + the existing CLI tests.)

- [ ] **Step 3 — Rewire the CLI stream loop** in `cli_runner.rs`. At the top of `run`, build `let emitter = crate::orchestrator::live::LiveEmitter::new(ctx.events.as_ref(), &ctx.run_id, &ctx.stage_id);`. In the stdout read loop, replace the block that does `if let Some(rendered) = render_stream_event(&value) { ctx.events.emit(RUN_LOG_EVENT, json!({…, "line": rendered})) }` with:
```rust
                for entry in crate::orchestrator::live::entries_from_stream_event(&value) {
                    emitter.emit_raw_entry(entry);
                }
```
  To support emitting a pre-built entry value, add one method to `LiveEmitter` in `live.rs`:
```rust
    /// Emit an already-shaped entry value (from `entries_from_stream_event`).
    pub fn emit_raw_entry(&self, entry: serde_json::Value) {
        self.emit_entry(entry);
    }
```
  Delete the now-unused `render_stream_event` from `cli_runner.rs` (and its `RUN_LOG_EVENT` const if it duplicates `live::RUN_LOG_EVENT` — import the one from `live`). Keep `is_result_event`, `parse_cli_result`, the result-line capture, and the `reset` emission (update the `reset` emit to use `live::RUN_LOG_EVENT` / the same `{runId, stageId, reset:true}` shape). If the orchestrator's stage-start `reset` emit (in `mod.rs`, `run_stage_once`) referenced `cli_runner::RUN_LOG_EVENT`, repoint it to `live::RUN_LOG_EVENT` (same `"run://log"` string).

- [ ] **Step 4 — Update the existing CLI stream tests.** The old `cli_stream_tests` (in `tests.rs`) tested `render_stream_event`/`is_result_event`. `is_result_event` stays; remove/replace the `render_stream_event` assertions (its behavior now lives in `entries_from_stream_event`, covered in `live_tests`). Keep `is_result_event` tests and the `build_cli_args` / `parse_cli_result` tests unchanged.

- [ ] **Step 5 — Build + full suite:** `cd src-tauri && cargo test --lib 2>&1 | tail -6` (all pass; ignore the ~5 `pty_*` `PermissionDenied`). `cargo build 2>&1 | grep -iE "warning|error" | grep -v "never used.*\bids\b"` → no NEW warnings (confirm `render_stream_event` removal didn't leave a dangling reference).

- [ ] **Step 6 — Commit:**
```bash
git add src-tauri/src/orchestrator/cli_runner.rs src-tauri/src/orchestrator/live.rs src-tauri/src/orchestrator/mod.rs src-tauri/src/tests.rs
git commit -m "feat(direct/live-v1): migrate CLI substrate onto the structured live channel"
```

---

## Self-review (against spec §2–§3, §7–§8)

- **`LiveEmitter` + structured `run://log` entry** (`text|tool|tool_result|notice`) → Task 1. ✓
- **API substrate streams** (`run_agentic_loop` emission + ApiRunner emitter + verdict notice) → Task 2. ✓
- **CLI migrated onto the same channel** (`entries_from_stream_event`, real `is_error`) → Task 3. ✓
- **Shared pure helpers** `tool_hint`/`summarize`/`entries_from_stream_event`, unit-tested → Tasks 1/3. ✓
- **Backend presentation-light** (entries are data, not rendered strings) → Task 1/3. ✓
- **`reset`-on-start preserved**, result parsing preserved → Task 3. ✓
- **Testing:** pure helpers + `RecordingEmitter` + `ScriptedProvider`+tempdir for `run_agentic_loop` → Tasks 1–3. ✓
- **No frontend** (V2/V3) and **no live cost** (deferred) — correctly excluded. ✓

**Type consistency:** `LiveEmitter::new(&dyn EventSink, &str, &str)`; methods `text/tool/tool_result/notice/emit_raw_entry`. Entry JSON shapes identical across `LiveEmitter` builders and `entries_from_stream_event`. `run_agentic_loop(..., max_iterations, emitter: &LiveEmitter)` — caller `ApiRunner` updated. `RUN_LOG_EVENT = "run://log"` single source in `live.rs`. `tool_hint(&Value)->String`, `summarize(&str)->String`, `entries_from_stream_event(&Value)->Vec<Value>`.

**Known V1 limitation (documented):** the API path reports `tool_result.ok = true` (the agentic loop has no per-tool error flag today); the result *detail* still surfaces error text. The CLI path reports the true `is_error`. Threading real API tool-error-ness is a follow-up, not required for the live view.

**Harness note:** `mod live_tests` lives at the end of `tests.rs`; it uses `parking_lot::Mutex`, `tempfile`, `reqwest`, `async_trait`, `tokio::test` — all already dev/deps in this crate (used by existing tests). The `Read` tool name/input in Task 2's test may need adjusting to the real `execute_tool` catalog (assertions on kinds/order are unaffected).
