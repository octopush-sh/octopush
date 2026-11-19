# Run mode and rail groups: one home per fact, a tighter shell

**Status:** approved by the owner on 2026-11-18, in the PM chat.
**Ships as:** eight small PRs (see "Implementation plan"). PR 1 shipped the shell spacing and recorded this design. PR 5, the groups' data layer (storage, commands, IPC and store, with no rail UI), shipped first, in #909. PRs 2 and 3, the pane caption and the session line, shipped together; where they differ from this document is listed in `docs/design-system.md` ("Run mode — session navigation"). PR 4 (Run's Companion), PR 6 (mission groups in the rail) and PR 7 (project groups in the rail) have shipped too; where the groups differ from this document is listed in `docs/design-system.md` ("Rail groups") and under "Notes from the code" below. Only PR 8 (groups in ⌘K, Mission Control and the archived modal, the **Move to group** shortcut, multi-select) is still **planned**: until it merges, the code behaves as `docs/FEATURES.md` describes.

The approved mockup isn't checked in, because it was built from private screenshots. This document is the record. Its examples use made-up names (`acme-api`, "Vulnerability fixes", "PR reviews").

## The problem

Four things hurt in Run mode and in the rail:

| # | What hurts | Why |
|---|---|---|
| 1 | The rail is one long list (think 7 projects and 30 missions) | Nothing says "these five missions are one batch of fixes" or "these three projects are one client". A monogram belongs to one workspace, so related work can't be seen at a glance. |
| 2 | The 44px session rail left of the Run canvas | A column of near-identical glyphs (most sessions are agents, so most icons are `Sparkles`). It costs 45px on every Run screen and needs a hover flyout to say anything. |
| 3 | A session's name, rename, close and "open beside" appear in three or four places | The rail flyout, the mode band's anchor, the Companion's Session card and the split-view caption each render the same facts. No place is the obvious one, and four renderings of one fact can drift apart. |
| 4 | Gaps between the header, the canvas and the Companion | `<main>` was inset 16px on each side, the ContextHeader had 16px above and below, the mode band 12px below and the canvas 16px at its foot: about 60px of vertical air before the first terminal line. |

## Research conclusions

