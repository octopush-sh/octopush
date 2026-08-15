# Run mode · terminal navigation — three arrangements

**Status:** design exploration, awaiting a decision. Nothing shipped.
**Live mockups:** [`../mockups/2026-08-15-run-terminal-navigation.html`](../mockups/2026-08-15-run-terminal-navigation.html) — open in a browser; all four states (Today · A · B · C) are interactive.

---

## Why this came up

The mode switcher moved into its own band above the canvas (`ModeBand`) and the Companion
went floor-to-ceiling, flush to the window edge. Both changes made the Companion read as a
*column of the app* rather than a card beside the canvas — and made it obvious that the
per-mode lists it hosts are not all the same kind of thing. Talk's chats and Direct's runs
are archives you pick from. Run's terminals are the room you are standing in.

## Current state (audited)

| Piece | What it does today |
|---|---|
| `CompanionTerminals.tsx` | Eyebrow bar (`TERMINALS` + `＋`) over a vertical list: status dot (brass running / mute stopped), serif label, `↺ Restored` badge, hover-revealed `✕`. Double-click renames inline. |
| `terminalsStore.ts` | `TerminalState { id, label, position, running, busy, restored }` per workspace + `activeByWs`. All mutations already IPC-backed and generation-guarded. |
| `App.tsx` Run panel | Mounts a `TerminalPane` for **every** `(workspace, terminal)` pair; only the active one is `visible`. PTYs survive everything. |
| `ModeBand` tail | Reads `"N terminals"` from `modeMetaLabel`. |
| Keyboard | `⌘⌥1..9` selects the Nth terminal of the active workspace. Nothing else. |
| `attentionStore` | Flags **per workspace** (`kind: "terminal"`), pulsing the Run segment of the mode switcher. |

### Findings

1. **Collapsing the Companion deletes terminal navigation.** The list is the only pointing
   device; collapse leaves only the undiscoverable `⌘⌥N`.
2. **The switcher is at the opposite edge from the output** it steers.
3. **262px for four short words.** Terminal names are `main` / `dev` / `tests`.
4. **`TerminalState.busy` is tracked and never rendered here.** The daemon's foreground
   signal (`pty://foreground`) drives the workspace rail's marching bar but not the panel —
   a running `npm run dev` and an idle shell look identical in the list.
5. **A bell identifies the workspace, not the terminal.** `attentionStore.ping(wsId, kind)`
   has no terminal id, so with three sessions you learn only that *something* rang.
6. **Run's Companion is thin.** Talk's carries history + context + savings + logbook;
   Run's carries a four-row list — and that list is the least suitable thing to fill it with.

## The three arrangements

### A · Session rail — 44px, canvas-left, always present

Numbered cells in the grammar of `WorkspaceRail` (and `HunkRail`). The number **is** the
`⌘⌥N` shortcut, so the rail teaches the keyboard path by existing. State lives in the cell's
own reserved edge slot: brass when active, `.rail-bar-running` marching segments while a
command runs, one brass dot when the session rang while hidden (beacon law: only the
longest-waiting). Hover/focus opens a `.octo-menu-enter` flyout with label, cwd, pid,
uptime, running command, rename and close.

*Reuses:* rail cell + identity edge · `.rail-bar-running` · menu-enter popover · `beacon.ts`.
*New:* `SessionRail.tsx`; `CompanionTerminals` becomes a session inspector; terminal id on
attention flags.

### B · Session ribbon — 32px, above the terminal

`EditorTabs` grammar extended to Run: brass 2px underline on the active chip, brass-faint
fill, `1 · main` with a state dot, marching underline while busy, hover `✕`, drag-reorder,
double-click rename (unchanged gesture). Overflow scrolls with the `RunFlowNav` chevrons.

*Reuses:* `EditorTabs` chip geometry + drag-reorder · `RunFlowNav` overflow · existing rename.
*New:* `SessionRibbon.tsx`; same Companion and attention changes as A.

### C · Anchor & switcher — zero standing chrome

The band's status tail stops reporting and starts controlling: `2/3 · dev · npm run dev`
with a live state dot and an `N waiting` fragment when another session rang. Click it or
press `⌘⌥K` for the switcher — the `CommandPalette` pattern scoped to sessions: search,
state, cwd, last command, `↑↓`/`⏎`, `⌫` closes. `⌘⌥←/→` cycles without opening anything.
Canvas is 100% terminal; the Companion defaults collapsed in Run.

*Reuses:* `CommandPalette` + `ModalShell align="top"` · the band's tail slot.
*New:* `SessionSwitcher.tsx`; the tail slot becomes a control slot.

## Comparison

| | Today | A · Rail | B · Ribbon | C · Switcher |
|---|---|---|---|---|
| Survives a collapsed Companion | no | yes | yes | yes |
| Names visible without hover | yes | hover | yes | active only |
| Pixels taken from the terminal | 262 wide | 44 wide | 32 tall | 0 |
| Distance output → control | far right | adjacent | adjacent | band |
| Holds ten sessions | scrolls | yes | scrolls | yes |
| Teaches the keyboard path | no | numbers *are* the shortcut | numbers shown | hint on the anchor |
| Distinctly Octopush | neutral | rail grammar | generic tabs | opinionated |

## Recommendation

**Ship A, and take C's switcher with it.** The rail is the only arrangement that is both
always-present and native to this app's grammar — the workspace rail's sibling, one level
down — and it costs the terminal no rows. Its single weakness is hidden names, which is
exactly what `⌘⌥K` answers. B is the safe answer and the fastest to build, but it spends
terminal height forever on a problem a hover solves, and it makes Run mode look like every
other terminal app.

Independent of the layout choice, three fixes stand on their own:

1. Render `TerminalState.busy` wherever a session appears — the store already has it.
2. Carry a terminal id on `attentionStore` flags so a bell points at one session.
3. Keep every capability (rename, close, restore badge) — relocate it to a Companion
   session inspector, don't drop it.

Design-system notes: no new tokens, no new motion primitives, no fourth font. The one rule
worth naming explicitly is §7's "no new tab system" — A and C sidestep it by reusing rail
and palette grammar; B is defensible only as an *extension of `EditorTabs`*, not as a new
tab paradigm. Whichever wins, `docs/FEATURES.md` is part of the change.
