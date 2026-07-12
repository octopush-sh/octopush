# Direct Mode Beauty Redesign — "Depth of Field & the Single Beacon"

**Date:** 2026-07-11
**Status:** Approved by the user section-by-section via visual companion (4/4 sections).
**Scope:** Every Direct-mode surface (active-run canvas, launcher, pipeline builder, Companion runs panel, RunsTray, Mission Control, HistorySheet) plus three app-wide design-language retirements.

---

## 1. Problem

The user named two pains with the current Direct mode, chosen over "flat/boring" and "fragmented":

1. **Noise / saturation** — dense stage cards, many meta lines, badges and pills competing; not enough air and calm.
2. **Disorientation** — the attention hierarchy doesn't guide: it's hard to know what is happening *now*, what needs *me*, what comes *next*.

Direction chosen: **C — Depth of field** (over A "Podium" and B "vertical Score"): keep the anatomy (track above, focus below, foot strips), impose a photographic optic and a hard attention rule.

## 2. The two laws

These govern every surface in this spec.

### Law 1 — Depth of field

What is not the subject loses ink. Concretely:

- Non-subject elements render at **38% opacity**, rising to **~70% on hover** (180ms ease-out). Nothing is removed — full detail lives one click away (focus pane, hover, or expansion). Progressive disclosure over deletion.
- The subject renders at full ink with a `--brass-dim` border and `--brass-ghost` fill.
- Fleet surfaces grade ink by band: Needs you (full) → In flight (75%) → Settled (rows at 45%).

### Law 2 — The single brass beacon

At any moment there is **exactly one** brass-accented *live* element per attention scope — the answer to "where do I look?". It carries the calm pulse (`octo-stage-pulse` family, 2.8s, no spring) and moves between fixed anchors; it never duplicates.

**Canvas-scope anchor priority (top wins):**
1. A decision the run is waiting on → the primary CTA of the decision strip (Approve / Resume / Begin this run).
2. A running stage → its track card.
3. Launcher ready (brief non-empty + concurrency/quota available) → the "Begin the run" CTA.
4. Otherwise → no beacon; the canvas is calm.

**Fleet scope:** only the run that has been waiting for the director the longest pulses (its card shows `WAITING {n} MIN`); the top-bar fleet chip pulses only when at least one run needs the user. Zero waiting runs ⇒ total calm.

**The signed transition of the redesign:** when the anchor changes (e.g., running card → Approve button at a checkpoint), the beacon *hands off*: fade-out at the old anchor synchronized with fade-in at the new one, 320ms `--ease-octo`. Never two pulses at once, never an abrupt jump. Under `prefers-reduced-motion`: no pulse at all; the beacon is a static brass border + solid CTA, and handoff is instant.

## 3. App-wide design-language retirements (binding, beyond Direct)

Confirmed by the user during this brainstorm; these supersede `docs/design-system.md` §5 where they conflict. The design-system doc and `CLAUDE.md` must be updated in the same change that lands them.

| Retired | Was | Replacement |
|---|---|---|
| **Roman numerals** (`I · II · III`) | Stage numbers, wizard steps, Mission Control micro-track | Discreet arabic numeral in the mono meta line (`3 · sonnet · api`). The Direct launcher drops step framing entirely (§6); any other surface still numbering steps uses plain arabic numerals in mono |
| **`§` glyph** ("the octopush icon") | Tool-call cards (`§ READ`), Direct role headers (`§ PLANNER`) | Lucide icon per role / per tool, always with `title` tooltip (see §4.3). Talk-mode tool cards migrate to the same recipe as a bounded cleanup in this initiative |
| **Gradient lines** (any `linear-gradient` rule/connector/divider) | Run-track connector fill, `.animate-brass-grow` launcher rule, `.octo-sweep` streak | Solid ink only: traversed/active lines are solid brass at 55% alpha (new token `--brass-line`), inactive are `--hairline`. The completion sweep becomes a solid 1px brass line crossing the strip. Radial background washes (OverlayRoom) are surfaces, not lines — untouched |
| **`⟶` glyph as track connector** | Run-track and StageFlow connectors, Mission Control micro-track | Drawn 1px lines (see above). `⟜` survives as the checkpoint gate mark — the one flow glyph left, structural only |