- **Folders beat tags for personal organisation.** In Bergman et al.'s studies (Gmail, 75 users; Windows 7, 23 users) people strongly preferred folders for storing and for retrieving. When they did tag, they mostly used one tag per item, and retrieval by tag was slower and less successful. A tag model's extra power goes unused and makes finding things worse. <https://metatoc.com/papers/23068-folder-versus-tag-preference-in-personal-information-management>. Related: <https://www.ideals.illinois.edu/items/16664>, <https://concepts.dsebastien.net/concept/folder-and-tag-challenges/>
- **Colour labels alone hold about seven categories.** Finder tags have seven fixed colours, which works up to seven categories and fails quickly beyond that. <https://eclecticlight.co/2023/11/04/are-finder-tags-useful-metadata/>. Colour also can't be the only carrier of meaning (WCAG 1.4.1): <https://www.w3.org/WAI/WCAG21/Understanding/use-of-color>
- **Browser tab groups are the closest analogue and the most widely learned.** A group has a title, a colour from a fixed set and a collapsed flag. It sits inline in the strip, and collapsing it leaves the name. <https://developer.chrome.com/docs/extensions/reference/api/tabGroups.md.txt>, <https://support.google.com/chrome/answer/10483214>
- **Arc Spaces** are colour-coded contexts you switch between, each hiding the others. <https://www.howtogeek.com/888738/ways-arc-transforms-your-web-browser-experience/>, <https://techcrunch.com/2023/10/27/startup-browser-maker-arc-now-lets-you-share-spaces-folders-and-split-views-with-non-arc-users/>. Hiding the rest is wrong for Octopush: the rail's single beacon has to see every workspace.
- **VS Code multi-root workspaces** group folders into a saved file you open as a unit. <https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces>. That is a heavy, file-backed concept, and it changes what is open instead of how things are found.
- **Linear project labels** come in label groups and drive filters and views. <https://linear.app/changelog/2025-06-12-project-labels>, <https://linear.app/docs/custom-views>. A saved view is invisible until opened, and similarity to Linear is a negative signal (`CLAUDE.md`).
- **Terminals.** VS Code puts terminals in a tab list plus split groups (<https://code.visualstudio.com/docs/terminal/basics>). tmux keeps a one-line window list with numbers and no sidebar (<https://github.com/tmux/tmux/wiki/Getting-Started>). The tmux line is the closer fit: compact, numbered, in chrome that already exists.

**Principle drawn from this:** one container per item (a folder), a name that is always present (never colour alone), a palette-bound colour as a secondary cue, inline in the existing list (not a separate mode), and foldable.

---

## Part 1: Rail groups

A **group** is a named, optionally tinted, foldable run of items in the rail. The UI word is "group". One concept works at two scopes:

- A **project group** sits at the rail's top level and holds projects (a client, say, with `acme-api`, `acme-web` and `acme-admin`).
- A **mission group** sits inside one project and holds some of that project's missions ("Vulnerability fixes", "Teammates' tickets", "PR reviews").

Rules:

- **One membership per item**, like a folder.
- **No nesting** beyond the rail's hierarchy: project group, project, mission group, mission.
- **A group is a standing bucket.** It survives being emptied and is removed only on request. A bucket such as "PR reviews" empties every week; deleting it then would make the user rebuild it.
- **No cross-project mission groups.** A mission group lives in one project. A batch that spans repos is a project group of those repos.

### Four levels, one signature per level

| Level | Signature | Details |
|---|---|---|
| **Project group** (a section) | A hairline above, then a **caps eyebrow** | 26px. Mono 9px caps, tracking 0.25em, mute: the idiom of the rail's "Recently closed" footer and the Companion's section eyebrows. Its projects are **not** indented. A fold chevron shows on hover, on focus and while folded. Folded meta: `N projects` plus the attention dot. |
| **Project** | Hexagon + serif name | Unchanged. The hexagon takes its section's tint when the project has no tint of its own. |
| **Mission group** (a folder) | **Chevron + mono label**, then an **indented run with a guide** | Header 28px: a chevron that is always visible, in the monogram column, in the group's tint; the name in mono 11px, normal case, sage. Members are indented **14px**. A **1px guide** in the group's tint at 50% opacity runs from under the chevron to the last member and stops there. Folded meta: member count, PR glyph, attention dot. An empty group reads `empty` in mute. |
| **Mission** | Monogram + sans name | Unchanged, including its own tint. |

```
ACME                              project group: hairline + caps eyebrow
  acme-api                        project: hexagon + serif name, not indented
  M  main
  R  refactor-auth
  v  Vulnerability fixes          mission group: chevron + mono label
  |    J  fix-json-parser-cve     members: indented 14px beside a 1px guide
  |    N  fix-netty-codec-cve
  |    S  bump-framework-3-4      the guide stops at the last member
  v  Teammates' tickets
  |    A  test-ticket-388
  |    M  test-ticket-401
  R  monthly-report               a loose mission: back at the outer alignment
  >  PR reviews            3      folded: count, PR glyph, attention dot
```

Why this reads at a glance:

- **Each cue means one thing.** A hairline with an eyebrow always means "a section of projects". Indentation with a guide always means "these missions are one group". Nothing else in the rail uses either.
- **A group's end is visible.** The guide stops and the next row returns to the outer alignment, so a loose mission after a group can't be read as a member.
- **The chevron is always there.** It is the standard sign for "this holds things and folds".
- **Colour is a small secondary cue.** The name carries the meaning (WCAG 1.4.1).

### The tint rule

- A group's tint is drawn on **its own two marks only**: its chevron and its guide line.
- **Monograms are never recoloured.** A mission's monogram keeps its own glyph and tint, so rail rule 3 ("the glyph is the one carrier of the tint") holds as written.
- A project's hexagon may take its section's tint, and only when the project has none of its own.
- The palette is the seven existing `TINTS` in `src/lib/monogram.ts` (brass, verdigris, rouge, indigo, lavender, smoke, bone) plus **None**. No new hues. Brass is allowed but is not the default: a brass header would compete with the active row.
- No ticket ids or other chips are added to rows. The rail's "no chips" rule stands.

### Placement

A group sits where its first member sat, and ungrouped items keep their place around it, as browser tab groups do. For a user with no groups nothing changes. Projects have `sort_order` and drag, so a project group drags as one unit. Missions are ordered by `created_at`, so a mission group takes the position of its earliest member. There is no "Ungrouped" header: ungrouped items are simply the plain rows.

### Interactions

| Task | How |
|---|---|
| Create | Right-click a mission, **Move to group › New group…**. The header appears in place with its name in edit mode (`New group`, selected). Enter commits, Esc keeps `New group`. The project's own menu has **New group**, which makes an empty one. Projects work the same way. |
| Rename | Double-click the header, F2, or the header menu's **Rename**. Inline input with Enter, Esc and blur: the same contract as session rename. |
| Tint | Header menu: **Tint** swatches (the seven `TINTS` plus **None**). |
| Move in or out | Context menu **Move to group ›** lists the groups in that scope (the current one checked), **New group…** and **Remove from group**. Drag and drop: drop on a header to append, or between members to place. Only same-scope moves: a mission can't leave its project. |
| Fold | Click the header or its name (the one tab stop, `aria-expanded`). ←/→ fold and unfold a focused header, as in a tree. Grid-rows `0fr↔1fr`, 280ms. Persisted to localStorage like `railProjectCollapsed`. A live filter unfolds everything without touching the stored state. |
| Ungroup | Header menu **Ungroup (keeps the missions)**. Members return in place. A toast offers **Undo**. |
| Empty | The group stays, reads `empty`, and still accepts drops and **Move to group**. Its header menu offers **Remove group**. |
| New mission in a group | The header shows `+` on hover and focus ("New mission in this group"), like the project line's `+`. |
| Archived | An archived mission keeps its group. Restoring it returns it to the group if the group still exists, otherwise to the plain rows. The Archived workspaces modal shows the group name as meta. |

Not in the first ship of groups: ⌘-click multi-select with **Group N missions…**, ⌥-drag to create, and groups in ⌘K and Mission Control. They come in the last PR.

### Collapsed rail (44px)

The guide line stays: a 1px tinted line beside the group's monograms, with 6px of air above and below. The header is a 12px tinted chevron whose tooltip is the group's name; clicking it folds the group. The flyout eyebrow becomes `project · group`.

### Attention, folding and running

- **The beacon walks up to the nearest visible ancestor.** If the longest-waiting flagged workspace is inside a folded group, the **group header** carries the beacon. Inside a folded project, the project line carries it. `resolveAttention()` gains that one step. Other flagged items keep their static dots. There is still exactly one beacon.
- **Folds compose.** A folded project hides its groups. A folded group in an open project shows its aggregates. Rail rule 4 holds: a count visible in the list is never repeated in a header.
- **State stays on rows.** A folded group with a running member shows no marching edge; the edge is per row.

### Search, ⌘K, Mission Control and keyboard

- **Rail filter:** matches group names too. A group hit keeps all its members, the same rule as a project hit. The placeholder becomes "Find a project, group or mission".
- **⌘K:** a **Groups** section, "Go to group <name>". It unfolds the group, scrolls it into view and focuses its header.
- **Mission Control:** the card's workspace atom becomes `group · workspace` (mute, the group truncating first). No filter chips, no new bands. Triage stays fleet-wide.
- **Keyboard:** ⌥⌘G is **Move to group…** on the focused or selected rail rows, opening the same menu with type-ahead. ⇧F10 or the context-menu key opens a row's or a header's menu.

### One concept at both levels

In the data and the interactions, yes: one table holds both scopes, and create, rename, tint, fold and move work the same way. In the looks, deliberately no: a project group is drawn as a section and a mission group as a folder, so the two levels can't be confused.

### Alternatives rejected

| Option | Why not |
|---|---|
| Tags (many per item) | Users prefer folders and retrieve worse with tags. Many tags per row means chips, which the rail forbids. Filtering by tag is a hidden mode. |
| Colour labels only | About seven categories, nameless, and fails WCAG 1.4.1. Kept as the group's secondary cue. |
| Spaces you switch between | Switching hides the others, which breaks the single beacon and adds top-level chrome. |
| Saved views or smart filters | Invisible until opened, extra chrome. |
| Section dividers without fold | No collapse, which is half the value. |
| Nested groups | Folder trees cost more than they give at rail scale. |

---

## Part 2: The session line in the mode band

The 44px session rail (`SessionRail`) is deleted. Switching moves to the **mode band's right track**, which today holds the session anchor and is otherwise empty. This is the tmux pattern: a compact, numbered line in chrome that already exists. It is visible in every Companion state, which was the reason navigation left the Companion in the first place.

### Anatomy

One **24px icon cell per session**, in session order, showing the role icon from the existing vocabulary (`iconForSessionRole`). To their right: `+` (new session), a hairline, and the **layout button**.

### Cell states: one glyph, at most two facts

| What you see | Meaning |
|---|---|
| Icon in mute | The session is off screen |
| Icon in ivory | The session is shown in a pane |
| 2px underline | The session is the focused pane's, or it is busy, or both (see below) |
| Static 5px brass dot | It rang, or it waits on you, while off screen (the existing per-session marker) |

**Focus is the underline's colour; busy is its motion.** These are two independent channels:

- solid brass: focused and idle. This is the only brass in the line besides the attention dot;
- marching sage (the `.rail-bar-running` idiom laid horizontally): busy and not focused;
- marching brass: focused and busy.

This **changes the state-colour rule**. The icon's colour now carries **presence** (mute or ivory) and never state, so five busy sessions put no brass on screen. That is "no status in brass" (design-system section 7) applied to the session icons.

Holding ⌥ flips the icons to their `⌘⌥N` numbers (the existing `useModifierPeek`).

### The instant label

Hovering a cell, or focusing it from the keyboard, shows a label under the icon with **no delay**: the session's name in sans, then `doing · ⌘⌥N` in mono. It is text only, with no actions. A native `title` takes about a second, which is too slow to tell six near-identical icons apart.

### Overflow and narrow windows

- With more than 8 sessions, the 8th cell becomes `+N` and opens ⌘⌥K.
- When the track can't fit the icons, they collapse **from the left** into one `N sessions` button that opens ⌘⌥K.
- The floor: the focused session's icon, `+` and the layout button never collapse.

### The layout button

Its icon shows the current layout. It opens a `.octo-menu-enter` menu: **One pane · Two, side by side · Two, stacked · Three · Four**, the current one checked, `⌘D` hinted on Two.

- Picking a larger layout fills the new seats with the next sessions not on screen, in session order. When none are left it leaves an empty `BESIDE` seat.
- Picking a smaller layout drops the trailing panes. Leaving a pane never closes its session.
- It composes the existing `RunPanes` operations (Open beside, Leave the view, the orientation override). The 72-column **Automatic** rule stays the default when no orientation was chosen.
- The orientation items move here, out of the caption menu.

### Interactions

| Gesture | Result |
|---|---|
| Click a cell | If that session is on screen, focus its pane. Otherwise it replaces the focused pane's session (today's rule). |
| ⌥-click a cell | Open beside: appends a pane, up to 4. At 4 it replaces the focused pane. |
| Drag a cell | Reorder the sessions. |
| ⌘⌥1–9, ⌘⌥←/→, ⌘[ / ⌘], ⌘⌥K, ⌘D | Unchanged. ⌘⌥K is still the full list, with close on ⌫. |

