# Direct Mode — Multi-Agent Pipeline Orchestration

**Date:** 2026-06-07
**Status:** Design approved, pending implementation plan
**Scope:** New fourth mode ("Direct") that orchestrates a configurable pipeline of AI agents across the software-development lifecycle, within a single workspace (Tauri 2 + React 19 + TypeScript frontend, Rust backend).

---

## 1. Summary

Octopush today offers three intent-based modes — **Talk** (chat), **Run** (terminals), **Review** (diffs/files) — but lacks a definitive differentiator. This spec introduces a fourth mode, **Direct**, that turns Octopush into the conductor of a *team* of AI agents.

In Direct, a developer defines a **pipeline** — an ordered list of stages (plan → review → implement → review → test) — and assigns **each stage to the model/tool with the best quality-for-cost** for that job (e.g. a cheap model plans, Claude implements, another reviews). Octopush runs the pipeline with configurable **checkpoints**, and shows **live and estimated cost vs an all-premium baseline**, making the savings explicit.

The differentiator is not "agents that talk to each other." It is **orchestration with measurable cost and surgical control**: the only IDE that lets a developer compose a per-stage agent team, watch it build software, intervene exactly where it matters, and see how much money the routing saved — all built on infrastructure Octopush already has (`provider_router`, `chat_engine`, `pty` daemon, `budgets`/`token` tracking, git-worktree workspaces).

### Goals

- Let a developer assign a specific model/tool to each stage of a build, optimizing quality-for-cost per stage.
- Orchestrate stages automatically with configurable checkpoints, so the developer intervenes only where they choose.
- Make token/cost optimization visible and provable: estimated and live cost, plus savings vs an all-premium baseline.
- Support a **hybrid** substrate — some stages via in-app API calls, some via headless CLI agents (Claude Code) — behind one uniform abstraction.
- Keep Direct entirely **optional and non-blocking**: it is a fourth path, chosen per workspace; the Talk/Run/Review trinity stays first-class. If a user never opens Direct, Octopush behaves exactly as today.

### Non-goals

- **No DAG.** Pipelines are linear (ordered list). Branches, parallel stages, and conditionals are explicitly out of scope (YAGNI for now; the data model leaves room but we do not build it).
- **No automatic, human-free retry loops.** A failed or rejected stage stops at a checkpoint for human decision. No autonomous "keep trying until it works."
- **No Jira write-back / auto-marking of acceptance criteria.** Jira context in Direct is read-only, identical to the other modes. (Considered and rejected as too "magic"/risky.)
- **No new top-level chrome.** Direct reuses the existing `ModeSwitcher`; it does not introduce tabs or a new panel layout. It adds a fourth mode entry — a spec-level design change, owned by §10.
- **No backend rewrite.** `provider_router`, `pty_manager`, `git_ops` stay as-is; the orchestration layer is additive. One targeted refactor is in scope: extracting a headless, persistence-free agentic-turn function out of `chat_engine::send_agentic` (see §4) so `ApiRunner` can reuse the loop without polluting the workspace chat.
- **No automatic commit or merge.** A completed run leaves its changes **uncommitted in the worktree**; the developer reviews and commits via Review mode, exactly as with any other work. Direct orchestrates *building*, not shipping. (Run history may later show a "merged" status sourced from the existing PR/git tracking, but Direct itself never commits.)
- **No spend enforcement in MVP.** Cost is *tracked and displayed* (estimate, live, savings); a run is not hard-blocked by a budget. A pre-stage budget gate is a fast-follow (see §5.2).

### Constraints

- Must work within the existing Tauri 2 + React 19 + Tailwind v4 + Zustand + SQLite architecture.
- Must honor the Atelier design system (Onyx & Brass) and the project's **no-italic** rule (the design system's italic-serif is overridden app-wide; Direct uses upright serif for display).
- All visible UI copy is English (per CLAUDE.md), including in mockups and components. The conductor mode is labeled **"Direct"** in the ModeSwitcher to sit beside Talk / Run / Review.
- CLI agents are invoked **headless** (`claude -p --output-format json`, future `codex exec`) so output and token usage can be captured; interactive PTY agents remain a Run-mode concern.

---

## 2. Concepts & vocabulary

