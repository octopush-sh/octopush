# Direct mode — premium polish & recomposition

**Date:** 2026-06-10
**Scope:** the entire DIRECT mode surface (launcher, builder, run view, checkpoint bar, cost meter) and its companion (Runs). Frontend only — no IPC, store-contract, or backend changes.
**Driver:** live testing feedback — Direct works end-to-end but "feels like a 10-year-old program": layout jitter while stages run, form-like builder, abrupt appear/disappear, partial token discipline, no premium/wow feel, the savings story (the product differentiator) buried.

## 1. Problem statement

Three audits (token compliance, layout stability, UX hierarchy) against the shipped v0.1.54 code found:

1. **Layout instability** — stage cards size themselves from live content (`RunTrack.tsx:75–96`): the bottom line swaps between activity text (≤60 chars), verdict notices, and cost strings with different widths; no `tabular-nums` anywhere; the CheckpointBar mounts abruptly and shoves the canvas (`DirectCanvas.tsx:93`); launcher↔run↔builder are instant subtree swaps (`DirectCanvas.tsx:40–60`); errors reflow the focus pane (`StageFocus.tsx:117`); textareas expand the checkpoint bar in one frame.
2. **Form feel** — the builder is native `<select>`s, a native checkbox, a native number spinner, and ASCII `↑ ↓ ✕` buttons (`PipelineBuilder.tsx:175–277`). The ModelPicker popover is the one premium control in the mode; everything else contradicts it.
3. **Identity drift & missing narrative** — eyebrow tracking is 0.12–0.14em across every Direct file (spec: 0.25em); generic `rounded` (4px) where the scale says 6/10px; hardcoded provider hexes in `ModelPicker.tsx:35–40`; arbitrary sizes (15px, 12.5px); savings rendered as a 9px footnote under "spent"; no completion moment; journal reads as a log, not a team at work; empty/loading/error states are afterthoughts.

## 2. Approach