### Alternatives rejected

| Option | Why not |
|---|---|
| A tab bar above the canvas | "Don't bring back tabs." Four panes would mean four tab bars. |
| Keep the rail and auto-hide it | An undiscoverable hover reveal. |
| Back into the Companion | Collapsing the Companion would remove switching. |
| ⌘⌥K only | A keyboard-only switcher is a switcher nobody finds. |
| Session dots in the status bar | The status bar is app-scoped and quiet. Sessions belong to the workspace's canvas. |

---

## Part 3: The pane caption is the session's one home

Every pane has its caption, **even when it is alone**. The caption is the existing `PaneCaption`, kept permanently, and it becomes the one place a session's facts and actions live.

| Fact or action | Its one home | Removed from |
|---|---|---|
| Session name | Pane caption | Band anchor, rail flyout, Companion card |
| Rename | Caption: double-click the name, or ⋯ **Rename** | Companion pencil and double-click, flyout **Rename** |
| What it's doing, its command | Caption: mono meta after the name, in a fixed slot (S1) | Companion DOING and COMMAND, the band anchor |
| State (busy, idle, waiting) | The session line's underline or dot, plus the caption suffix (`waiting on your input`, the existing copy) | Companion STATE, the anchor's suffix |
| Jump number `⌘⌥N` | Caption hint (focused or hovered) and the ⌥ peek in the session line | Companion JUMP, flyout hint |
| Open beside | ⌥-click a session cell, caption ⋯ **Open beside…**, ⌘D | Rail flyout item |
| Swap, leave | Caption ⋯ (**Swap with…**, **Leave the view**) | — |
| Orientation, pane count | The layout button | The caption menu |
| Close the session | Caption ⋯ **Close session…** (rouge hover, a toast with Undo). ⌘⌥K with ⌫ stays the keyboard path. | Companion ×, rail flyout **Close** |
| Restored badge | Caption, popping in for about 5s | Companion card |
| N/M position | Dropped: the session line shows it | Companion card |