| Term | Meaning |
|------|---------|
| **Pipeline** | A reusable, ordered list of stages. The 3 curated templates are seeded pipelines; users may clone/edit. |
| **Stage** | One step in a pipeline: `{ role, agent (model/tool), substrate, checkpoint: bool, io contract }`. |
| **Substrate** | How a stage executes: `API` (in-app via `chat_engine`/`provider_router`) or `CLI` (headless external agent). Derived from the chosen agent. |
| **Run** | A single execution of a pipeline in a workspace, with its own cost, baseline, status, and per-stage state. |
| **Artifact** | The structured output a stage hands to the next (plan text, review findings, test list). Distinct from the worktree, which is the shared file state. |
| **Checkpoint** | A per-stage flag; when set, the run pauses after that stage for a human decision. |
| **Baseline** | The hypothetical cost if every stage had run on the configured premium reference model. Drives the "saved vs all-premium" figure. |

---

## 3. Control model

A **single engine: autonomous execution with configurable checkpoints.** This is not three modes; it is one engine where checkpoints are configuration:

- A checkpoint on **every** stage = fully human-in-the-loop.
- A checkpoint on **some** stages = autonomous with safety gates (the MVP default).
- A checkpoint on **no** stage = fully autonomous (a power-user setting, reachable by toggling gates off — no new code).

**MVP default:** checkpoints **on** for `implement`, `code review`, and `test`; **off** for the cheap reasoning stages (`plan`, `plan review`). Conservative by design: the human approves before code is written and before it is finalized. As trust grows, the user removes gates and moves toward full autonomy without any product change.

### Stage lifecycle (state machine)

```
pending → running → ┬→ awaiting_checkpoint → (user action) → next stage | re-run | done | aborted
                    ├→ done (no checkpoint) → next stage
                    └→ failed → awaiting_checkpoint (human decides)
```

Run-level status: `draft` (configuring) → `running` → `paused` (at a checkpoint) → `completed` | `aborted` | `failed`.

### Checkpoint actions (all four in MVP)

When the run pauses at a checkpoint, the user may act on the just-finished stage's artifact:

1. **Approve & continue** — accept and trigger the next stage.
2. **Reject & re-run stage** — re-run the same stage, optionally with written feedback and/or a different model assignment. (Bounded re-runs; no automatic loop.)
3. **Edit the artifact by hand** — open the artifact in its native surface and edit before continuing. For *text* artifacts (plan, review findings) this edits the stored `StageArtifact.text`. For *code* stages (implement/test) the artifact is effectively the worktree diff: editing means editing files in the embedded diff/editor surface; on resume the runner re-reads the diff to refresh the artifact. Either way the edited artifact is what the next stage receives.
4. **Abort the run** — stop the pipeline; the worktree is left as-is for the user to handle.

These are cheap: the engine is already paused at the checkpoint; the action only changes what `resolveCheckpoint` does on resume.

### Completion & commit

A run that passes its last stage transitions to `completed`. **Direct does not commit or merge** — it leaves all changes uncommitted in the worktree, and the developer reviews/commits via Review mode. This keeps the human as the final gate on what enters git, and means abort and completion differ only in status, not in worktree handling.

---

## 4. Substrate: the hybrid abstraction

The hybrid (API + CLI per stage) is kept sane by **one abstraction both substrates implement**, so the orchestrator never branches on substrate.

```rust
// Conceptual — final signatures decided in the implementation plan.
trait AgentRunner {
    async fn run(
        &self,
        stage: &StageSpec,          // role, model id, params, checkpoint
        input: &StageArtifact,      // upstream artifact (or the initial task)
        worktree: &Path,            // shared file/git state
    ) -> Result<StageOutcome, AppError>;
}

struct StageOutcome {
    artifact: StageArtifact,        // structured output for the next stage (see below)
    usage: LlmResponseUsage,        // input/output/cache tokens — same fields as LlmResponse (providers/mod.rs)
    cost_usd: f64,                  // derived from provider_router pricing
    status: StageStatus,            // done | failed
}
```

**`StageArtifact`** is a tagged value, not free text, so the focus pane and "edit by hand" know what they're handling:

```rust
struct StageArtifact {
    kind: ArtifactKind,             // Plan | Review | Tests | Diff | Note
    text: String,                   // human-readable body (the plan, the findings…)
    payload: Option<serde_json::Value>, // optional structured detail (e.g. review findings as a list)
    refs_worktree: bool,            // true for code stages whose real output is the worktree diff
}
```

For code stages (`implement`, `test`), `refs_worktree = true` and the diff is read from git on demand; `text` holds a summary. The initial task that seeds stage 1 is itself a `StageArtifact { kind: Note, text: <task> }` (see §5.4 for where the task comes from).

Two implementations:

