# Sessions side by side: the Pair and the grid (Run, then Talk)

**Issue:** #488
**Status:** approved by the owner on 2026-11-03 (answers on #488)

## Owner decisions

1. **Panes:** one to four sessions on screen. Open a second, a third or a fourth; four is a 2×2 grid.
2. **Narrow windows:** the layout stacks on its own when side by side would give a pane fewer than 72 columns. The user's override is remembered.
3. **Companion:** it folds to its 56px strip while more than one pane is on screen, and its earlier state comes back when the view returns to one pane.
4. **Talk:** Talk's seat uses the same sessions (the same PTYs) as Run. The per-thread `$` shell stays separate.

## Problem

Run shows one session at a time. `terminalsStore.activeByWs` holds a single id per workspace, and every other `TerminalPane` is mounted with `display:none`. Working with an agent in one terminal and typing by hand in another means switching all the time. Talk is worse: "Run in terminal" switches mode.

All PTYs are already mounted and alive, so putting more on screen costs no spawn. It costs only a refit.

## Layout

| Panes | Side by side (each pane ≥ 72 cols) | Narrow window |
|---|---|---|
| 1 | Today's view | Today's view |
| 2 | Two columns | Two rows |
| 3 | One large pane and two stacked (the focused session takes the large pane) | Three rows |
| 4 | 2×2 grid | 2×2 grid |

```
1440  WS rail │ sessions │ ⌁ claude · agent   ⌘⌥1 ┊ › main · shell   ⌘⌥2 │ C (folded, 56px)
              │  ▌1      │ (Claude Code TUI)        ┊ $ npm test             │
              │   2      │                          ┊                        │
```

Panes are separated by 1px `--color-octo-border` hairlines. Each divider can be dragged: the pointer resizes, and arrow keys resize when the divider is focused. Double-clicking a divider evens the panes.

There is no new top-level chrome. Captions exist only while two or more panes are on screen, and each caption holds one session, so this is not a tab strip.

## Interaction

- **Open beside:**
  - **Where:** the session-rail flyout item **Open beside**, `⌘⌥\` (the switcher in pairing mode, with the serif placeholder *Which session sits beside this one?*), or `⌥⏎` on a row in `⌘⌥K`.
  - **The new pane** goes beside the focused pane. When three or four panes are open it fills the next slot in the grid.
  - **When the grid is full**, Open beside replaces the focused pane's session. The switcher row says so.
- **Empty seat:** the eyebrow reads `BESIDE`, the serif line reads *Bring a session alongside.*, and a ghost serif CTA reads *Open a new session here*.
- **One session per pane:** a session sits in at most one pane. Picking a session that is already on screen focuses its pane.
- **Focus:**
  - `⌘⌥[` and `⌘⌥]` move focus between panes in reading order. A click also focuses a pane.
  - The focused pane drives `⌘⌥1-9`, `⌘⌥←/→`, `⌘⌥K` and the Companion. `⌘⌥←/→` cycles only the focused pane and skips sessions already on screen.
- **Focus indication (brass stays surgical):** only the focused session's rail edge is brass. Sessions that are on screen but not focused get the existing sage rail edge. The focused caption is ivory with a `border-strong` underline; other captions are mute. Every pane keeps full ink.
- **Caption menu:** *Swap with…*, *Stack · Side by side*, *Leave the view*. The caption `×` has the tooltip *Leave the view · the session keeps running*.
- **Leaving:** `×`, the caption menu or `⌘⌥\` with an empty switcher query removes a pane. Leaving never kills a PTY. With one pane left, the view returns to today's layout and the Companion is restored.
- **Talk:**
  - A `SquareTerminal` icon in the Talk canvas (tooltip *Open a terminal beside the conversation · ⌘⌥\*) seats one session beside the chat column. MVP: one session in Talk.
  - The Talk overlay has spare width; the chat column is capped at 768px.

## Architecture

- **`TerminalHost`:** one always-mounted layer at canvas level, a sibling of the mode overlays. It renders every `TerminalPane`, which moves out of the Run overlay in `App.tsx`.
  - Run's grid and Talk's seat render `TerminalSlot` placeholders. Each slot measures itself with a ResizeObserver and publishes its rect to `terminalSlotsStore`.
  - The host positions each shown pane at its slot's rect. Panes are never re-parented, so there is no remount, no scrollback replay and no redraw flash.
  - A pane with no slot in the active mode stays `display:none`.
- **`terminalLayoutStore`:** persisted per workspace, with pure tested reducers: `openBeside`, `leave`, `assign`, `swap`, `focus`, `setOrientation`, `setRatios`, `prune`.
  - Run state: `{ slots: terminalId[1..4], orientation, ratios, focused }`.
  - Talk state: `{ terminalId, width, open }`.
  - Deleted ids are pruned on load and on `deleteTerminal`.
- **`TerminalPane`:** the single `visible` prop becomes two, `shown` and `focused`.
  - Only the focused pane takes keyboard focus and OSC 52 clipboard writes.
  - Bell and attention pings are suppressed for any shown pane.
  - `activeByWs` becomes "the focused pane's session", so existing consumers keep working.
- **Daemon:** the PTY daemon has one client and one size per session. The one-pane-per-session rule above keeps that invariant; it must never be broken.
- **Resize storms:** while a divider is dragged, panes refit on animation frames and `resizeSession` (SIGWINCH) is sent only on pointer-up. On open and close, panes refit once at `transitionend`.
- **Performance:** today's DOM renderer handles four panes on screen. If WebGL is added later, load it only for shown panes (WebKit caps contexts at about 16).

## Motion

- **Sizes:** widths and heights change over `--dur-standard` with `--ease-octo`.
- **New pane:** its content enters with `.octo-fade-in` and its caption with `.octo-rise-in`.
- **Stacked changes:** they use the grid-rows `0fr↔1fr` idiom.
- **Session swap:** a pane swaps its session with `<FadeSwap>`.
- **Focus:** caption ink transitions over the standard duration.
- **Reduced motion:** every size change is instant and every fade is off.

## Shortcuts

| Keys | Action |
|---|---|
| `⌘⌥\` | Open beside / pairing switcher (match on `e.code` `Backslash`) |
| `⌘⌥[` and `⌘⌥]` | Focus previous / next pane |
| `⌥⏎` in `⌘⌥K` | Open the selected session beside |

All three are Run-scoped. In Talk, `⌘⌥\` toggles the seat. Appendix C of FEATURES.md is updated in the same PRs.

## PR plan (each under 800 lines)

| PR | Content |
|---|---|
| 1 | `terminalLayoutStore` and its reducers (tests); `TerminalPane` `shown`/`focused`; fit suspension |
| 2 | `TerminalHost` and the slot registry; one-pane parity, no visible change |
| 3 | Run with two panes: dividers, captions, rail markers, shortcuts, Companion fold, FEATURES.md, Appendix C, changeset |
| 4 | Run with three and four panes: the grid layout and the narrow-window rules |
| 5 | Talk seat, persistence, `RunEmptyState` copy |

## Out of scope (later)

- Dragging a rail cell onto the canvas.
- "Run in terminal" typing into an idle shell in the seat.
- The scratchpad in a seat.
- Retiring `CompanionSession`.