**The ⋯ menu:** Rename · Open beside… (⌘D) · Swap with… (split only) · Leave the view (split only) · Close session….

**No × on a pane.** In a split view the caption has a **minus** (lucide `Minus`), titled "Leave the view · the session keeps running". × reads as "close" everywhere else, and a session that looks closed while its agent keeps running and spending is the worst outcome here. Closing lives only in the ⋯ menu, with a toast and Undo.

---

## Part 4: The Companion grammar, and Run's three sections

**The grammar, for every mode:**

1. **The Companion never repeats the canvas.** It shows what surrounds the work on the canvas.
2. **It follows the focus.**
3. **A section that doesn't apply is not drawn.** When a section has no meaning for the focused thing (a context meter for a plain shell), it folds away (grid-rows); nothing is invented to fill it. A section that applies but is empty keeps its one calm line ("The working tree is clean.", "No runs yet").

| Mode | Canvas | The Companion answers |
|---|---|---|
| Talk | The conversation | Which chats; how full the context is and what it cost (exists) |
| Review | The diff | How the change was built; where the branch stands (exists) |
| Direct | The run | The runs and the logbook (exists) |
| **Run** | **Terminals** | **How much room and money the focused agent has used; what the sessions changed; which mission this serves (new)** |

Talk, Review and Direct already work this way. Run was the one mode with no content of its own: its Session card repeated the canvas. `CompanionSession` is deleted, and Run's Companion gets three sections, top to bottom.