Related standing norms that this spec inherits: no italics anywhere, no arrow CTAs, surgical brass, stability doctrine S1–S6, motion primitives only.

## 4. New shared vocabulary (three pieces)

### 4.1 `StageDots` — the universal micro-track

One tiny component replaces every miniature representation of a run's shape: a row of 5px dots, one per stage.

- verdigris = done · brass = live/awaiting · amber = stalled · rouge = failed · hairline = pending. Where a quieter "done, long settled" shade is needed it uses a new low-alpha brass token (`--brass-quiet`), never a raw hex. Gate stages may render the dot with a ring.
- Used by: `CompanionCurrentRun`, Mission Control crew cards, `PipelineTicket` (replacing its bespoke shape line), `HistorySheet` rows.
- Props: `stages: {status, gate?}[]`, `size?`. Pure, presentational, tested.

### 4.2 Stage-card anatomy — one card, two fixed geometries

The run-track card and the builder node are **the same anatomy** (builder = preview of the run):

- **Essence** (non-subject): role icon + role name + status glyph, meta line `n · $cost` (or `n · model · substrate` in builder). Compact fixed geometry.
- **Subject** (running/awaiting/selected): adds the live line (fixed-slot, S1) and full meta `n · model · substrate`, `--brass-dim` border, ghost fill, 5ch tabular timer.
- Geometry is fixed *within* each state (S1); the essence↔subject change animates width/opacity through the standard transition (S4), 280ms.
- The gate card shows `⟜` + role; while awaiting it takes an `AWAITING YOU` mono eyebrow in brass and quiet amber-free styling (beacon lives on the CTA, not the card — Law 2 anchor 1).

### 4.3 Icon vocabulary — `src/lib/roleIcons.ts`

