# Sessions side by side (Run, then Talk)

**Issue:** #488
**Status:** approved by the owner on 2026-11-03 (his answers are on #488)

## Owner decisions

1. **Panes.** One to four sessions on screen. The user can open a second, third or fourth; four is a 2×2 grid.
2. **Narrow windows.** The layout stacks automatically when side by side would give a pane fewer than 72 columns. The user's override is remembered.
3. **Companion.** It folds to its 56px strip while more than one pane is on screen. It comes back when the view returns to one pane.
4. **Talk.** Talk's seat uses the same sessions (the same PTYs) as Run. The per-thread `$` shell stays separate.

## Problem

Run shows one session at a time. `terminalsStore.activeByWs` holds a single id per workspace, and every other `TerminalPane` is mounted with `display:none`. When an agent runs in one terminal and the user types in another, the user has to switch back and forth. Talk is worse: "Run in terminal" switches mode.

Every PTY is already mounted and alive. Putting more of them on screen costs a refit, not a spawn.

## Slots and layout

Run's view is an ordered list of **slots**: `slots: (terminalId | null)[]`, length 1 to 4. A `null` slot is an **empty seat**. Positions are fixed per count; **reading order** is the slot index, which is also the order for `⌘[`/`⌘]` and for "next slot".

| Count | Side by side | Stacked | Notes |
|---|---|---|---|
| 1 | Full canvas | Full canvas | Today's view. |
| 2 | 0 Left · 1 Right | 0 Top · 1 Bottom | |
| 3 | 0 Large left · 1 Top right · 2 Bottom right | 0 Large top · 1 Bottom left · 2 Bottom right | |
| 4 | 0 TL · 1 TR · 2 BL · 3 BR | Same as side by side | No orientation choice at 4. |

**Large pane.** For three panes, slot 0 is the large pane. It holds whatever session it held when the third pane opened. **Focus never moves sessions between slots.** Only *Swap with…* does.

**Changing the count.**
- **Adding.** A new slot is appended at the end: 2→3 keeps 0 and 1 and adds 2; 3→4 adds 3.
- **Removing a slot.** The slots after it shift down by one: removing 1 from [A,B,C,D] gives [A,C,D]. Positions are then laid out again for the new count.

**Orientation.**
- `orientation` (`"auto" | "side" | "stacked"`) applies to two and three panes. Four panes are always a 2×2 grid.
- With `auto`, the view is side by side when every column of panes is at least 72 columns wide. Columns are counted at the current font size, using the narrowest pane in the row. Otherwise the view stacks.
- *Stack* / *Side by side* in the caption menu sets the override per workspace. It applies to both two and three panes until the user picks *Automatic* again.
- At 4 panes below 72 columns, the 2×2 grid stays. The user can maximize a pane or leave the view; the 72-column rule is not applied at 4.

**Dividers.**
- `ratios` holds one fraction per divider:
  - 2 panes: `[split]`.
  - 3 panes: `[mainSplit, sideSplit]`. The main divider sits between the large pane and the pair; the side divider sits between the two small panes.
  - 4 panes: `[colSplit, rowSplit]`. This is a single shared cross: the vertical line is shared by both rows, and the horizontal line is shared by both columns.
- Fractions are clamped to 0.2–0.8.
- Pointer: drag a divider to resize.
- Keyboard: a focused divider moves 5% per arrow key, and 1% with ⇧. Double-click evens the panes.
- Accessibility: `aria-label` "Resize the panes"; `title` "Drag to resize · Double-click to even".
- Dividers are 1px `--color-octo-border` hairlines. There is no new top-level chrome. Captions exist only while two or more panes are on screen, and each holds one session, so this is not a tab strip.

## Interaction

**Open beside** (`⌘D`, the flyout item, or `⌥⏎` in `⌘⌥K`) opens the switcher in pairing mode. Its serif placeholder reads *Which session sits beside this one?*. The list leaves out sessions already on screen. Its last row is *Open a new session beside*.

- **Picking a session** puts it in the first empty seat if there is one. Otherwise it goes in a new slot appended at the end.
- **With four panes**, there is no new slot. The list's header line reads *Replaces the session in the focused pane*, and picking a session replaces it. The flyout item then reads **Replace in the focused pane**.
- **If every session is already on screen**, Open beside appends an **empty seat**:
  - eyebrow `BESIDE`;
  - serif line *Bring a session alongside.*;
  - ghost serif CTA *Open a new session here*;
  - clicking the seat opens the pairing switcher for it.
  
  At most one empty seat exists at a time.
- **`⌥⏎` in `⌘⌥K`** is handled before plain `Enter` in `SessionSwitcher.onKeyDown`. It means "open beside", not "switch".
- **Backspace on an empty query still deletes the selected session.** Pairing mode changes nothing about that. Leaving a pane is never bound to the switcher.

**One pane per session (invariant).**
- A session is in at most one Run slot.
- Picking or `setActive`-ing a session that is already on screen focuses its pane; nothing moves.
- `⌘⌥1-9` on a session that is on screen only focuses its pane.
- `⌘⌥←/→` cycle the focused pane through sessions **not** on screen.

The daemon has one client and one size per session, so this invariant must never break.

**Focus.**
- `⌘[` and `⌘]` move focus to the previous and next pane in reading order. A click also focuses a pane.
- The focused pane drives `⌘⌥1-9`, `⌘⌥←/→`, `⌘⌥K` and the Companion.

**Captions.** Each caption shows the session's `iconForSessionRole` icon and its label. There are no new glyphs.
- Focused caption: ivory with a `border-strong` underline.
- Other captions: mute.
- Every pane keeps full ink.
- Caption menu: *Swap with…* · *Stack* / *Side by side* / *Automatic* (two and three panes only) · *Leave the view*.
- `×` tooltip: *Leave the view · the session keeps running*.

**Leaving the view.** `×` or *Leave the view* removes that pane's slot. Leaving never kills a PTY. When one pane is left, the layout returns to today's view and the Companion is restored.

**Deleting a session that is on screen** removes its slot exactly as leaving does. `deleteTerminal`'s neighbour fallback must never pick a session that is already shown. If the deleted session was focused, focus moves to the next pane in reading order. With no pane left, it falls back to today's neighbour rule.

**Session rail.**
- Brass stays surgical. Only the focused session's rail edge is brass, as today.
- A session that is on screen but not focused gets a quiet **ivory 1px hairline** on its rail cell. This is not the sage edge, which keeps its meaning: a command is running in an unwatched session. A shown session is watched, so it never gets the sage edge.
- `aria-selected` is true only on the focused session's cell. Shown cells add `aria-current="true"`.

**Companion.**
- While Run has more than one pane, the Companion folds to its 56px strip. The strip's tooltip reads *Folded to make room for the panes · ⌘\\*.
- `⌘\` while folded brings the Companion back **over** the panes, without resizing them, and keeps it there until the next fold.
- Returning to one pane restores the user's latest explicit Companion choice. If they toggled it while paired, that toggle wins.
- Talk's seat folds the Companion the same way. The context meter stays on the folded strip.

**Talk.**
- A `SquareTerminal` icon in the Talk canvas toggles one seat beside the chat column. Its tooltip reads *Open a terminal beside the conversation · ⌘D*. Picking the session uses the same pairing switcher.
- **Focus in the seat is separate from Run's focus.** Focusing Talk's seat never changes `activeByWs` or Run's focused slot.
- **The same session in two places:** a session may sit in Run's grid and in Talk's seat, because only one mode is ever visible. On a mode change, the PTY is resized once, to the visible pane.

## Shortcuts

| Keys | Scope | Action |
|---|---|---|
| `⌘D` (match `e.code` `KeyD`) | One `global` entry that branches on `mode()` | In Run, open beside. In Talk, toggle the seat. Elsewhere, return false. |
| `⌘[` / `⌘]` (match `codes: ["BracketLeft","BracketRight"]`) | Run | Focus the previous / next pane |
| `⌥⏎` inside `⌘⌥K` | Switcher | Open the selected session beside |

- **⌘D and editors.** `⌘D` is "next occurrence" in the Editor and Scratchpad. CodeMirror calls `preventDefault` first, and the global dispatcher skips handled keys, so a focused editor keeps `⌘D`. That precedence is intended.
- **No backslash or Option chords.** These shortcuts avoid both, so ISO and Spanish layouts behave the same. `⌘⌥[`/`⌘⌥]` stay the editor's fold keys.
- **Docs.** Appendix C of FEATURES.md is updated in every user-visible PR below.

## Architecture

- **`TerminalHost`.** A single always-mounted layer at canvas level, a sibling of the mode overlays. It renders every `TerminalPane`; the panes move out of the Run overlay in `App.tsx`.
  - Run's grid and Talk's seat render `TerminalSlot` placeholders.
  - Each placeholder measures itself with a ResizeObserver and publishes its rect to `terminalSlotsStore`.
  - The host positions each shown pane at its slot's rect. Panes are never re-parented, so there is no remount, no replay and no redraw flash.
- **Hidden overlays still measure.** Mode overlays stay mounted and are gated by opacity, so a hidden mode's slots still report real rects. The host uses **only the active mode's slots**. A pane with no slot in the active mode stays `display:none`.
- **Mode crossfades.** The host follows the active overlay's opacity transition, so a terminal never appears abruptly.
- **`terminalLayoutStore`.** Per workspace, with pure tested reducers: `openBeside`, `leave`, `assign`, `swap`, `focus`, `setOrientation`, `setRatios`, `prune`.
  - Run state: `{ slots, orientation, ratios, focused }`.
  - Talk state: `{ terminalId, width, open }`.
  - The store is in memory until PR 5 adds persistence. PR 5 also prunes deleted ids on load and on `deleteTerminal`.
- **Single source of truth.**
  - `terminalLayoutStore`'s Run `focused` slot is authoritative.
  - `activeByWs` is derived from it.
  - Every existing writer — `createTerminal`, `trackSetup`, the refresh fallback and `deleteTerminal` — goes through one `setActive(id)`. If the session is on screen, `setActive` focuses its pane. Otherwise it puts the session in the focused pane.
- **`TerminalPane`.** The single `visible` prop becomes two, `shown` and `focused`.
  - Only the focused pane takes keyboard focus and OSC 52 clipboard writes.
  - Bell and attention pings are suppressed for any pane that is shown.
- **Resize storms.** While a divider is being dragged, panes refit on animation frames. `resizeSession` (SIGWINCH) is sent only on pointer-up. Opening or closing a pane triggers one refit at `transitionend`.
- **Performance.** Today's DOM renderer handles four shown panes. If WebGL is added later, it should load only for shown panes (WebKit caps contexts at about 16).

## Motion

- Widths and heights change over `--dur-standard` with `--ease-octo`.
- A new pane's content uses `.octo-fade-in`, and its caption uses `.octo-rise-in`.
- Stacked changes use the grid-rows `0fr↔1fr` idiom.
- A session swap uses `<FadeSwap>`.
- On a focus change, the caption ink transitions over the standard duration.
- With reduced motion, every size change is instant and every fade is off.

## PR plan (each under 800 lines)

Every PR with a user-visible change updates FEATURES.md and Appendix C, and adds a changeset.

| PR | Content |
|---|---|
| 1 | `terminalLayoutStore` (in memory) with reducers and tests; the single `setActive` path; `TerminalPane` `shown`/`focused`; fit suspension. No visible change. |
| 2 | `TerminalHost`, the slot registry and following the crossfade. Behaviour matches one pane exactly; no visible change. |
| 3a | Two panes in Run: the split, divider, captions, focus by click and `⌘[`/`⌘]`, rail markers, and the Companion fold. *Swap with…* and *Leave the view*. Opened from the flyout item. |
| 3b | The pairing switcher (`⌘D`, `⌥⏎` in `⌘⌥K`), empty seats, deleting a session that is on screen. |
| 4 | Three and four panes: slot positions, orientation `auto`/override, ratios, the 2×2 cross. |
| 5 | The Talk seat; persistence and pruning for Run and Talk; `RunEmptyState` copy ("You can keep several sessions open, switch from the rail, or open them side by side."). |

## Out of scope (later)

- Dragging a rail cell onto the canvas.
- "Run in terminal" typing into an idle shell in the seat.
- The scratchpad in a seat.
- Retiring `CompanionSession`.
- More than one Talk seat.