### 1. Context

Follows the focused pane, and exists only for an agent session.

- The context meter (`148k / 1M`), a 2px brass bar. Warning tone past 80% with the line "Past 80% · /compact soon"; rouge past 95%. It is the meter Talk's Conversation section uses.
- `Spent`: this session's cost from the ledger. `Cached`: the share of prompt tokens served from the cache. `Model`.
- The eyebrow names the session it describes, which matters when more than one pane is on screen.
- Focus a dev server, a log tail or a plain shell and the section folds away.

Why it earns its place: it says when to compact or clear before the agent degrades, and what the session has cost. No terminal shows that.

### 2. Changes

The workspace's uncommitted files, live.

- One row per file: status letter, path (truncated from the left, so the file name survives), `+added −removed`. Up to 8 rows, then `+N more`.
- Clicking a row opens Review at that file. The upright-serif phrase **Read the diff** opens Review.
- Clean tree: one mute line, "The working tree is clean.", plus "N commits ahead of main" when there are any.

Why: it answers "what is it doing to my code?" while the terminal scrolls, and it is the handoff from Run to Review. The header's `3 unstaged` gives the count; this gives the list.

### 3. Mission

Intent, ticket and its status, time worked today, spend today: the existing mission line and Logbook teaser from Talk's Companion, reused.