One module maps every archetype and tool to a lucide icon (builder's `ARTIFACT_ICON` folds into it). Roles: planner→ClipboardList, architect→Compass, implementer→Wrench, code_review→Search, test/repro→FlaskConical, fix→Hammer, verify→BadgeCheck, critique/refine→PenLine, security_review→Shield, pull_request→GitPullRequest, merge→GitMerge, release→Rocket, custom roles→CircleDashed. Tools: read→Eye, edit/write→Pencil, run→Terminal, search→Search, web→Globe. Every icon ships with a `title`. 12px in cards, 11px in lines.

## 5. Section 1 — The heart of the run (approved with one amendment)

`RunFlow` + `StageFocus` + `RunControlBar` + `RunLedger` inside `DirectCanvas`. Anatomy kept: header → track → focus → foot.

### 5.1 Run header
- Task title in serif ivory + pipeline name mono mute + elapsed mono.
- **Run controls (pause / stop-stage / abort) move up here** as quiet icon buttons (canonical icon-button recipe, rouge hover on abort). The foot no longer hosts a `RunningBar`.

### 5.2 Track (`RunFlow`)
- Cards per §4.2; depth of field per Law 1; beacon per Law 2.
- **Connectors are drawn 1px lines** (not glyphs): traversed = solid `--brass-line` (55% alpha brass), pending = `--hairline`. *(User amendment: no gradient — anywhere.)* The `⟜` gate mark renders at the gate card, not on the line.
- Horizontal scroll behavior, `RunFlowNav`, stagger entrances (`octo-rise-in`) unchanged.

### 5.3 Focus pane (`StageFocus`)
- Header: role icon + `IMPLEMENTER` mono letter-spaced brass eyebrow (no `§`, no dash), stage title in serif ivory below, tokens/cost mono right, iteration navigator unchanged.
- Journal: tool lines become icon + mono path (+ `+34 −6` counts where known); narration in sage with generous line-height (1.7); the whole journal sits behind a single left hairline — no nested boxes.
- Artifact, SnapshotDiff, iteration history, halt banners (amber transient / rouge hard), edit-stage modal: behavior unchanged, restyled to this grammar.

### 5.4 Decisions (`RunControlBar` → decision strip)
- The strip appears only when a decision exists (checkpoint, halt, terminal, draft), unfolding via `Reveal` as today.
- Checkpoint hierarchy: **Approve & continue** solid brass (beacon anchor) · **Send back with notes** brass-outline serif · Re-run / Abort ghost (rouge hover on Abort). Loop meter stays fixed-slot tabular (`review loop · 1 of 3 used`).
- Halt recovery: same components; **Resume** takes the beacon; amber/rouge conventions unchanged.
- A serif one-liner states what the run needs (e.g., "The implementation is ready for your review") with changed-files summary beneath.

### 5.5 Foot (`RunLedger`)
- One calm line, savings-first, unchanged grammar: `saved $0.089 · 86% under all-premium · spent $0.014 · budget $0.50`.
- The 2px progress inset stays (solid brass fill — already solid).
- Completion ceremony stays but the sweep is a **solid** brass line (no gradient streak); serif epitaph unchanged. Failed/aborted runs get none.

## 6. Section 2 — The launcher ("The Commission")

`PipelineSetup`. One composition surface, not a wizard.

- **No step numbering** (`I · The brief / II · The ensemble` gone). Reading order: ceremony header → brief → ensemble → foot.
- Ceremony header stays serif ("Direct the work") with a one-line sans subtitle.
- **The brief is the noblest object:** composed in Spectral serif (15px, 1.5 line-height) on `--panel` inside a hairline card; linked-issue chip and `⌘⏎ to begin` hint in its footer. Placeholder is an upright serif phrase.
- **Ensemble tickets** follow Law 1: selected = full ink + `--brass-dim` border + `StageDots`; others 38%→70% hover. Builtin `&` seal stays (brass serif, active branding). Edit affordance = pencil icon button.
- **Crew preview:** the selected ticket's stages render as one quiet line — role icon + name (+ model in mute), solid hairline connectors, `⟜` before the gated role; pencil icon at right opens per-stage editing (ModelPicker etc. unchanged).
- **Foot = the same ledger grammar as the run:** `est. saves ~$0.31 · 78% under all-premium · 21 runs left` (DirectRunsMeter folds into this line) + budget input + **Begin the run** — ghost until brief + quota + concurrency are satisfied, then solid brass with the beacon (Law 2 anchor 3).
- `.animate-brass-grow` (gradient rule) is deleted with this surface.

## 7. Section 3 — The builder (the workshop speaks the same language)

`PipelineBuilder` + `builder/*`.

- **Node = essence card** (§4.2, builder variant meta `n · model · substrate`; gate nodes carry `⟜` before the icon; loop badge `⟲ ×N` in the meta line, brass). Selected node = subject styling. **No beacon in the builder** — nothing needs the user in an editor; brass marks selection only.
- **Edges:** flow = solid hairline with minimal arrowhead; review-loop = dashed `--brass-line` arc with `⟲ ×N` pill (dashed is structure, not a gradient). Gate mark lives on the node, not the edge.
- **Palette:** role rows = icon + name, grouped under mono eyebrows; drag ghost previews the real node; `+ New role` footer opens RoleEditor unchanged.
- **Inspector:** header = role icon + mono letter-spaced eyebrow (no `§`); Atelier controls only (Listbox/Stepper/TogglePill/SegmentedControl); substrate as the existing API/CLI pills.
- **Validation** is one quiet header line: `✓ VALID` in verdigris or the first concrete error in rouge. No jumping panels.
- **Workshop background:** dot grid drops to hairline-alpha texture; MiniMap `maskColor` moves to a token (kills the last hardcoded literal, `PipelineBuilder.tsx` maskColor); React Flow chrome fully token-skinned via `.octo-flow`.

## 8. Section 4 — The fleet (Companion · tray · Mission Control · history)

- **`CompanionRuns`:** header eyebrow `RUNS` + quiet `+` icon. Current-run block = status dot + task title (ivory), `StageDots`, one fixed-slot live line (`implementer · editing settings.ts`), one mono meta line (`02:41 · $0.014 · 12.4k ↑ 3.1k ↓`). Savings line (`saved $4.12 across 31 runs`) unchanged in spirit. Past runs = the universal row: status glyph + truncated title + cost, at 45% → 85% hover.
- **Fleet chip (`RunsTray`):** `1 needs you` (brass, pulses — the only fleet beacon trigger) and/or `2 in flight` (quiet hairline chip). Settled session chip keeps the verdigris ✓ grammar.
- **Mission Control:** serif title + mono meta; three bands with ink grading (Law 1). Needs-you cards: workspace name, `WAITING {n} MIN` eyebrow, a plain sans one-line reason (serif stays reserved for the canvas decision strip), `StageDots`, savings-first ledger foot; only the longest-waiting card pulses (Law 2 fleet scope). In-flight cards at 75%: live dot / amber `⟳ stalled`, live line, `StageDots`. Settled = universal rows. Fleet ledger closes the room: `fleet saved $4.12 · 83% under all-premium · this month`. The `I ⟶ II ⟜ III` micro-track is retired in favor of `StageDots`.
- **`HistorySheet`:** universal rows + the same savings-first summary line. No other change.

## 9. Motion & accessibility summary

- Reuse only existing primitives (`FadeSwap`, `Reveal`, `octo-rise-in`, `octo-fade-in`, `octo-stage-pulse` family, `octo-sweep` reworked solid). New CSS: the beacon handoff (paired fade, 320ms) and the two-geometry card transition — both `--ease-octo`, both inert under `prefers-reduced-motion`.
- Opacity floors: dimmed content is never the *only* carrier of information (full detail in focus pane / hover / tooltips). All icons have `title`. Live values keep `.octo-tabular` and fixed slots (S1/S2/S5).
- Transition durations move off arbitrary `duration-[180ms]` values onto the `--dur-*` tokens where touched; the `45ms` stagger constant becomes a shared motion token.

## 10. Implementation notes

- **New:** `src/lib/roleIcons.ts`, `src/components/direct/StageDots.tsx`, beacon anchor selector (derived in `DirectCanvas`/`runsStore` — pure function `beaconAnchor(run, stages, launcherReady)` returning one anchor id; unit-tested single-owner invariant), token `--brass-line`.
- **Reworked:** `RunFlow` (cards, drawn connectors, beacon), `StageFocus` (header, journal), `RunControlBar` (running controls removed → header; decision hierarchy), `RunLedger` (solid sweep), `PipelineSetup` (de-wizarded, serif brief, foot), `PipelineTicket` (StageDots), `StageFlow` (icons, solid connectors), `PipelineBuilder` + `builder/*` (node anatomy, edges, palette, inspector, tokens), `CompanionRuns`/`CompanionCurrentRun`, `RunsTray`, `MissionControl`, `HistorySheet`, Talk tool-call card (`§` → tool icon).
- **Deleted:** `.animate-brass-grow`, gradient in `.octo-sweep`, roman-numeral rendering (`ROMAN` in `stageMeta`/`graph.ts` where display-only), `§` prefixes, `⟶` connector glyphs.
- **Docs in the same change:** `docs/design-system.md` (§3 brass rule already retired; §5 table — retire romans/`§`/`⟶`-connector, add StageDots + beacon + no-gradient law; §6 add handoff; Direct canvas patterns section rewritten), `CLAUDE.md` (signature-details block), `docs/FEATURES.md` (every altered surface).
- **Tests:** existing vitest suites updated (DirectCanvas.test.tsx etc.); new tests for `beaconAnchor` and `StageDots`; `npm run typecheck` + `npm test` + `cargo test` (untouched backend expected green). Manual visual pass in `npm run tauri:dev` on: launcher empty/ready, run running, checkpoint, transient halt, hard fail, completion ceremony, builder editing, Mission Control with 3 bands, reduced-motion mode.
- **Backend:** no Rust changes anticipated; this is presentation-layer only.

## 11. Out of scope

- Any behavioral change to runs, checkpoints, loops, budgets, entitlements, or persistence.
- Talk/Run/Review surfaces beyond the shared tool-call card and the retirements' doc updates.
- New colors, fonts, or chrome outside the Atelier grammar.
