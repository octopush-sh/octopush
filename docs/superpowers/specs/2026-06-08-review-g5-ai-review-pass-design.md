# G5 · AI Review Intelligence — slice 1 (AI primitive + AI Review Pass) — design spec

**Goal:** Add an AI Review Pass to Review mode: a manually-triggered, one-shot model analysis of the worktree diff that returns structured, actionable findings (severity · category · title · file:line) in a Companion section, with each finding linking back into the diff — built on a thin, reusable `ai_complete` primitive over Octopush's existing LLM provider path.

**Architecture:** The backend already calls Claude (`resolve_provider` → `LlmProvider::complete`, Rust `reqwest` → Anthropic `/v1/messages`, with auth + model catalog + token/cost tracking). So the "AI primitive" is a thin new `ai_complete` Tauri command; the substance is prompt design + the review UX. The AI Review reviews **the same working-tree `gitDiff` that Review mode already shows** (no PR, no remote). One-shot model call (not an agent); the model is fully user-selectable.

**Tech Stack:** Rust (Tauri command reusing `providers::LlmProvider`), React 19 + TS, Zustand, Tailwind tokens, Vitest. Provider: Claude/Anthropic via the existing Rust path (NOT the JS SDK — reuse, don't duplicate).

**Part of:** the 7-stream Review overhaul — see `../plans/2026-06-07-review-mode-master-grouping.md` (G5). Branch `feat/review-g5-ai` off `main`. This is **slice 1** of G5; C (changeset summary), D (PR description), E (inline explain/refine hunk), agentic review, and real token-streaming are deferred to later slices (all reuse `ai_complete`).

---

## 1. Existing infrastructure this builds on (read first)

All confirmed in the codebase — G5 **reuses, does not modify**:

- **Model call:** `resolve_provider(model_id) -> (Box<dyn LlmProvider>, api_base, api_key)` (`src-tauri/src/chat_engine.rs:263-290`) + `LlmProvider::complete(api_base, api_key, &LlmRequest, &client) -> LlmResponse` (`src-tauri/src/providers/mod.rs:100-108`). `AnthropicProvider::complete` POSTs `/v1/messages` (`src-tauri/src/providers/anthropic.rs:14-50`). `LlmRequest { model, max_tokens, system, messages[], tools[] }`; `LlmResponse { text, tool_uses, input_tokens, output_tokens, stop_reason }`.
- **Auth:** `settings::get_provider_key(name)` + `get_anthropic_key()` (`settings.rs:87-105`) — Settings `provider_keys` + `ANTHROPIC_API_KEY` env fallback. `resolve_provider` already returns a friendly error ("… API key not configured. Open Settings · Models & Providers.") when missing.
- **Model catalog:** `ProviderRouter` (`provider_router.rs`) — built-in Anthropic (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`), OpenAI, DeepSeek, Ollama; `suggest_model(CodeReview) → claude-sonnet-4-6`. Frontend `ModelPicker.tsx` (dropdown portals correctly after PR #8).
- **Cost:** `token_engine::compute_cost(model, in, out, cache_read, cache_creation)` + `TokenEngine::record(...)`.
- **Streaming-to-UI pattern (for later slices):** Tauri events `chat://stream` / `chat://message-added` (`chat_engine.rs:506`, `324`). Slice 1 does NOT stream — it uses the full `complete()` response.
- **G3 diff surfaces (for finding→diff linking):** `FileDiffSection` renders `id={review-file-${encodeURIComponent(file.filePath)}}` with `scroll-mt-4`; `DiffView` exposes the `DiffAnchor`/`anchorSlot` primitive; `App.tsx` has `navigateToFile(path, "diff"|"editor")`.
- **Companion:** `Companion.tsx` renders `{mode === "review" && fileTree && <CompanionFileTree {...fileTree} />}` — G5 adds the AI Review section in this branch.

## 2. Locked design decisions (from brainstorming)

1. **Output = structured findings + mini narrative summary** (not free-form prose). Findings are actionable and link into the diff.
2. **Placement = Companion section** in Review mode — stacked collapsible (grid-rows): AI Review on top (collapsed until run → just its header bar), Files below.
3. **Trigger = manual** CTA. Result **cached by diff-content hash**; invalidates to "diff changed — re-run" when the changeset changes. No auto-run.
4. **One-shot** `complete()` (no token-streaming in slice 1): loading state → findings render with `.octo-rise-in`.
5. **Model = fully user-selectable** via a per-panel `ModelPicker`, persisted per workspace, **default `claude-sonnet-4-6`**. One-shot model review (NOT an agent — agentic review is slice 2).
6. **Scope = REVIEW mode, no PR**, reviews the **working-tree `gitDiff`** Review already shows (so finding anchors align with the visible diff).

## 3. Backend — the `ai_complete` primitive

**File:** `src-tauri/src/commands.rs` (new command) + register in `src-tauri/src/lib.rs`.

```rust
#[derive(serde::Serialize)]
pub struct AiCompleteResult {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
}

/// Generic one-shot model call. Reused by all G5 AI features.
#[tauri::command]
pub async fn ai_complete(
    state: tauri::State<'_, AppState>,
    model: String,
    system: String,
    prompt: String,
    max_tokens: Option<u32>,
) -> AppResult<AiCompleteResult> {
    let (provider, api_base, api_key) = crate::chat_engine::resolve_provider(&model)?;
    let req = crate::providers::LlmRequest {
        model: model.clone(),
        max_tokens: max_tokens.unwrap_or(8192),
        system,
        messages: vec![crate::providers::LlmMessage { role: "user".into(), content: prompt }],
        tools: vec![],
    };
    let resp = provider.complete(&api_base, api_key.as_deref(), &req, state.http_client()).await?;
    let cost = crate::token_engine::compute_cost(&model, resp.input_tokens, resp.output_tokens, 0, 0);
    // Record so the cost meter / token report includes AI Review usage.
    let _ = crate::token_engine::record(&model, resp.input_tokens, resp.output_tokens, cost);
    Ok(AiCompleteResult { text: resp.text, input_tokens: resp.input_tokens, output_tokens: resp.output_tokens, cost_usd: cost })
}
```
- **Match the real types:** verify `LlmRequest`/`LlmMessage`/`LlmResponse` field names and the `reqwest::Client` accessor (`state.http_client()` vs `&self.client`) against the actual code and adapt — the contract is: build a one-user-message request, call `resolve_provider` + `complete`, return text + tokens + cost. `resolve_provider` may be private to `chat_engine` — if so, make it `pub(crate)` or add a small public helper; do not duplicate provider-routing logic.
- **Errors** propagate as `AppError` (frontend surfaces the message).

**IPC** (`src/lib/ipc.ts`):
```ts
aiComplete: (model: string, system: string, prompt: string, maxTokens?: number) =>
  invoke<{ text: string; inputTokens: number; outputTokens: number; costUsd: number }>(
    "ai_complete", { model, system, prompt, maxTokens }),
```

## 4. Frontend — data model + review lib

**`src/lib/aiReview.ts`** — prompt + tolerant parse (the only review-specific logic):
```ts
export type Severity = "high" | "medium" | "low";
export type Category = "bug" | "missing-test" | "security" | "style" | "perf" | "other";
export interface AiFinding { severity: Severity; category: Category; title: string; detail: string; file: string | null; line: number | null; }
export interface AiReviewResult { summary: string; findings: AiFinding[]; }

export const AI_REVIEW_SYSTEM = `You are a meticulous senior code reviewer. You are given a unified git diff of a change a developer is about to commit. Review ONLY what the diff shows. Surface concrete, actionable issues: bugs, missing tests, security problems, performance regressions, and notable style problems. Do not praise; do not restate the diff.

Respond with ONLY a JSON object, no prose outside it, matching exactly:
{"summary": "<=160 chars, what the change does + the single biggest risk",
 "findings": [{"severity":"high|medium|low","category":"bug|missing-test|security|style|perf|other","title":"<=80 chars","detail":"1-2 sentences","file":"path as in the diff or null","line": <new-file line number or null>}]}
Use file/line from the diff's @@ headers when a finding maps to a specific line; use null for changeset-level findings. Order findings by severity (high first). If the change is clean, return an empty findings array with a summary saying so.`;

/** Tolerant: strips ```json fences, parses, validates shape, drops invalid findings. Throws on unrecoverable parse failure. */
export function parseAiReview(text: string): AiReviewResult { /* see Task plan */ }

export function buildReviewPrompt(gitDiff: string): string {
  return `Here is the unified diff to review:\n\n${gitDiff}`;
}
```

**`src/stores/aiReviewStore.ts`** — Zustand, persisted per workspace (key the persisted map by `workspaceId`):
```ts
type Status = "idle" | "running" | "done" | "error";
interface WsReview { status: Status; result: AiReviewResult | null; diffHash: string | null; model: string; error: string | null; }
// store: byWs: Record<workspaceId, WsReview>; actions: setModel(ws,model), run(ws, gitDiff), clearError(ws)
// run(): hash the diff → set running → ipc.aiComplete(model, AI_REVIEW_SYSTEM, buildReviewPrompt(diff))
//        → parseAiReview → set done{result, diffHash}; on throw → set error.
// default model = "claude-sonnet-4-6". A simple stable hash (e.g. FNV-1a) of gitDiff for diffHash.
```

## 5. Frontend — components

**`src/components/review/AiFindingCard.tsx`** — one finding. Severity dot (`high`→brass `var(--brass-dim)`, `medium`→sage, `low`→mute), category eyebrow (mono uppercase), title (ivory), detail (sage), and when `file` is set a clickable `file:line ⟶` (brass) that calls `onJump(file, line)`. No line → not clickable. Tokens only, English, focus ring.

**`src/components/review/AiReviewPanel.tsx`** — the Companion section:
- Collapsible (grid-rows `0fr↔1fr`); header bar always visible: eyebrow `§ AI REVIEW`, a `ModelPicker` (bound to `aiReviewStore` model), and the CTA `§ Review this change` (runs `store.run(ws, gitDiff)`). Collapsed by default until first run.
- Body by status: `idle` → short hint; `running` → calm loading ("Reading the change…", brass progress motion, respects reduced-motion); `done` → mini-summary line (`N findings · X high · "summary"`) + `AiFindingCard` list (`.octo-rise-in`); `error` → message + retry. If `diffHash !== currentDiffHash` → a "diff changed — re-run" affordance.
- Props: `{ workspaceId, gitDiff, onJump(file, line) }`.

**`src/components/Companion.tsx`** (additive seam): in the `mode === "review"` block, render `<AiReviewPanel workspaceId={...} gitDiff={...} onJump={...} />` stacked above `<CompanionFileTree/>`. The `gitDiff` + an `onJump` (→ `navigateToFile`) are threaded from `App.tsx` where the Companion is rendered (Review already has `gitDiff` in scope). `onJump(file, line)` → `navigateToFile(file, "diff")` then scroll to `#review-file-<enc(file)>` and flash-highlight (best-effort to the line; line-precise highlight via G3's anchor is a refinement).

## 6. Behaviors recap (locked)
Manual trigger · cached by diff hash · one-shot loading→findings · per-panel model picker (default sonnet-4-6, persisted) · findings link to the diff via `navigateToFile` + file-section scroll · empty diff → "nothing to review".

## 7. Error handling
- `ai_complete` error (no key / network / rate limit) → store `error` with the backend message (`resolve_provider`'s "API key not configured…" etc.) → panel error state + retry.
- Unparseable JSON → `parseAiReview` throws → error state "Couldn't read the review" (keep the raw text in the store so it's not lost; offer "show raw").
- Empty `gitDiff` → panel shows "Nothing to review" without calling the model.

## 8. Testing (Vitest + cargo)
- `src/lib/aiReview.test.ts` — `parseAiReview`: clean JSON; ```json-fenced; leading/trailing prose stripped; malformed → throws; invalid findings (bad severity/category, missing title) dropped; empty findings array OK. `buildReviewPrompt` includes the diff.
- `src/stores/aiReviewStore.test.ts` — status transitions (idle→running→done / →error), `diffHash` set on success + invalidation when the diff changes, `setModel` persists, `aiComplete` mocked.
- `src/components/review/AiReviewPanel.test.tsx` — CTA calls `run` (mocked `aiComplete`), renders summary + findings, finding `onJump` fires with file/line, error state renders, "diff changed" affordance when hash mismatches.
- `src/components/review/AiFindingCard.test.tsx` — severity dot/category render; clickable only when `file` set.
- Rust: a test asserting `ai_complete` builds a correct `LlmRequest` (one user message, empty tools) — extract a tiny pure `build_ai_request(model, system, prompt, max_tokens)` helper to make it unit-testable without the network; the `complete()` path itself is covered by existing provider tests.

## 9. Scope boundaries (stream independence)
- **Owns:** `ai_complete` (commands.rs + lib.rs), `ipc.aiComplete`, `lib/aiReview.ts`, `stores/aiReviewStore.ts`, `components/review/AiReviewPanel.tsx` + `AiFindingCard.tsx`. Additive seams: `Companion.tsx` (new section), `App.tsx` (thread `gitDiff`/`onJump`), `lib/ipc.ts`.
- **Reuses read-only:** `providers::LlmProvider`/`resolve_provider`, `token_engine`, `provider_router`, `ModelPicker`, `navigateToFile`, G3's `FileDiffSection` ids / `DiffView` anchor. No edits to the diff rendering (G3), staging (G4), or editor (G1).

## 10. Out of scope / deferred (later G5 slices)
Agentic review (route through the `claude` CLI runner for repo-aware findings) · real token-streaming (extend `AnthropicProvider` with SSE) · C changeset summary · D PR description · E inline explain/refine hunk (on G3's `anchorSlot`) · line-precise highlight on jump · bumping the catalog default models to 4-8.

## 11. Risks
- **`resolve_provider` visibility / exact types** — it lives in `chat_engine`; confirm signature + the `reqwest::Client` source and field names before wiring (Task 1 verifies against the real code).
- **Model returns non-JSON / extra prose** — mitigated by the tolerant parser + a strict system prompt; on failure, surface the error (never silently empty).
- **Large diff** — `get_diff_text` already caps at 1 MiB; the prompt may still be large. Acceptable for slice 1 (the model's context handles it); a token pre-check is a later refinement.