### Considered and left out

- **A list of the workspace's sessions.** That is the redundancy Part 3 removes.
- **A "needs you" card for waiting sessions.** The session line's dot and the pane caption already say it.
- **Branch and PR status.** The ContextHeader carries both.

The Companion keeps whatever fold state the user last left it in.

---

## Part 5: Shell spacing

The gaps are on the 4px scale; the header's block padding is 6px.

| Gap | Before | Now |
|---|---|---|
| `<main>` inline inset (rail to header and canvas, canvas to Companion) | 16 | **8** |
| Above the ContextHeader | 16 | **8** |
| ContextHeader to mode band | 16 | **8** |
| Mode band to canvas | 12 | **8** |
| Canvas foot | 16 | **8** |
| ContextHeader padding (inline / block) | 16 / 8 | **12 / 6** |
| Header name line | serif 15 | unchanged |
| Rail's internal spacing | 12px between projects | unchanged |

Three layout tokens carry the gaps, in `src/styles.css` and mirrored as `shell` in `src/lib/tokens.ts`:

| Token | Value | Governs |
|---|---|---|
| `--shell-gutter` | 8px | `<main>`'s inset from the rail and from the Companion |
| `--shell-stack` | 8px | Above the ContextHeader, header to mode band, mode band to canvas |
| `--shell-foot` | 8px | The canvas column's bottom padding, above the status bar |