- **`ApiRunner`** — runs a stage by invoking the agentic tool-loop currently embedded in `chat_engine::send_agentic`. **This requires a Phase-A refactor:** today `send_agentic` is hard-wired to chat — it persists to `chat_messages`, reads history by `workspace_id`, and emits `chat://` events. We must extract a headless `run_agentic_turn(model, system, input, worktree) -> (text, tool_calls, usage)` core, with the chat persistence/eventing left as a thin wrapper over it. `ApiRunner` calls the core; token usage is **exact** (returned by the API). Used for stages mapped to Anthropic/OpenAI-compatible/local models.
- **`CliRunner`** — spawns a headless external agent via `std::process::Command` in the worktree (`claude -p --output-format json`) and parses the structured JSON (final text + token usage); cost via `provider_router` pricing. **Note:** the existing `agent_adapter.rs` "claude" plumbing builds an *interactive PTY* command and scrapes scrollback for tokens — it is **not** reusable here; `CliRunner` is fresh code with its own JSON parser. It must also detect a missing/unauthenticated CLI binary and surface that as a stage `failed` (→ checkpoint), not a crash. All CLI fragility is isolated behind the trait.

**MVP substrates:** `ApiRunner` (full) + `CliRunner` for **Claude Code only**. Codex as a second CLI is a fast-follow.

### Handoff = worktree + artifact

The shared, authoritative state between stages is the **git worktree** (exactly as today — `git_ops`). The `implement` stage edits files; `code review` reads the diff; `test` adds test files. In addition, a structured **`StageArtifact`** (the plan text, the review findings) is threaded forward so a stage receives its predecessor's conclusion explicitly. No new transport is invented.

---

## 5. Backend architecture (`src-tauri/src/`)

All new; no orchestration exists today.

### 5.1 Orchestrator (`orchestrator.rs`)

- Drives a run as a background `tokio` task (non-blocking; the UI stays responsive, mirroring how chat streaming and the PTY daemon already work).
- Executes stages **sequentially** (linear pipeline).
- Owns the stage/run state machine (§3). After a checkpointed stage, transitions the run to `paused` and emits an event; on `resolveCheckpoint`, resumes per the chosen action.
- Persists every transition to `run_stages` (and optionally `run_events`) so a run survives an app restart and can be inspected/replayed.
- Concurrency: **one active run per workspace** in MVP (multiple concurrent runs is a fast-follow). Because a run mutates the worktree, the UI surfaces a "run active" indicator on the workspace and discourages simultaneous manual edits in Run/Talk on the same worktree while a run is executing; hard locking is out of scope for MVP (the worktree isolation already contains blast radius).

### 5.2 Cost & baseline

- Per-stage cost from the stage's token usage × `provider_router` pricing; accumulated into the run.
- **Baseline** = cost if every stage had used the configured **premium reference model**, computed per stage as `(stage's actual input tokens × ref input price) + (stage's actual output tokens × ref output price)` — i.e. same token counts, premium prices — so the comparison is apples-to-apples. Default reference = the model with the highest **blended** price (`input_cost_per_m + output_cost_per_m`) among **enabled** providers; user-overridable per pipeline. If no premium model exists above the cheapest used (e.g. an all-local setup), baseline = actual and savings = `$0` (shown honestly, not hidden). Savings = `baseline − actual`. Estimated cost (pre-run) uses heuristic token estimates per role; live cost replaces estimates as stages complete.
- Reuses `token_events` for spend **tracking** (a run records its events like chat does), scoped by `workspace_id` to match the existing chat-event scoping. **Spend tracking only in MVP** — there is no spend *enforcement* in the codebase today (`budgets` is display-only), and we do not add a hard block now. A fast-follow may add a pre-stage budget gate that pauses the run at a synthetic checkpoint when over budget.

### 5.3 Data model (`db.rs`, new tables)

| Table | Key columns | Notes |
|-------|-------------|-------|
| `pipelines` | `id`, `name`, `description`, `is_builtin`, `created_at` | The 3 curated templates seeded as built-ins; user clones become rows here. |
| `pipeline_stages` | `id`, `pipeline_id` (FK), `position`, `role`, `agent_model`, `substrate`, `checkpoint_default` | Ordered stages of a template. |
| `runs` | `id`, `workspace_id` (FK), `pipeline_id` (FK), `status`, `cost_usd`, `baseline_usd`, `reference_model`, `linked_issue_key`, `created_at`, `finished_at` | One execution. `linked_issue_key` mirrors the workspace's. |
| `run_stages` | `id`, `run_id` (FK), `position`, `role`, `agent_model`, `substrate`, `status`, `checkpoint`, `input_tokens`, `output_tokens`, `cost_usd`, `artifact`, `log_path`, `started_at`, `finished_at` | Per-stage state of a run (the run's own copy, so editing a template later doesn't mutate history). |
| `run_events` | `id`, `run_id` (FK), `timestamp`, `kind`, `payload` | Append-only audit/replay log. Recommended for MVP; minimal cost. |

