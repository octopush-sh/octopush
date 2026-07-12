# Direct Beauty Redesign — Plan 4 of 4: The Fleet + the App-Wide Retirement Sweep + Docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox steps.

**Goal:** Finish the initiative: fleet surfaces on StageDots + the fleet beacon; retire `§`, Roman numerals, and gradient lines from the ENTIRE app; rewrite the design docs. Branch `worktree-direct-beauty-4` off merged main (#129-#131 in).

**Norms recap:** `⟜` gate-only · `⟲` loop-only · no `§` anywhere (not even as logomark — the brand accent is the brass `&`) · no romans · no gradient LINES (fades). Repeating-stripe patterns (`.rail-bar-running`) and radial/mask washes are NOT lines — keep. Icons carry `title`. Tokens only.

---

## Batch A — The fleet (one implementer run, then reviews)

**Files:** `src/components/MissionControl.tsx` + `.test.tsx`, `CompanionRuns.tsx`, `CompanionCurrentRun.tsx`, `RunsTray.tsx`, `HistorySheet.tsx`, `src/lib/liveLine.ts`, `src/lib/stageMeta.ts`. Read each before editing; spec §8 governs.

- [ ] **A1 — `src/lib/liveLine.ts:9`:** `` return `§ ${e.tool}${e.hint ? " " + e.hint : ""}`; `` → `` return `${e.tool}${e.hint ? " " + e.hint : ""}`; ``. Update `src/components/MissionControl.test.tsx:182` `"§ EDIT src/x.rs"` → `"EDIT src/x.rs"`. (This also cleans the RunFlow live line — no other consumer asserts the prefix; grep to confirm.)
- [ ] **A2 — `CompanionCurrentRun.tsx`:** replace the bespoke per-stage `dotClass` strip with `<StageDots stages={stages.map(s => ({ status: s.status, checkpoint: s.checkpoint, error: s.error, title: stageTitle(s) }))} />`. Keep everything else (eyebrow, status word, live stage line, cost/tokens) but ensure the live line sits in a fixed-height truncating slot (S1) if it doesn't already.
- [ ] **A3 — `CompanionRuns.tsx`:** past-run rows get the depth-of-field row optic: `opacity-45` base, `hover:opacity-85 focus-within:opacity-85 transition-opacity duration-[180ms]` (current run block stays full ink). Row anatomy stays: status glyph + truncated title + cost. Savings line + header untouched.
- [ ] **A4 — `RunsTray.tsx`:** the chip splits by attention: if any run `awaiting_checkpoint`/halted (needs the director) → brass chip `"{n} needs you"` carrying `octo-stage-pulse`; else if any running → QUIET hairline chip `"{n} in flight"` (sage, no pulse); settled-session ✓ verdigris behavior unchanged. Derive needs-you from the same predicate MissionControl's Needs-you band uses (read it; reuse/extract if shared cheaply).
- [ ] **A5 — `MissionControl.tsx`:** (i) the `ROMAN`-based micro-track (line ~336) → `<StageDots>` (same mapping as A2); remove the `ROMAN` import; (ii) band ink grading: In-flight cards wrapper `opacity-75`, Settled rows `opacity-45 hover:opacity-85 transition-opacity duration-[180ms]`; Needs-you full ink; (iii) fleet beacon: only the LONGEST-WAITING needs-you card pulses — compute from the band's existing wait/`statusSince` data (oldest first); the others keep the brass border without `octo-stage-pulse`; add/adjust its `WAITING {n} MIN`-style eyebrow only if already present (don't invent new chrome); (iv) keep everything else (bands, abort/dismiss, ledger foot).
- [ ] **A6 — `HistorySheet.tsx`:** rows conform to the universal row (status glyph + title + savings/cost, mono) with the 45→85 row optic if rows are currently full-ink. No structural changes.
- [ ] **A7 — `src/lib/stageMeta.ts`:** delete the `ROMAN` export. `grep -rn "ROMAN" src` → must be empty.
- [ ] **A8 — verify:** `npm run typecheck`; `npx vitest run src/components/MissionControl.test.tsx src/components/Companion.test.tsx src/components/RunFlow.test.tsx` green (fix any assertion that referenced romans/§ in these files — preserve intent). Commit: `feat(direct): fleet on StageDots + fleet beacon + ink bands (romans/§ out of live lines)`.

## Batch B — The `§` + gradient sweep (one implementer run, then reviews)

**Rendered-`§` sites** (doc comments referencing spec sections are fine and stay):