**What it gives, measured at 1280×800 in every mode, with the rail and the Companion open or folded:** the canvas is 16px wider and 32px taller (28px from the gaps and 4px from the header's padding).

**What the whole redesign gives in Run:** removing the 44px session rail and its hairline returns another 45px, so **61px of width** in total. In height, a lone pane keeps its 32px caption, which uses exactly the 32px the gaps gave back: a single pane's terminal area ends as tall as it was, and a split view (which already had captions) is 32px taller. The spacing still reads tighter with one pane, because the pixels moved from empty gaps into a useful caption.

---

## Implementation plan

Small PRs, each shippable alone. Each updates `docs/FEATURES.md`, adds a `whats-new` changeset when user-visible, and runs `npm run typecheck` and the Vitest suite. Run ships first (PRs 1 to 4), groups after (PRs 6 to 8). PR 5 already shipped (#909), because it had no dependency on the others.

| PR | Scope | Files and components | Data |
|---|---|---|---|
| 1 | **Shell spacing tokens; this spec; the design-system record** | `src/styles.css`, `src/lib/tokens.ts`, `App.tsx`, `ContextHeader.tsx`, `ModeBand.tsx`, `docs/design-system.md` | — |
| 2 (shipped, with PR 3) | Caption on every pane; the caption as the session's home | `run/RunPanes.tsx` (`PaneCaption`: always rendered, doing meta, `⌘⌥N` hint, ⋯ menu with Rename, Open beside and Close, the Restored badge, minus for Leave the view), `terminalsStore` (rename and close reused) | — |
| 3 (shipped, with PR 2) | The session line in the band | New `run/SessionLine.tsx` (from `SessionRail`'s logic: roving tabindex, ⌥ peek, bell dot, waits), replacing `SessionAnchor` in `App.tsx`'s `modeMeta`; the layout button and its menu (`RunPanes` layout operations, `terminalLayoutStore`); delete `SessionRail.tsx`, `SessionAnchor.tsx` and their tests; update the tour's `data-tour` ids | A command to reorder sessions, for drag (see the notes below) |
| 4 (shipped) | Run's Companion: Context · Changes · Mission | Delete `CompanionSession.tsx`. New `CompanionRun.tsx` built from `CompanionSection`: the context meter from `CompanionContext` fed by the focused session, a compact changes list from the workspace's git status (the data `ChangesPanel` uses), the existing mission line | A read-only command for one session's context size and ledger total, if the existing queries don't give it |
| 5 (shipped, #909) | Groups: data and IPC | `db.rs` migration, `commands.rs` and `lib.rs` (`list_groups`, `set_group_order`, `create_group`, `rename_group`, `set_group_tint`, `delete_group`, `set_item_group`), `types.ts`, `ipc.ts`, new `stores/groupsStore.ts`. Runs `cargo test`. | New `groups(id TEXT PK, scope TEXT CHECK IN ('project','workspace'), project_id TEXT NULL REFERENCES projects ON DELETE CASCADE, name TEXT NOT NULL, tint TEXT NULL, sort_order INTEGER, created_at TEXT)`; `ALTER TABLE projects ADD COLUMN group_id TEXT NULL`; `ALTER TABLE workspaces ADD COLUMN group_id TEXT NULL` (set NULL when the group is deleted; an emptied group stays until `delete_group`) |
| 6 (shipped) | Groups: mission groups in the rail | `WorkspaceRail.tsx` (a project's rows become rows or a `MissionGroup`: folder header, indented run with its guide, fold persisted under `railGroupCollapsed`, the ancestor step in `resolveAttention`, the filter matching group names), `WorkspaceContextMenu.tsx` (**Move to group ›**), new `GroupContextMenu.tsx`, drag onto a header | — |
| 7 (shipped) | Groups: project groups | `WorkspaceRail.tsx` top level, `ProjectContextMenu.tsx`, `ProjectMark` tint inheritance, dnd-kit unit drag, `CollapsedRail` sub-clusters and flyout eyebrow | — |
| 8 | Groups everywhere else | `CommandPalette.tsx` (Groups section), `MissionControl.tsx` (`group · workspace` atom), `ArchivedWorkspacesModal.tsx` (group meta), ⌥⌘G in `useGlobalShortcuts.ts`, rail multi-select with **Group N missions…** | — |

No new colours, fonts, glyphs or motion primitives. Everything reuses `TINTS`, `.rail-bar-running`, `.octo-menu-enter`, `.octo-rise-in`, `<Reveal>` and `<FadeSwap>`.

### Notes from the code, for the PRs that follow

- **`⌥⌘G` is taken.** The editor and the scratchpad use it for "go to line". PR 8 must pick another shortcut for **Move to group…**, or bind it only while the rail has focus.
- **The session line needs a horizontal marching variant.** `.rail-bar-running` is vertical only, so PR 3 adds a horizontal form of the same idiom to `src/styles.css` and documents it. That is a variant of an existing primitive, not a new one.
- **Rail rules 1 and 3 need rewording when the rail UI ships** (PR 6): a group's hairline and tinted guide are new marks beside the rows, so "nothing else in the rail carries a border" and "nothing else on the row is coloured" must name them.
- **The mission and project context menus have no keyboard path** (found while building PR 6; true before groups too). They open on right-click only: a rail row and a project line answer neither ⇧F10 nor the context-menu key. Until they do, **Move to group** and **New group** cannot be reached from the keyboard for a mission or a project; only a group header's own menu can (⇧F10, the context-menu key, F2). Follow-up, not in PR 6: give rail rows and project lines the same two keys, opening the menu at the row. PR 8's keyboard **Move to group…** shortcut depends on it or replaces it. *PR 7:* project lines now answer both keys (the menu opens at the line and gives it the focus back); mission rows still don't.

Checked against `main` on 2026-11-18. These are implementation facts, not design changes; where one touches the design, the PR that meets it says so before building.

- **The caption is 32px** (`h-8`), and the gaps give back 32px, which is why a lone pane ends level (PR 2).
- **The Companion still folds to its strip while Run shows more than one pane** (the 2026-11-03 decision, `docs/superpowers/specs/2026-11-03-run-session-pair-design.md`). This design doesn't change that. `⌘\` brings it back over the panes, and that is when the Context eyebrow's session name matters (PR 4).
- **Sessions have a stored order (`terminals.position`) but no command changes it.** Dragging a cell needs one. PR 3 shipped without drag; it is a follow-up.
- **Claude Code spend is attributed by working directory**, to the most recently active Run session opened on it (`src-tauri/src/transcripts.rs`). Two agent sessions in one workspace share a directory, so `Spent` and the context meter can't yet be told apart per session. PR 4 settles this before it promises per-session numbers. *Settled in PR 4:* the ledger keys a transcript's rows by Claude Code's own session id (`cc:<session id>`) unless a legacy RUN session sits on the same root, so one conversation's rows can be told apart; what was missing was which Run terminal runs which Claude Code session. Claude Code's hooks say so (the terminal id in the hook's environment, the session id in its payload): Octopush now also installs `SessionStart` and `SessionEnd`, and the hook poller keeps one current session per terminal (`terminal_claude_session`). Context is drawn only for that session, and not at all where the hooks don't run; the ingestor's attribution is unchanged. Details: `docs/FEATURES.md`, "Session usage (`get_session_usage`)".
- **Projects sort pinned first, then by `sort_order`.** PR 7 has to say where a pinned project sits relative to its group. *Settled in PR 7:* a pinned project **stays in its group**. The rail's project order is not touched (pinned first, then the manual order), and "a group sits where its first member sat" is applied to it as written: the pinned project leads its group, and the group comes up into the pinned run with it. Pinning takes no project out of its group and moves no other group. The two alternatives were turned down: lifting the pinned project out of its group (it would be drawn outside the container the menu says it is in), and pinning only inside the group (the group's own place would then need an order the rail does not have for a pinned project, and "Pin to top" would stop meaning the top). The data layer already assumed this rule: `create_group` places a new project group by the pinned-first order.
- **What PR 7 built that this document did not spell out** (the record is `docs/design-system.md`, "The project group, as built"). (1) *Where a section ends:* a project group has no guide, so a loose project that comes right after a group takes a closing hairline; without it that project would read as a member. (2) *Between project groups their own `sort_order` is not a law*, unlike mission groups: projects have a manual order, so a group's place follows its projects, and `sort_order` only orders the empty groups, which stand last. (3) *"New group" in a project's menu* (changed on purpose, after the owner tried the beta): this document gave the project's menu a **New group** that makes an empty mission group and said "projects work the same way". From a project, "New group" read as "a group for this project", and the empty mission group it made could not take projects. So in a project's menu the group action is now **Move to group ›**, about project groups, and its **New group…** makes a group that already holds that project, with the name in edit. The mission-group action stays in that menu as **New mission group**, with the project's missions and a block away. A group made from an item never starts empty; an empty project group only comes from emptying one. (4) *Collapsed rail:* a project group is a sub-cluster between two hairlines that span the rail; it has no header control there, so it neither folds nor opens its menu at 44px, and the flyout eyebrow reads `project group · project · mission group`, outermost first. (5) *Dragging out:* a project leaves its group when dropped on a loose project or on the ungrouped area under the rail's last block, so it can be dragged out even when every project is in a group. (6) *Keyboard:* the project line now answers ⇧F10 and the context-menu key (the gap noted above, closed for project lines only), and a project group's menu has **Move up** / **Move down**, since a group has no keyboard drag.
- **`⌘T` is shown as the hint for New session** in the command palette. PR 3 checked: no key is bound to it, so the `+` button's tooltip names no shortcut.
- **The collapsed workspace rail is specified as "the Run session rail"** (design-system section 8, rail rule 7, and the layout table). PR 3 rewords both when the session rail goes; the collapsed rail's own geometry doesn't change.
- **Tour anchors** `run-session-rail`, `run-session-cell`, `run-open-beside` and `run-session-waiting` live in `SessionRail.tsx`, and released changesets may point at them. PR 3 moves or retires them with `node scripts/whats-new.mjs check` green.

## Decisions

- The UI word is **group**.
- A group's tint colours its chevron and guide, never the monograms.
- Empty groups stay until removed.
- Picking a larger layout fills the new panes with the next sessions not on screen.
- Run's Companion shows Context, Changes and Mission, and keeps the fold state the user left it in.
- Leaving a split view is a minus; a pane never has ×.

Left open at approval:

1. **Batches that span repos.** A mission group lives in one project; across repos the answer here is a project group. A cross-project mission group would need its own design.
2. **Order of work.** The plan ships Run first and the rail UI for groups after. The owner can swap them.
