# Per-stage reasoning effort — design (DIRECT operating-model, slice 1)

**Date:** 2026-07-14 · **Initiative:** DIRECT operating model (spine slice 1 of 4) · **Target release:** v0.4.10

The first piece of the DIRECT operating-model spine (see memory `direct-operating-model`). Lets a pipeline
author set **how hard the model thinks per stage** — the atomic knob the whole cost model rests on: a cheap
model thinking deeply on the synthesis stages, a cheap model barely thinking on the mechanical ones. This is
what the Claude.ai Jira-pipeline design used in *every* role ("Sonnet + thinking 8-16k", "Haiku, sin thinking")
and what the user asked for first.

## The API reality (why this is an *effort enum*, not a token budget)

The Claude.ai design spoke in `budget_tokens` ("thinking 8-16k"). That concept is **deprecated and returns a
400** on our current models (Opus 4.8/4.7, Sonnet 5, Fable 5). The GA mechanism (no beta header) is:

- `output_config: { effort: "low"|"medium"|"high"|"xhigh"|"max" }` — controls thinking depth + overall token spend.
- `thinking: { type: "adaptive" }` — enables thinking; the model decides how much within the effort ceiling.

So the author-facing knob is a **reasoning-effort enum**, which is also provider-portable (maps to OpenAI's
`reasoning_effort`) and matches the mental model the user already has from Claude Code. Concrete `budget_tokens`
numbers are a legacy of older models; we express intent as effort and map it per model.

### Model-capability matrix (the correctness core — from the claude-api skill)

Effort support is **not universal**, and the user's pipelines lean on Haiku:

| Model family | Thinking control that WORKS | On wrong param |
|---|---|---|
| Opus 4.8 / 4.7, Sonnet 5, Fable 5 | `output_config.effort` + `thinking:{type:"adaptive"}` (levels incl. `xhigh`/`max`) | `budget_tokens` → **400** |
| Opus 4.6 / Sonnet 4.6, Opus 4.5 | `output_config.effort` + `thinking:{type:"adaptive"}` (no `xhigh` on 4.6/4.5) | — |
| **Haiku 4.5, Sonnet 4.5** | `thinking:{type:"enabled", budget_tokens:N}` (N < max_tokens, ≥1024) | `output_config.effort` → **400** |

⇒ The mapping is a pure, unit-tested function `thinking_config(model_id, effort) -> ThinkingPlan` that encodes
this matrix. `off` ⇒ no thinking params (omit; on Opus 4.8 that's "no thinking", correct). Unknown model ⇒
default to the `output_config.effort` path (every *current* model supports it; that's the safe majority) and log.

`budget_for_effort`: low→4096, medium→8192, high→16384, xhigh/max→24576 (for the Haiku/Sonnet-4.5 path only).

## The other three rocks

1. **No `temperature` alongside thinking** — 400 on current models. `build_request` already sends none. Keep it that way; add a test asserting the body has no `temperature`.
2. **`max_tokens` must clear the thinking spend.** Today it's hard-coded `32768` (`agentic.rs:140`). Derive a floor from effort so high-effort thinking doesn't truncate the answer: none/low/medium → 32768, high → 48000, xhigh/max → 64000. (`output-128k` beta is already sent, so 64k is fine.)
3. **Preserve thinking blocks across tool-result turns (the real work).** With thinking on + tool use, each assistant turn must **lead with its signed `thinking` block** before `tool_use`, replayed unchanged, or the next request 400s (`Expected thinking … but found tool_use`). Today `parse_response` drops thinking blocks and `AssistantWithTools` can't carry them. Fix:
   - `LlmResponse` gains `thinking_blocks: Vec<serde_json::Value>` (raw blocks, signature intact).
   - `parse_response` captures `type:"thinking"` and `type:"redacted_thinking"` blocks verbatim.
   - `LlmContent::AssistantWithTools` gains `thinking: Vec<Value>`.
   - `message_to_anthropic` serializes `thinking` blocks **first**, then text, then `tool_use`.
   - `agentic.rs` (both `AssistantWithTools` build sites) passes `thinking: resp.thinking_blocks.clone()`.
   - `display` stays default `"omitted"` for v1 — blocks are still present + signed (empty text), so replay is correct; surfacing the reasoning summary in the journal is a follow-up. OpenAI-compat returns no such blocks (`thinking_blocks` empty there); its own serializer ignores the field.

## Data model & flow

- **Schema (additive):** `ALTER TABLE stages ADD COLUMN effort TEXT` — nullable; `NULL` ⇒ inherit today's behavior (no thinking). Values validated against the enum at save.
- **`StageSpec.effort: Option<Effort>`** resolved at spec-build; threaded `runner.rs` → `run_agentic(..., effort)` → `LlmRequest.effort`.
- **`LlmRequest` gains `effort: Option<Effort>`** (the provider maps it per the matrix). New enum `Effort { Low, Medium, High, Xhigh, Max }` (serde lowercase); `off` is represented as `None`.
- **Checkpoint hot-edit:** add `effort_override` to `CheckpointAction::Reject` + `StageRerunPatch.effort`, mirroring `model_override` — so escalating a stage's *thinking* at a gate works the same way as escalating its model. (Small, high-value, and the plumbing is already there for model_override.)
- **Ripple:** `LlmRequest` / `LlmContent::AssistantWithTools` / `LlmResponse` are constructed in TALK (`chat_engine.rs`) and `commands.rs` (`build_ai_request`) too. Those sites pass `effort: None` / `thinking: vec![]` — behavior unchanged; TALK effort is out of scope.

## UI (Atelier-compliant)

Stage editor gets one **effort control** (segmented: `Off · Low · Med · High · XHigh · Max`) with a `title`
tooltip, beside the model picker. Tokens, motion primitives, no new chrome. A stage with effort set shows a
small brass affordance on its card (reuses the existing per-stage meta line — `3 · sonnet · api` becomes
`3 · sonnet · high · api`). `lib/ipc.ts` `Stage`/`StageInput` gain `effort?: Effort`. Copy stays English.

## Entitlement

None new — effort is a property of a stage, and stages are authored under the existing DIRECT gates. It changes
cost/quality, not access. (The routing/escalation slices later are where entitlement re-enters.)

## Tests

- Pure `thinking_config(model, effort)` matrix: Opus 4.8 → output_config.effort+adaptive; Haiku 4.5 → budget_tokens<max; Sonnet 4.5 → budget_tokens; unknown → effort path; `None` → empty.
- `build_request`: effort=high on Opus emits `output_config.effort:"high"` + `thinking.adaptive`, **no** `temperature`; effort on Haiku emits `budget_tokens`; effort=None emits neither.
- `parse_response` captures thinking blocks (incl. redacted) verbatim with signature.
- `message_to_anthropic` puts thinking blocks before tool_use in `AssistantWithTools`.
- `max_tokens_for(effort)` floor.
- Frontend: `routineForm`-style pure helpers if any; stage-editor draft round-trips `effort`.

## Out of scope (later spine slices)

Escape valve `BLOCKED`/ask (slice 2), automatic model escalation (slice 3), dynamic routing (epic). Surfacing
the thinking summary in the live journal (`display:"summarized"`) — cheap follow-up once effort ships.

## FEATURES.md

Add per-stage reasoning effort under DIRECT pipeline authoring (stage fields), noting the model-capability
mapping and that it's the cost/quality lever.