- [ ] **B1 — `ToolCallCard.tsx:176`** and **`chat/LiveToolCard.tsx:75`**: the `§` glyph before the tool label → the tool's lucide icon via `iconForTool(<tool name prop>)` (12px, brass, `title` = tool name). Keep the rest of the card chrome identical. Check both files' tests (`grep "§" src/components -r --include="*.test.tsx"`) and update assertions to the new DOM.
- [ ] **B2 — `EditorBinaryPane.tsx:24`** `§ Binary` → lucide `FileWarning` (12px) + `Binary` text.
- [ ] **B3 — `CommandPalette.tsx:189`** `glyph="§"` → read the entry + glyph rendering; if the glyph slot accepts a ReactNode use the matching lucide icon; if string-only, use `"&"`. Declare the choice.
- [ ] **B4 — `WelcomeScreen.tsx:80-88`** the `§` logomark → the brass serif `&` (same sizing/position/classes; comment updated: the ampersand is the brand's one typographic accent). Update any test asserting the logomark.
- [ ] **B5 — `NewProjectFlow.tsx:395,485`** `§ {folder}` / `§ {host}` → lucide `Folder` / `Globe` (11px, mute) + text. Update `NewProjectFlow.test.tsx:165,561,583` regexes to drop `§ `.
- [ ] **B6 — `chat/Composer.tsx:406-412`** (attachment markers injected into the outgoing prompt text): `` `\n\n§ ${rel}\n\`\`\`\n…` `` → `` `\n\n${rel}\n\`\`\`\n…` `` and the two not-included variants likewise (the fence already delimits; no glyph needed). **`Composer.tsx:603`** attach `§` span → lucide `Paperclip` (12px) with `title="Attached file"`. Grep Composer tests for `§`.
- [ ] **B7 — `chat/SlashMenu.tsx:52`** the serif `§` → read context; use the matching lucide icon (likely `Slash`/`Command`-family). Declare the choice.
- [ ] **B8 — gradient lines:** delete `src/components/BrassRule.tsx` and remove its usages in `NewProjectFlow.tsx`, `WelcomeScreen.tsx`, `WorkspaceCreator.tsx`, `chat/ChatCanvas.tsx` — no replacement element (spacing/hairline only if the layout collapses without it; prefer nothing). Delete the inline gradient rules at `ChatMessage.tsx:147` and `CompanionReview.tsx:65` (same treatment). `lib/markdownComponents.tsx`: `hr` → solid `h-px border-0 bg-octo-hairline` (update the file's doc comment). `src/styles.css`: delete `.animate-brass-grow` (line ~222) and `@keyframes brassgrow` (line ~134).
- [ ] **B9 — verify:** `grep -rn "§" src --include="*.tsx" --include="*.ts"` → only doc-comment spec references remain (no rendered strings); `grep -rn "linear-gradient(90deg" src` → empty; `grep -rn "brassgrow\|animate-brass-grow\|BrassRule" src` → empty. `npm run typecheck` + run every touched `.test.tsx` file. Commit: `feat(design): app-wide retirement — § and gradient rules leave the language`.

## Batch C — Docs (one implementer run)

- [ ] **C1 — `docs/design-system.md`:** §3: brass-rule bullet now reads fully deleted (no legacy allowance). §5 signature table: `§` → **RETIRED** (replaced by `lib/roleIcons.ts` icons with tooltips); Roman numerals → **RETIRED** (arabic digits in mono meta); `⟶` row → **RETIRED** (connectors are drawn solid lines: `--brass-line` traversed / hairline ahead); keep `⟜` (gate, structural), add `⟲` (loop) as Active; `&` stays (now also the Welcome logomark). Add to §6: the single-beacon law (one `octo-stage-pulse` per attention scope, anchors via `lib/beacon.ts`; PRM = static `--brass-dim` halo; appearance/disappearance ride the pulse's zero-shadow keyframe + surrounding Reveal/FadeSwap — no separate handoff animation). §8 Direct patterns: rewrite run-track/focus/ledger/launcher/builder/Mission-Control paragraphs to match shipped reality (StageDots universal micro-track incl. Mission Control; no `I ⟶ II ⟜ III`).
- [ ] **C2 — `CLAUDE.md`:** update the "Signature details" block to the same table truth (retire § + romans + ⟶; ⟜/⟲ structural; & the one typographic accent; no gradient lines anywhere; StageDots + beacon as the new signature mechanics).
- [ ] **C3 — spec amendment:** append to `docs/superpowers/specs/2026-07-11-direct-beauty-redesign-design.md` a short "## Amendment (2026-07-11, post-implementation)" noting: beacon handoff shipped as satisfied-by-design (zero-shadow pulse start + Reveal/FadeSwap context, PRM static halo) instead of a bespoke paired fade; builder deviations (no node numbering, footer validation, FlowEdge stroke); launcher crew line shows model only when overridden; `§` retirement extended to the Welcome logomark (replaced by `&`).
- [ ] **C4 — `docs/FEATURES.md`:** fleet bullets (RunsTray needs-you chip, Mission Control StageDots + longest-waiting beacon + ink bands, Companion row optics, HistorySheet rows), Talk tool-card icon bullets, Welcome/NewProject/SlashMenu/CommandPalette/Composer entries that mentioned `§` or the brass rule. Commit all of Batch C: `docs: design language after the beauty redesign — retirements, beacon, StageDots`.

## Batch D — Gates + PR + merge + RELEASE (controller)

- [ ] `npm run typecheck`; `npx vitest run` full (only the pre-existing ~33 harness errors); final grep trio from B9 repeated on the whole diff.
- [ ] Final code reviewer over the whole branch → READY.
- [ ] Push `worktree-direct-beauty-4:direct-beauty-4`, PR base main, merge (user-authorized).
- [ ] **Release (explicitly user-authorized):** from the MAIN checkout `/Users/jonathan/TYPEFY/octopus/octopus-sh`: `git pull` and VERIFY `git log origin/main -1` == local HEAD (release-merge-verify memory: a failed ff ships a no-op version); then `npm run release`. Watch for the tauri dist-embed cache gotcha if a verification build is involved (wipe `src-tauri/target/release/bundle/` + `touch src-tauri/src/lib.rs` before any verification build).