**Recomposition on the existing data layer.** Keep `runsStore`/`pipelineStore`/IPC and all behavior exactly as shipped. Build a small layer of reusable stability primitives and Atelier form controls, then recompose each Direct surface on top of them. Rejected alternatives: a cosmetic class-only pass (doesn't fix form-feel or narrative — explicitly not what the user asked for) and a full layout reimagining (violates the Atelier layout law and risks regressions in a shipped feature).

Two standing user overrides apply throughout: **no italics anywhere** (serif phrases are upright Spectral) and **all UI copy in English**.

## 3. Stability doctrine (new, binding for Direct surfaces)

These rules become part of the design system (documented in `docs/design-system.md` §6 after implementation):

- **S1 — Fixed-slot live text.** Any text that changes while a run executes (activity line, verdict, cost, status word, timers) renders inside a slot with fixed height and `truncate`; the slot exists in every state, so content changes never resize the container. Empty states render the slot empty, not absent.
- **S2 — Tabular numerals.** Every numeric live value (cost, %, mm:ss, iteration counts) uses `font-variant-numeric: tabular-nums` via a new `.octo-tabular` utility. Timers additionally get a `ch`-based fixed width.
- **S3 — No abrupt subtree swaps.** Mutually exclusive views (launcher/run/builder; focus-pane body modes; checkpoint-bar decision/feedback modes) transition through a `FadeSwap` primitive (old content fades out ~120ms, new fades in `--dur-quick`, geometry held by the container where possible). Honors `prefers-reduced-motion` (instant swap).
- **S4 — Height changes are animated.** Anything that expands/collapses (checkpoint bar mounting, feedback textareas, loop sub-panel, error banner, per-stage cost breakdown) uses a `Reveal` wrapper built on the sanctioned grid-rows `0fr↔1fr` idiom.
- **S5 — No motion on live tickers.** Streaming values (activity line, cost ticker, elapsed) update in place with zero animation — motion is reserved for state *transitions* (idle→running→done), per the motion spec.
- **S6 — Smooth, calm scrolling.** The journal autoscroll uses `scrollTo({behavior:"smooth"})` (instant under reduced motion); entries enter with `.octo-rise-in`.

## 4. New shared pieces

### 4.1 Primitives (`src/components/primitives/`)

- **`FadeSwap`** — `<FadeSwap swapKey={k}>{children}</FadeSwap>`. On `swapKey` change: holds the previous subtree, fades it out (120ms, `--ease-octo`), then mounts the new subtree with `.octo-fade-in`. Reduced motion ⇒ instant swap. No layout animation — pair with a stable container or `Reveal`.
- **`Reveal`** — `<Reveal open>{children}</Reveal>`. Grid-rows `0fr↔1fr` + opacity, `--dur-standard`, `--ease-octo`, `overflow-hidden` row. Extracted from the WorkContextPanel idiom so Direct (and later the rest of the app) stops hand-rolling it.

### 4.2 Atelier controls (`src/components/controls/`)

All controls: mono meta voice, `rounded-md` (10px) fields / `rounded-sm` (6px) pills, hairline borders, brass only for the active/selected state, focus ring `border-[var(--brass-dim)]`. Popovers **portal + `position: fixed`** (the overflow-clipping lesson from PR #8).

- **`SegmentedControl`** — 2–4 options in a hairline track; the active segment gets `bg-[var(--brass-ghost)]` + brass text, the indicator glides (`--dur-quick`). Used for substrate (`API | CLI` — active segment tinted with the sanctioned state-blue/state-purple instead of brass) and loop mode (`Gated | Auto`).
- **`TogglePill`** — labeled on/off pill. Off: hairline + mute. On: brass-dim border + brass-ghost bg + brass text. Used for the checkpoint flag, rendered as `⟜ gate`.
- **`Stepper`** — `− n +` with tabular numeral, min/max clamps, hidden native spinner. Used for max loop-backs.
- **`Listbox`** — anchored popover listbox in the ModelPicker's visual language (panel bg, rise-in items, brass check on active, Escape/click-outside, `.octo-menu-enter`), with optional per-option description line. Used for the role selector and the loop target.
- **`IconButton`** — square ghost button for lucide icons (`ChevronUp`, `ChevronDown`, `X`), hover `text-octo-ivory` + hairline→brass-dim border, `disabled:opacity-30`. Replaces the ASCII `↑ ↓ ✕`.

### 4.3 Tokens & utilities (`src/styles.css` + spec update)

- `.octo-tabular` → `font-variant-numeric: tabular-nums;`
- Provider dot hues become tokens (decorative, Direct + ModelPicker only): `--provider-anthropic: #cc785c`, `--provider-openai: #74aa9c`, `--provider-deepseek: #5c8acc`, `--provider-ollama: #a8a8a8`. ModelPicker switches to them — no raw hex left outside `styles.css`.
- One new one-shot keyframe `octo-sweep` — a brass rule that grows full-width once (600ms, `--ease-octo`) — for the run-completion moment. No loops, no shimmer.

### 4.4 Identity sweep (mechanical, all Direct files)

- Eyebrows: `font-mono text-[10px] uppercase tracking-[0.25em]` (9px variants move to 10px). Applies to every `tracking-[0.12em|0.13em|0.14em]` instance found by the audit.
- Radii: `rounded` → `rounded-sm` on pills/small buttons, `rounded-md` on fields.
- Sizes: `text-[15px]`→`text-sm` serif for card titles; `text-[12.5px]`→`text-[13px]`; stray 12px meta→11px.
- Brass discipline: at most one solid-brass button per surface (see CheckpointBar).

## 5. Surface designs

### 5.1 DirectCanvas — state choreography

The three canvas states (builder / launcher / run) render inside one `FadeSwap` keyed by state. The run view keeps its column layout; the checkpoint bar and the cost strip are part of a fixed bottom region so the focus pane is the only flexing element.

### 5.2 RunTrack — the assembly line

Fixed-geometry stage cards on a horizontally scrollable track (`overflow-x-auto`, no squeezing):

- Card: `min-w-[170px] max-w-[230px] flex-1 basis-0`, **fixed height**, `rounded-lg`, internal rows each with fixed height:
  - Row 1: roman numeral (brass mono) + status dot + status word in a fixed slot; elapsed timer right-aligned, `.octo-tabular`, fixed `5ch` width, present (empty) in all states.
  - Row 2: role name, serif `text-sm`, upright, `truncate`.
  - Row 3: model (mono 10px, `truncate`) + substrate pill (fixed width, centered, `rounded-sm`, state-blue/state-purple).
  - Row 4 (**the live line**, S1): one fixed-height slot that shows — running: current activity (mono, brass, truncate, no motion per S5); done: verdict in verdigris, or cost; otherwise: cost in mute, `.octo-tabular`. Keyed by *status* (not content) so transitions fade once but streaming updates don't flicker.
- Status visual grammar: running = existing `octo-stage-pulse` + verdigris dot; done = verdigris `✓` replacing the dot (`.octo-pop-in`); failed = rouge dot + rouge hairline; selected = brass border + brass-ghost (unchanged).
- **Progress narrative on connectors:** `⟶`/`⟜` between stages render at 40% opacity while the left stage is pending/running and full brass once it's done — the line visibly "fills" left-to-right as the team advances (no transient animations to track, calm by construction).
- Track header keeps `stage n / m` with corrected eyebrow tracking and `.octo-tabular`.

### 5.3 StageFocus — the work journal

- Header: `§ ROLE` as a true eyebrow (mono 10px, 0.25em, brass) + role label (serif, upright) + model (mono mute) + cost right-aligned `.octo-tabular`.
- Body modes (empty / running-journal / artifact / failed) swap through `FadeSwap`.
- **Failed:** a designed error banner — rouge left rule (2px), `rouge-ghost` background, `✕ stage halted` eyebrow, the error text selectable — entering via `Reveal`, with the journal below at full opacity (it's evidence, not decoration).
- **Running:** journal entries enter with `.octo-rise-in`; smooth autoscroll (S6). The trailing indicator becomes a role-specific verb — `planning…`, `reviewing…`, `implementing…`, `testing…` (map from role; fallback `working…`) — with a calm brass pulse dot.
- Tool cards keep the `§ TOOL` form; result line unchanged. Notices style as proper eyebrows.
- **Artifact:** text fades in; the worktree diff section shows a quiet `fetching the diff…` line that FadeSwaps into the `DiffViewer`.
- Empty state: `Pick a stage above to see its work.` (mute, centered, serif phrase).

### 5.4 CheckpointBar — the decision strip

Re-seated as a bottom-docked decision strip (the Direct analogue of "replaces the input bar"), not a floating card:

- Mounted inside `Reveal` (S4) — it *unfolds* when the run pauses and folds away on resolve; full-width, hairline top border, `brass-faint` background, no dashed border. Failed state swaps the accent to a rouge top border + `✕ stage halted` eyebrow.
- Button hierarchy (brass discipline): **Approve & continue** is the only solid-brass button. **Send back to {role} ⟜** is brass-outlined. **Reject/Re-run** ghost. **Abort** ghost with rouge hover. All serif upright phrases except Abort (mono — consequential clarity).
- The loop meter (`Review loop · 2 of 3 used` / `Loop exhausted 3/3 — approve or abort`) renders in a fixed slot with `.octo-tabular`; at cap it turns brass.
- Decision row ↔ feedback editor swap via `FadeSwap` inside the same `Reveal` (the strip grows smoothly to fit the textarea, no two-stage jolt).

### 5.5 Cost meter → the ledger strip (savings-first)

The card becomes what the design system always specified — a calm single-line strip at the canvas bottom — but **savings leads**:

- Line: `saved $0.089 · 86% under all-premium` (verdigris value, mono) `·` `spent $0.014` (brass value) — labels in mute, all values `.octo-tabular`. No baseline ⇒ `baseline unavailable` in mute instead of hiding the slot.
- A 2px progress inset underneath (onyx track, brass fill = cost as % of baseline) — width animates with `--dur-standard` so ticks glide instead of jumping.
- Clicking the strip toggles a `Reveal` with the per-stage breakdown (role + cost, tabular, two columns).
- **Completion moment (the one ceremony):** when the run transitions to `done`, a brass rule sweeps across the strip once (`octo-sweep`) and the savings phrase restates itself in serif: `This run saved $0.09 against the all-premium baseline.` One-shot, calm, no counters animating, gone on navigation. Failed/aborted runs get no ceremony.

### 5.6 PipelineSetup — the launcher

- Opens with a small ceremony: `DIRECT` eyebrow + serif H1 `Direct the work` + 28px brass rule (`.animate-brass-grow`). Section rhythm moves to 24/32 spacing.
- Steps keep roman eyebrows (corrected tracking): `I · The brief`, `II · The pipeline`, `III · The team`.
- Task textarea: serif upright placeholder (`What should the team build?`), `rounded-md`.
- **Pipeline cards get a mini-map** — each card renders its pipeline shape in mono 10px brass: `I ⟶ II ⟜ III ⟶ IV` (numerals + real connectors from its stages, ⟜ where a checkpoint gates) — the pipeline's identity at a glance, premium and cheap. Card title serif `text-sm`; Edit affordance appears on hover (mono eyebrow style, as today).
- `⟶ Compose a new pipeline` stays a serif phrase link.
- Stage list rows: role (serif) + ModelPicker + a `⟜ gate` mono badge when checkpointed (fixed slot).
- Estimate panel, savings-first like the ledger strip: lead value = `saves ~$0.09 (86%)` in verdigris serif `text-2xl` `.octo-tabular`, secondary = `runs at ~$0.014 · all-premium $0.10` mono mute. While estimating: a quiet `estimating…` mute line in the same slot (no `$0.00` flash).
- `Begin the run ⟶` unchanged (solid brass, serif). The in-progress notice renders in a fixed slot under it.
- Loading/empty states split: while `!loaded`, three skeleton card outlines (hairline, `octo-fade-in`, no shimmer); only an actual `error` shows the rouge message + `Retry`. Empty-after-load: `No pipelines yet — compose your first ⟶` (serif phrase, opens the builder).

### 5.7 PipelineBuilder — composition, not configuration

The builder becomes a two-zone canvas: **the pipeline you're shaping, then the controls that shape it.**

- **Header:** `DIRECT · BUILDER` eyebrow; the name is an inline serif `text-lg` input (borderless; hairline underline on hover/focus) — editing the title of a piece, not filling a form field. Description: quiet mono line below, same inline treatment.
- **Live preview rail:** a read-only mini-track mirroring the launcher mini-map but larger — numeral + role label per node, `⟶`/`⟜` connectors, and **loop-back annotation** under any looping review stage: `⟜ back to II · ×3` in mono brass. It re-renders on every edit — the user watches the pipeline take shape. Clicking a node scrolls to its editor card.
- **Stage editor cards** (one per stage, `Reveal`-entered, exit-faded on removal):
  - Header row: roman numeral · role `Listbox` (with one-line role descriptions) · reorder `IconButton`s (ChevronUp/Down) · remove `IconButton` (X) right-aligned.
  - Config row: `ModelPicker` (flex) · substrate `SegmentedControl` (API|CLI) · `⟜ gate` `TogglePill`.
  - Review roles get a loop panel inside a `Reveal`: `⟜ Loop` eyebrow · target `Listbox` (`— linear —` + earlier stages) · `Stepper` for max loop-backs · mode `SegmentedControl` (Gated|Auto) · the auto-mode hint and the loop-cleared notice each in fixed slots entering via `Reveal` (no flash-in).
- `⟶ Add another stage` — serif phrase ghost button after the last card.
- **Footer:** sticky bottom bar (hairline top, panel bg): `Save as my copy ⟶` / `Save pipeline ⟶` solid brass serif; `Cancel` ghost; two-step `Delete` at the right (unchanged logic). Save errors render as a designed alert card (rouge left rule + rouge-ghost bg) in a `Reveal`, not a bare log line.
- All existing semantics preserved exactly: identity-keyed loop targets, `normalizeLoops` on every mutation, fork-on-builtin, validation messages from the backend.

Reordering stays on chevrons (full keyboard accessibility, zero new dependencies); drag-and-drop is deferred — a half-good drag is worse than polished chevrons.

### 5.8 CompanionRuns — the runs ledger

- Header eyebrow corrected; beneath it a one-line cumulative ledger when any baseline exists: `saved $1.24 across 7 runs` (mono, verdigris value, `.octo-tabular`) — the differentiator compounds in view.
- Rows: a **fixed-width status slot** (the `●` no longer pushes text — the dot space is always reserved; verdigris when executing), task title `text-[13px]`, status word, cost `.octo-tabular`, issue key. Row enter `.octo-rise-in` (existing).
- `⟶ Begin a new run` unchanged.
- Empty state: `No runs yet — direct your first.` (serif phrase, mute).

## 6. Copy (English, sober, no jargon-cosplay)

| Where | Now | Becomes |
|---|---|---|
| Launcher steps | `I · Describe the work` / `II · Choose a pipeline` / `III · Your team` | `I · The brief` / `II · The pipeline` / `III · The team` |
| Empty pipelines | `No pipelines available.` | `No pipelines yet — compose your first ⟶` |
| Builder steps | `I · Name the pipeline` / `II · Assemble the stages` | `I · Name it` / `II · Compose the stages` |
| Name placeholder | `What is this pipeline called?` | `Name this pipeline` |
| Description placeholder | `One line on when to reach for it` | `When should the team reach for it?` |
| Checkpoint label | `checkpoint` (checkbox) | `⟜ gate` (TogglePill) |
| Add stage | `+ Add a stage` | `⟶ Add another stage` |
| Stage focus empty | `Select a stage to inspect it.` | `Pick a stage above to see its work.` |
| Running indicator | `working…` | role verb: `planning…` / `reviewing…` / `implementing…` / `testing…` (fallback `working…`) |
| No artifact | `No artifact yet.` | `Nothing produced yet.` |
| Diff loading | `Loading diff…` | `fetching the diff…` |
| Failed eyebrow | `✕ stage failed` | `✕ stage halted` |
| Savings line | `↓ saved $X (Y%) vs all-premium` | `saved $X · Y% under all-premium` |
| Companion empty | `No runs yet.` | `No runs yet — direct your first.` |

Kept as-is (already right): `Begin the run ⟶`, `⟶ Compose a new pipeline`, `Approve & continue`, `Send back to {role}`, `Abort`, `Save as my copy ⟶`.

## 7. Out of scope

Per-stage diff snapshots, Codex substrate, budget enforcement, drag-and-drop reorder, any backend/IPC change, any store contract change, other modes (Talk/Run/Review) beyond the shared primitives landing in neutral locations.

## 8. Testing & acceptance

- Vitest: `FadeSwap` (swap on key change, reduced-motion instant path), `Reveal` (open/close semantics), each control (`SegmentedControl`, `TogglePill`, `Stepper`, `Listbox` keyboard/escape/portal), RunTrack fixed-slot rendering per status, CheckpointBar mode swaps + loop meter cap state, builder serialization unchanged (existing tests keep passing), ledger strip savings-first math + no-baseline slot.
- `npm run typecheck` green; existing Direct tests green.
- Checklist greps: no raw hex outside `styles.css`; no `tracking-[0.1`-prefixed values left in Direct files; no native `<select>`/`<input type="number">`/`<input type="checkbox">` left in Direct surfaces.
- Manual pass: a live run shows zero horizontal jitter on stage cards; checkpoint bar unfolds/folds; canvas states crossfade; completion shows the sweep + savings phrase once.

## 9. Rollout

Single PR (`feat/direct-premium-polish`), implemented in four waves: (P0) primitives + controls + tokens, (P1) run experience (track, focus, checkpoint, ledger, canvas choreography), (P2) launcher + builder, (P3) companion + identity/copy sweep + checklist. /code-review before merge; local `.app` build for user verification; **no release without explicit approval**.
