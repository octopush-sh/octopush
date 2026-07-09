# Mission Control — design decision record (2026-07-09)

> The fleet cockpit: every active Direct run, across all workspaces, as a live
> crew card in one full-screen room. THE surface no competitor can show —
> N transparent agent crews shipping in parallel on isolated branches.
> Synthesized from a three-lens brainstorm (spectacle / operator / minimalism).

## Decisions

1. **Placement — a full-screen "room", replacing the RunsTray popover.**
   The tray indicator (top bar) stays as the glanceable chip; clicking it now
   opens Mission Control. The old `MenuSurface` popover is deleted (§9: one
   canonical chrome per concept — both listed active runs with jump/stop).
   Full-screen is sanctioned by the Settings precedent: a *transient room* for
   an **app-scoped** concern (the fleet is cross-workspace by definition, so it
   cannot live in Canvas/Companion). Adds zero standing chrome.

2. **Triage bands, not a feed.** Three bands with eyebrow headers + counts:
   - **Needs you** — `paused` runs (in this engine, paused *always* means a
     human must act: gate, halted stage, budget park, director pause).
   - **In flight** — `running`.
   - **Settled** — runs that reached `completed`/`aborted` **this session**;
     they linger (verdigris/mute) until dismissed. Nothing that finishes while
     you're away silently vanishes.
   FIFO within a band; cards move **only on discrete state transitions** (the
   reshuffling-board trap: attention changes color in place first, position
   second). Needs-you cards carry the brass border + calm pulse — the same
   "needs the human" convention as an awaiting stage card.

3. **Crew card = 6 fixed rows (S1), reusing the Direct vocabulary:**
   status glyph+word + time-in-state (tabular) · workspace serif + branch mono ·
   task line · **micro-track** (`I✓ ⟶ II✓ ⟜ III●` — numerals + status colors +
   ⟶/⟜ connectors) · **live ticker** (the running stage's `§ TOOL hint` line,
   updating in place — the viral pixel; verdict/error/savings in other states) ·
   ledger foot (spent brass · saved verdigris) with hover-revealed actions.

4. **No DecisionBar on the card.** Approving a gate without the artifact/diff
   is rubber-stamping. Card click = jump to the workspace's Direct canvas
   (closes the room). On-card actions only: **abort** (two-step confirm) and
   **dismiss** (settled). Everything deeper resolves to the jump.

5. **Ceremony:** one `.octo-sweep` across a card's ledger foot when it settles
   as completed (reuses the sanctioned Direct completion moment). Nothing else
   on the screen moves except the tickers updating in place.

6. **Header:** eyebrow `MISSION CONTROL` · band counts (state colors, tabular) ·
   fleet ledger right, savings-first (`saved $X · Y% under all-premium ·
   spent $Z`) over the visible cards · quiet `Plus` dispatch action · ESC·CLOSE.

7. **Tray chip states:** active > 0 → brass `Activity {n} run(s)` (unchanged);
   0 active but settled undismissed → verdigris `✓ {n} done` (the entry no
   longer disappears the moment your work finishes); else hidden.

8. **Entries:** tray chip click · `⌘⇧M` · empty state: *"The floor is quiet."*
   with the ceremonial CTA *"Send out a crew"* (→ Direct mode, current ws).

9. **Free tier:** the room works with 1 run (no nagging upsell inside the
   room); starting a 2nd crew hits the existing `runs.parallel` gate → upgrade
   sheet. The room itself is the aspiration.

## Reuse map
`runsStore` (all data; new session-local settled/statusSince tracking) ·
`runStatusMeta`/`stageStatusGlyph`/`isTransientHalt` · `lastActivity` (extracted
from RunFlow to `lib/liveLine.ts`) · `useElapsed` · `ROMAN`/`stageTitle` ·
Settings room shell (extracted to `primitives/OverlayRoom.tsx`) · motion
primitives (`octo-rise-in`, `octo-stage-pulse`, `octo-sweep`, `octo-tabular`).
Zero new IPC.

## Non-goals (v1)
Checkpoint resolution on-card · launching runs from the room (beyond the
dispatch jump) · history (HistorySheet owns the past) · logs/artifacts ·
filtering/sorting controls · keyboard j/k traversal.
