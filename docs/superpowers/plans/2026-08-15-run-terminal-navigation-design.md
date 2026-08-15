# Run mode · terminal navigation — three arrangements

**Status:** **shipped** — the session rail (A) plus the `⌘⌥K` switcher (C), with the icon layer below.
Implemented in `components/run/{SessionRail,SessionSwitcher,SessionAnchor}.tsx`, `CompanionSession.tsx`,
`lib/sessionRole.ts`, `roleIcons.iconForSessionRole`, `terminalsStore` (`role`/`command`),
`attentionStore` (per-terminal flags), `ModeSwitcher` (mode icons), and the daemon's `foreground`
event (`{id, busy, command?}`). `docs/FEATURES.md` carries the feature entries.
**Live mockups:** [`../mockups/2026-08-15-run-terminal-navigation.html`](../mockups/2026-08-15-run-terminal-navigation.html) — open in a browser. Four interactive states (Today · the chosen rail + switcher · B · C), a mode-band style toggle (words · icons + words · icons), and bell/build simulation. Hold ⌥ or ⌘ to see the rail's number peek.

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

## Decision

**A + C: the session rail ships, and takes the switcher with it.** The rail is the only arrangement that is both
always-present and native to this app's grammar — the workspace rail's sibling, one level
down — and it costs the terminal no rows. Its single weakness is hidden names, which is
exactly what `⌘⌥K` answers. B is the safe answer and the fastest to build, but it spends
terminal height forever on a problem a hover solves, and it makes Run mode look like every
other terminal app.

The band anchor comes along for one reason: a keyboard-only switcher is a switcher nobody
finds. The tail already existed and already talked about terminals; turning it into
`⌘⌥K · dev · npm run dev` makes the palette discoverable by mouse and names the shortcut in
passing, without adding new chrome. With the rail on screen the anchor drops the redundant
parts (count, idle state) and shows only identity, a running command, and any waiting session.

Independent of the layout choice, three fixes stand on their own:

1. Render `TerminalState.busy` wherever a session appears — the store already has it.
2. Carry a terminal id on `attentionStore` flags so a bell points at one session.
3. Keep every capability (rename, close, restore badge) — relocate it to a Companion
   session inspector, don't drop it.

Design-system notes: no new tokens, no new motion primitives, no fourth font. The one rule
worth naming explicitly is §7's "no new tab system" — A and C sidestep it by reusing rail
and palette grammar. `docs/FEATURES.md` is part of the change.

---

## The icon layer

Two separate questions, and conflating them is the usual icon mistake.

### 1 · Mode icons — because "Run" is a word, and words carry culture

`Run` reads as *execute something* to one developer and *where my shells are* to another. The
fix is an icon on **all four** segments (icon-only on Run would read as a special case, not a
mode), keeping the labels — mode navigation is where a wrong guess costs the most, so it is not
where we spend a tooltip.

| Mode | lucide | Why |
|---|---|---|
| Run | `SquareTerminal` | A window with a prompt inside — the room, not the verb |
| Talk | `MessageSquare` | Conversation, unmistakable at 13px |
| Review | `GitCompare` | Two branches meeting — the diff, not a generic eye |
| Direct | `Waypoints` | The pipeline's own shape: nodes on a track |

13px, stroke 1.75, colour inherited from the segment (brass active, mute otherwise) — the pill's
geometry is unchanged. The mockup ships a toggle (words · icons + words · icons) to compare.

**Considered and rejected:** renaming Run to "Terminal". It clarifies one segment at the cost of
the set — Talk / Run / Review / Direct are four things you *do*, and one noun among three verbs
reads as an accident.

### 2 · Session icons — only if they encode difference

A terminal glyph on every rail cell says "this is a terminal" four times over. The session icon
therefore answers the one question the label cannot: **what is running in there right now.**

| Role | lucide | Recognised from |
|---|---|---|
| Shell at the prompt | `ChevronRight` | foreground pgroup is the shell itself |
| Dev server | `Globe` | vite · next · serve · `npm run dev` · *watch |
| Building | `Hammer` | cargo build · tsc · make · vite build |
| Test run | `FlaskConical` | vitest · jest · cargo test · pytest |
| Installing packages | `Package` | npm · pnpm · yarn · cargo add · pip |
| Git | `GitBranch` | git |
| Agent CLI | `Sparkles` | claude · codex (the substrates Direct already knows) |
| Editor · TUI | `PenLine` | vim · nvim · htop · lazygit |
| Unclassified | `Terminal` | anything else — the honest fallback |

Three rules govern it:

1. **The icon is the identity; the number is the address.** A 32px cell holds one glyph well and
   two badly, so the rail shows the icon at rest and flips every cell to its `⌘⌥N` number while
   ⌥/⌘ is held. Nothing lives only behind that gesture — the number stays permanently visible in
   the flyout, the Companion inspector and the switcher.
2. **Roles are sticky.** The icon follows the last *significant* foreground command, not the
   instantaneous one; a dev server that finishes a rebuild is still the dev server (S1).
3. **One glyph, two facts.** The icon carries identity, its colour carries state — verdigris idle,
   brass while busy or ringing. No icon-plus-status-dot pairs; brass stays surgical.

### What this asked of the backend (implemented)

One bounded change. The daemon already resolves each session's foreground process group every
tick (`Session::check_attention` / `check_foreground` take the `tcgetpgrp` result and sample that
pid's CPU), but the `foreground` event only carried `{ sessionId, busy }`. It now carries
`{ sessionId, busy, command? }`.

The lookup returns **argv**, not just the executable name: every JS toolchain reports its leader as
`node`, so the exec name alone cannot tell a dev server from a test run. `KERN_PROCARGS2` on macOS,
`/proc/<pid>/cmdline` on Linux, summarised to basename + up to two args capped at 96 chars
(`session.rs::foreground_command` / `parse_procargs2` / `summarise_argv`, the two parsers unit-tested).
Resolved once per busy transition, never per tick; omitted from the wire when the platform can't
answer, which the frontend treats as "unknown role", never as an error. Classification lives in the
frontend as the pure, unit-tested `lib/sessionRole.ts`. No new IPC command, no new table, no polling.

**Deliberately not in v1:** user-assigned icons or emoji per session. The label already carries
user intent; a picker is a preference to maintain and a decoration when unused. If auto
classification proves ambiguous in daily use, the override belongs in the flyout — added later,
against real evidence.
