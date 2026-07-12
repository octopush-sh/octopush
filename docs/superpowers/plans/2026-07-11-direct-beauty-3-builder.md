# Direct Beauty Redesign — Plan 3 of 4: The Builder (the workshop speaks the same language)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the node builder to the redesign vocabulary: role icons from `roleIcons.ts` (artifact icons retired), the `⟜` gate mark in the node header, the `⟲` glyph for loops everywhere (the loop pill/marker wrongly used `⟜`), surgical-brass tool dots, and the last hardcoded color literal tokenized.

**Architecture:** Presentation-only touch-ups on an already-disciplined surface. Spec §7 of `docs/superpowers/specs/2026-07-11-direct-beauty-redesign-design.md`. Branch `worktree-direct-beauty-3` off merged main (PRs #129/#130 in).

**Deliberate deviations from spec §7 (approved by controller):**
- Node meta stays `archetype · shortModel` — no position number: a DAG under edit has no stable linear order; the edges carry sequence (frontend-design principle: number only real sequences).
- The validation read-out stays in the footer strip (already one quiet line with an error>warning>ready ladder — richer than the spec's schematic `✓ VALID`).
- FlowEdge keeps `--brass-rule-dim` stroke (it is a SOLID thin line — compliant; pure `--hairline` vanishes against the dot grid).

**Norms:** no romans/§/⟶/gradients; `⟜` = gate only; `⟲` = loop only; icons carry `title`; tokens never literals.

---

### Task 1: Vocabulary + identity pass (one commit)

**Files:** `src/components/builder/StageNode.tsx`, `src/components/builder/NodePalette.tsx`, `src/components/builder/edges.tsx`, `src/components/builder/StageInspector.tsx`, `src/components/PipelineBuilder.tsx`, DELETE `src/components/builder/icons.ts`

- [ ] **Step 1 — StageNode.tsx:**
  1. Replace `import { ARTIFACT_ICON } from "./icons";` with `import { iconForRole } from "../../lib/roleIcons";` and `const Icon = ARTIFACT_ICON[a.artifact];` with `const Icon = iconForRole(data.role);`.
  2. Header: the icon span becomes selection-aware and the gate mark moves in front of it:
```tsx
      <div className="flex items-start gap-2">
        {data.checkpoint && (
          <span className="mt-0.5 shrink-0 font-mono text-[12px] leading-none text-octo-brass" title="Pauses for your approval">
            ⟜
          </span>
        )}
        <span className={`mt-0.5 ${selected ? "text-octo-brass" : "text-octo-sage"}`}>
          <Icon size={14} strokeWidth={1.75} />
        </span>
```
  3. Delete the bottom-right `{data.checkpoint && (… ⟜ gate …)}` badge block (the validation marker keeps its slot; the comment above the right cluster shrinks accordingly).
  4. Tool dots: `bg-octo-brass` → `bg-octo-sage` (surgical brass — dots are inventory, not accent).

- [ ] **Step 2 — NodePalette.tsx:** same icon swap (`iconForRole(a.role)` instead of `ARTIFACT_ICON[a.artifact]`); the `canLoop` marker glyph `⟜` → `⟲` (title stays "Can loop work back").

- [ ] **Step 3 — edges.tsx:** LoopEdge pill text `⟜ ×{max}` → `⟲ ×{max}` and the doc comment's `` `⟜ ×N` pill `` → `` `⟲ ×N` pill `` (⟜ is the gate mark; the loop is ⟲ everywhere else in Direct).

- [ ] **Step 4 — StageInspector.tsx:** the Loop section eyebrow `⟜ Loop` → `⟲ Loop`. The `⟜ gate` TogglePill labels are CORRECT (they control the gate) — do not touch. Header gains the role icon before the eyebrow:
```tsx
        <div>
          <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
            {(() => {
              const HeaderIcon = iconForRole(data.role);
              return <HeaderIcon size={11} strokeWidth={1.75} />;
            })()}
            {a.label}
          </p>
          <p className="font-serif text-[16px] text-octo-ivory">{stageLabel(data)}</p>
        </div>
```
(add the `iconForRole` import).

- [ ] **Step 5 — PipelineBuilder.tsx:** `maskColor="rgba(12,10,8,0.72)"` → `maskColor={`${tokens.onyx}b8`}` (same onyx at 72% alpha, now derived from the token).

- [ ] **Step 6 — delete `src/components/builder/icons.ts`** (`git rm`). Verify zero remaining references: `grep -rn "ARTIFACT_ICON\|builder/icons" src` → empty.

- [ ] **Step 7 — verify:** `npm run typecheck` clean; `npx vitest run src/components/PipelineBuilder.test.tsx src/components/builder/graph.test.ts` → all pass.

- [ ] **Step 8 — commit:** `feat(direct): builder speaks the redesign vocabulary — role icons, header gate mark, ⟲ loops` (+ Co-Authored-By trailer).

### Task 2: One guard test

- [ ] In `src/components/PipelineBuilder.test.tsx`, extend the existing palette-rendering test (the one asserting `getByText("Stages")` / `getByText("Code review")`) with:
```tsx
    expect(screen.getAllByTitle("Can loop work back").length).toBeGreaterThan(0);
    expect(screen.queryByText("⟜")).not.toBeInTheDocument(); // gate mark only appears on gated nodes, never in the palette
```
and confirm the loop markers render `⟲` (e.g. `expect(screen.getAllByText("⟲").length).toBeGreaterThan(0);`).
- [ ] Run that file → green. Commit `test(direct): palette loop marker is ⟲, gate mark stays out of the palette`.

### Task 3: FEATURES.md builder bullets

- [ ] Grep section 4's builder entries (`Node visual builder`, `StageNode`, `palette`, `inspector`, `MiniMap`, `⟜ ×N`) and update only what changed: role lucide icons (artifact-icon map retired), gate mark in the node header (badge removed), sage tool dots, `⟲ ×N` loop pill/markers, tokenized MiniMap mask. Commit `docs(features): builder after the beauty redesign`.

### Task 4: Gates + PR + merge

- [ ] `npm run typecheck` + `npx vitest run` (full; only the pre-existing 33 harness errors). Retired-language grep over the diff's added lines (`ROMAN|§|⟶|gradient|#[0-9a-fA-F]{6}` — token-derived `${tokens.onyx}b8` is sanctioned).
- [ ] Push `worktree-direct-beauty-3:direct-beauty-3`, PR base `main`, then (user-authorized) merge. Manual visual pass noted in the PR body as owed.