### 5.4 IPC (`commands.rs` + `src/lib/ipc.ts`)

New commands (all `AppResult<T>`): `listPipelines`, `getPipeline`, `clonePipeline`, `createRun(workspaceId, pipelineId, task, stageOverrides)`, `startRun(runId)`, `getRun(runId)`, `listRuns(workspaceId)`, `resolveCheckpoint(runId, action, feedback?, modelOverride?)`, `abortRun(runId)`, `estimateRunCost(pipelineId, stageOverrides)`.

**The initial task** (what to build) is the `task` argument to `createRun`. It is entered by the user in `PipelineSetup` as a free-text field, **pre-filled** from `workspaces.task` and, when a Jira issue is linked, the issue title/summary — so the common case is one keystroke (accept the prefill) and the developer can always edit it. The task becomes the seed `StageArtifact` for stage 1 (§4).

New Tauri events (paralleling `chat://` / `pty://`): `run://stage-update`, `run://cost`, `run://checkpoint`, `run://log`. Stores listen once and reduce, exactly like `chatStore`.

---

## 6. Frontend architecture (`src/`)

### 6.1 Mode registration

- Add `"direct"` to `WorkspaceMode` in `src/lib/modes.ts` and a fourth entry to `ModeSwitcher` (label **"Direct"**, shortcut **`CtrlCmd+Shift+D`**). Note: the natural `CtrlCmd+Shift+4` is avoided because the OS intercepts ⌘⇧4 (macOS screenshot) before the webview; `D` (for Direct) is free both in-app and at the OS level.
- Mode is **per-workspace** state (as today). The pipeline runs in the backend tied to the workspace; switching that workspace to Talk/Run/Review does not stop the run — Direct is a *view*, not a lock.

### 6.2 Stores (Zustand, `src/stores/`)

- `pipelineStore` — available pipelines/templates and their stages.
- `runsStore` — runs per workspace, the active run, live cost, per-stage state; updated via `run://` events. Follows the established selector/empty-default pattern to avoid re-render loops.

### 6.3 Components

- **`DirectCanvas`** — the canvas for Direct. Two states:
  - **Setup (empty) state:** `PipelineSetup` — a **task field** (pre-filled from `workspaces.task` / linked Jira, editable) describing what to build, choose template (I), assign team per stage with a model dropdown + checkpoint toggle (II), estimated cost vs baseline + "Begin the run ⟶" CTA (III).
  - **Run state:** a persistent **horizontal track header** (the assembly-line layout: roman numerals, per-stage model, substrate pill, live per-stage cost, the checkpoint gate glyph, and elapsed / spent / saved-vs-baseline) **+ a focus pane** below.
- **Focus pane** — shows the selected/active stage **in its native surface, embedded** (not by navigating away): `ChatView`-style for `plan`, the terminal surface for `implement` (CLI), the `ReviewCanvas` diff for `code review`/`test`. Clicking a stage in the track fills the focus pane.
- **`CheckpointBar`** — when paused, presents the four checkpoint actions over the just-finished artifact.
- **Companion (right panel):** a new **Runs** section (active run highlighted, history below, "⟶ Begin a new run" CTA) + the existing **Context · Jira** panel reused read-only.

### 6.4 Reuse, not reinvention

The focus pane reuses `ChatView`, the terminal/PTY surface, and `ReviewCanvas`/diff components. Direct is largely *composition* of existing surfaces under a new orchestration shell, plus the track/setup/companion-Runs pieces.

---

## 7. UX layout (validated via visual brainstorming)

- **Layout choice:** horizontal assembly-line track (chosen over a vertical relay) for whole-pipeline-at-a-glance, combined with a focus pane below for the active stage.
- **Contract preserved:** Rail (unchanged) · Canvas (track + focus pane) · Companion (Runs + Jira). Same structure as Talk/Run/Review.
- **Signature details:** `⟶` brass prompt glyph between stages and on CTAs; `§ TOOL_NAME` in the live stage surface; roman numerals (I·II·III) for stages and setup steps; the brass `&` in branding; upright serif (no italic) for display.
- **Cost as a moment:** the setup screen shows `~$0.46 vs $1.66 all-premium → saves ~$1.20 (72%)` with a comparison bar *before* the run; the run header shows live spent + saved.

Reference mockups produced during brainstorming: `director-layout.html` (A vs B), `direct-fulllayout.html` (run state), `direct-setup.html` (setup state) under `.superpowers/brainstorm/`.

---

## 8. MVP scope

**In scope:** the Direct mode; 3 curated templates (Feature Factory, Bugfix relay, Plan & review); per-stage model swap; substrates `ApiRunner` (full) + `CliRunner` (Claude Code only); linear sequential execution; checkpoints with all four actions; estimated + live cost and savings-vs-baseline; one active run per workspace; persisted runs and run history.

**Fast-follow (not MVP):** linear builder (reorder/insert/remove stages and custom roles); Codex as a second CLI substrate; multiple concurrent runs per workspace.

**Deferred (YAGNI):** DAG (branches/parallel/conditionals); Jira acceptance-criteria auto-marking; autonomous human-free retry loops.

---

## 9. Risks & mitigations

1. **Headless-CLI output fragility** — `claude -p`/`codex exec` formats can change. → Isolate all parsing in `CliRunner` behind `AgentRunner`; add contract tests over recorded fixtures; ship MVP with a single, well-supported CLI.
2. **The pipeline's own token cost** — orchestration consumes tokens. → Make it explicit and honest in the cost panel; the baseline proves the *net* saving.
3. **Trust/safety of agents editing autonomously** — → Generous default checkpoints + the already-isolated git worktree mean changes are contained. Because Direct never commits (§3, completion), every change stays as an uncommitted worktree edit the developer must consciously commit via Review — git itself is the final gate.
4. **Token-estimate accuracy (pre-run)** — estimates can mislead. → Label them as estimates (`~`), refine heuristics from historical `run_stages` data, and replace with actuals live.
5. **Missing/unauthenticated CLI** — `CliRunner` assumes `claude` is installed and logged in. → Detect the binary and auth state; on failure, mark the stage `failed` so the run pauses at a checkpoint with a clear message, never crashing the orchestrator.
6. **`chat_engine` refactor regressions** — extracting the headless agentic core (§4) touches the live chat path. → Keep `send_agentic`'s behavior identical by making it a thin wrapper over the new core; existing chat tests must stay green.

---

## 10. Design-system impact

Adding a fourth mode is a spec-level change to the Atelier "surface contract" (which fixes the modes as Talk/Run/Review). This spec authorizes it: Direct is a peer mode at a **different altitude** (conducting vs. directly working), reusing the existing `ModeSwitcher` rather than introducing new chrome. The canonical design spec (`2026-05-16-octopus-ux-redesign-design.md`) and `docs/design-system.md` will be updated to document the fourth mode and the new run-track / cost-meter / checkpoint patterns. New substrate pills (`API` blue `--color-state-blue`, `CLI` purple `--color-state-purple`) use existing tokens (`styles.css`) — **no new colors**.

---

## 11. Testing

- **Rust:** orchestrator state-machine tests with a **mock `AgentRunner`** (transitions, checkpoints, all four resume actions, abort, failure) — no real API/CLI calls. `CliRunner` contract tests over recorded `claude -p` output fixtures. Cost/baseline math unit tests.
- **Frontend:** Vitest for `runsStore` (event reduction → state) and `pipelineStore`; `npm run typecheck` before any change is claimed complete.

---

## 12. Rollout phases

- **Phase A — Engine:** the `chat_engine` headless-core extraction (§4) + data model + `AgentRunner` trait + `ApiRunner` + orchestrator + IPC, with tests. No UI.
- **Phase B — Mode shell:** Direct mode registration, `PipelineSetup`, run-state canvas (track + focus pane), `runsStore`, companion Runs — end-to-end with API substrate only.
- **Phase C — Hybrid + cost:** `CliRunner` (Claude Code), live cost + savings-vs-baseline, checkpoint actions complete.
- **Phase D — Polish:** motion primitives applied (track reveals, checkpoint pulse), design-system spec update, empty/error states.

Each phase is independently shippable and leaves Talk/Run/Review untouched.

**Decomposition into implementation plans.** This spec is too large for one plan (≈5 backend subsystems + a full new mode UI). Split into at least two plans, each with its own plan → execute cycle: **Plan 1 = Phase A** (backend engine, no UI — independently testable behind the `AgentRunner` mock) and **Plan 2 = Phases B–D** (the Direct mode UI, hybrid CLI substrate, cost surfacing, and polish), which depends on Plan 1's IPC surface.
