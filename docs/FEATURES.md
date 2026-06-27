# Octopush — Feature Map

> **This file is the single source of truth for everything Octopush can do and how it does it.**
>
> **Maintenance mandate (binding):** Any change that adds, removes, or meaningfully alters a user-facing feature **must** update this document in the same change. A PR that ships a feature without updating `docs/FEATURES.md` is incomplete. Keep it exhaustive — down to the smallest context-menu item, toggle, keyboard shortcut, and empty state. When you add a new surface, add its features here; when you delete one, delete its entry. This rule is also recorded in `CLAUDE.md` / `AGENTS.md`.
>
> _Conventions:_ each feature is one bullet — **Name** — what it does (user-facing). _Support:_ the files / Tauri commands / Zustand stores / mechanism that implement it. _Entry:_ how the user reaches or triggers it. File paths are relative to the repo root; symbol names are durable, occasional line numbers are approximate hints only.

**Octopush** is "The IDE for Agentic Developers — eight arms, zero wasted tokens." It is a Tauri 2 desktop app (macOS-first) with a React 19 + TypeScript frontend and a Rust backend. Workspaces are git worktrees. Its visual identity is **Atelier in Onyx & Brass** (see `docs/design-system.md`).

---

## Architecture at a glance

- **Frontend** (`src/`) — React 19 + TypeScript, Tailwind v4 (`@theme` tokens in `src/styles.css`), state in **Zustand** stores (`src/stores/`), all IPC funneled through `src/lib/ipc.ts` (`invoke` from `@tauri-apps/api/core`). CodeMirror 6 editor, xterm.js terminals, React Flow pipeline builder, Recharts usage charts.
- **Backend** (`src-tauri/src/`) — Rust. Tauri commands in `commands.rs` (registered in `lib.rs`'s invoke handler, ~190 commands), state in `state.rs`, SQLite data layer in `db.rs`, errors via `error.rs` (`Result<T, AppError>`). Domain modules: `chat_engine`, `orchestrator/*` (Direct mode), `git_ops`/`git_lock`/`github`, `providers/*`/`provider_router`, `token_engine`, `issue_tracker/*` (Jira), `mcp/*` + `mcp_setup`, `pty_*`/`talk_shell`, `theme`, `settings`, `perf`, `skills`, `context_guard`.
- **Two bundled sidecar binaries** (same crate, separate `[[bin]]`):
  - **`octopush-pty-server`** — an out-of-process PTY daemon that owns all pseudo-terminals so shells survive app restarts/updates (`src-tauri/src/bin/octopush-pty-server/*`).
  - **`octopush-mcp`** — a read-and-author MCP server that exposes Octopush's pipelines/projects/workspaces/runs to external CLIs over stdio (`src-tauri/src/bin/octopush-mcp/*`).
- **Three primary modes** per workspace — **Talk** (AI chat), **Run** (terminals) / **Direct** (multi-agent pipeline orchestration), **Review** (diff, editor, AI review). A right-hand **Companion** panel adapts to the mode; a left **Workspace Rail** lists projects → workspaces.
- **Data locations** — SQLite at `~/Library/Application Support/octopush/octopush.db`; settings/keys/themes/providers under `~/.octopush/` (`settings.json`, `providers.json`, `theme.json`); PTY daemon socket/pid/logs and scrollback under `~/.octopush/`. **Local-first, no telemetry** — outbound traffic only to configured AI providers and to integrations the user enables (Jira, GitHub).

---

## Table of contents

1. [Application Shell, Modes & Navigation](#1-application-shell-modes--navigation)
2. [Projects & Workspaces](#2-projects--workspaces)
3. [TALK Mode (AI Chat)](#3-talk-mode-ai-chat)
4. [RUN / Direct Mode (Pipeline Orchestration)](#4-run--direct-mode-pipeline-orchestration)
5. [REVIEW Mode (Diff, Editor & AI Review)](#5-review-mode-diff-editor--ai-review)
6. [Git & GitHub](#6-git--github)
7. [Terminals, PTY Daemon & Sessions](#7-terminals-pty-daemon--sessions)
8. [Providers, Models, Tokens, Budgets & Usage](#8-providers-models-tokens-budgets--usage)
9. [Integrations: Jira, MCP & Skills](#9-integrations-jira-mcp--skills)
10. [Settings, Theming, Updates & Platform](#10-settings-theming-updates--platform)
- [Appendix A — Backend command index](#appendix-a--backend-command-index)
- [Appendix B — Data model (SQLite)](#appendix-b--data-model-sqlite)
- [Appendix C — Keyboard shortcuts](#appendix-c--keyboard-shortcuts)
- [Appendix D — Processes & on-disk locations](#appendix-d--processes--on-disk-locations)

---

## 1. Application Shell, Modes & Navigation

### App shell layout & structure
- **Vertical app frame** — The shell stacks `AppTopBar` (28px chrome) → main row (Rail · main · Companion) → `PerfMonitorBar` (footer), all `h-screen w-screen bg-octo-bg`. _Support:_ `src/App.tsx`. _Entry:_ always present once a project is open.
- **Unified header band + content row** — `<main>` renders a full-width `ContextHeader` band, then a content row holding the canvas (left) and Companion (right) flush beneath it. _Support:_ `src/App.tsx`. _Entry:_ automatic when an active workspace exists.
- **Always-mounted canvas (PTY survival)** — The left canvas column is never gated on `activeWorkspace`; empty-project/creator layers overlay it instead, so running terminals across projects keep their PTYs and xterm scrollback. _Support:_ `src/App.tsx`; `allTerminalRefs` flattens every `(workspace, terminal)` pair so all `TerminalPane`s mount simultaneously. _Entry:_ structural.
- **macOS traffic-light reservation + window drag** — Top bar reserves 78px for overlaid traffic lights and is a `data-tauri-drag-region`, so the window drags from any empty area. _Support:_ `src/components/AppTopBar.tsx`. _Entry:_ the top chrome bar.

### Three-mode (four-mode) workspace system
- **Mode model** — Four modes exist: `talk | run | review | direct`; display order is `["run","talk","review","direct"]`. Labels: Talk/Run/Review/Direct. _Support:_ `src/lib/modes.ts` (`WorkspaceMode`, `MODES`, `MODE_LABELS`, `MODE_SHORTCUTS`). _Entry:_ ModeSwitcher / shortcuts.
- **Per-workspace mode memory** — Each workspace remembers its own active mode (`modePerWorkspace`), defaulting to `talk`. Switching workspaces restores that workspace's last mode. _Support:_ `src/App.tsx`. _Entry:_ automatic.
- **Talk mode** — Conversational agent chat for the active workspace (`ChatView`); can open files in the editor and hand a command to Run. _Support:_ `src/App.tsx`. _Entry:_ Talk tab / ⌘⇧1.
- **Run mode** — Terminal surface; all PTYs mounted, only the active workspace's active terminal is visible; shows a "Start a new terminal." empty state when the workspace has zero terminals. _Support:_ `src/App.tsx` `RunEmptyState`. _Entry:_ Run tab / ⌘⇧2.
- **Review mode** — Three-pane review: `ReviewSidebar` (Changes+Files navigator) · `ReviewCanvas` (Diff/Editor toggle, hosts `EditorTabs`+`EditorPane`). Re-fetches git status/diff after commit/push/hunk actions. _Support:_ `src/App.tsx`. _Entry:_ Review tab / ⌘⇧3.
- **Direct mode** — Autonomous pipeline/run canvas (`DirectCanvas`), keyed by workspace id, seeded from `workspace.task` and `linkedIssueKey`. _Support:_ `src/App.tsx`. _Entry:_ Direct tab / ⌘⇧D.
- **ModeSwitcher (expanded, text)** — Content-width text buttons with a gliding+resizing brass-ghost indicator measured live from button geometry (ResizeObserver + window resize), 280ms ease; centered in the Companion header. _Support:_ `src/components/ModeSwitcher.tsx`. _Entry:_ Companion top bar.
- **Mode-tab attention pulse** — A Run/Talk tab pulses brass (`animate-attention-pulse`) when that workspace has a matching attention flag and the user is in a different mode; tooltip switches to "… needs your attention". _Support:_ `ModeSwitcher.tsx`; `attentionStore`. _Entry:_ automatic on background completions.
- **Mode-overlay crossfade** — Each mode canvas is an absolutely-positioned, opacity/visibility/pointer-events-gated overlay (200ms) so switching modes never unmounts the others. _Support:_ `src/components/ModeOverlay.tsx`. _Entry:_ structural.
- **Cross-mode "Run in terminal" hand-off** — From a Talk tool card, take a shell command to Run mode: switches mode and copies the command to the clipboard (deliberately not auto-executed). _Support:_ `src/App.tsx` `handleRunInTerminal`; toast "Command copied — paste into the terminal to run". _Entry:_ Talk chat tool action.

### ContextHeader (top header band)
- **Active-ticket header** — When a workspace resolves a Jira ticket (manual link wins, else branch-detected gated on project key + tracker configured), shows a `◈` brass diamond, the parent/grandparent ticket chain (clickable, opens in Jira), the ticket key (type-tinted), status name, and the summary in serif. _Support:_ `src/components/ContextHeader.tsx`; `useActiveIssue`, `parentIssuesStore`. _Entry:_ automatic header.
- **Degraded workspace header** — With no ticket, shows a "WORKSPACE" brass eyebrow + workspace name (animated on change). _Support:_ `ContextHeader.tsx`. _Entry:_ automatic.
- **Branch + base + unstaged indicator** — Right side shows a verdigris dot, `↳ branch`, optional "from <fromBranch>" (base-branch tooltip), and "· N unstaged" when changes exist. _Support:_ `ContextHeader.tsx`. _Entry:_ automatic.
- **PR chip** — Per-state pull-request chip (open ●/draft ◐/merged ✓/closed ✕) with `PR · #<number>` and ↗; click opens the PR URL in the system browser. _Support:_ `ContextHeader.tsx` `PR_STATE_STYLE`; `openPrByWs` cache fed by `findPrForBranch` polled every 60s. _Entry:_ click the chip.

### AppTopBar
- **Scratchpad toggle** — `NotebookPen` button toggles the scratchpad split. _Support:_ `AppTopBar.tsx`; `scratchpadStore.toggleOpen`. _Entry:_ top bar, right side.
- **Settings button** — `Settings` icon opens Settings on the General tab. _Support:_ `AppTopBar.tsx`. _Entry:_ top bar, right side.

### CanvasSplit (scratchpad split)
- **Resizable canvas/scratchpad split** — When the scratchpad is open, splits the canvas with a draggable divider (20–80% clamp); both columns stay in the DOM (display/width/visibility toggled, never conditionally unmounted) to avoid remounting terminals/duplicating input. 200ms width transition. _Support:_ `src/components/CanvasSplit.tsx`; `ScratchpadEditor`. _Entry:_ scratchpad toggle in top bar.

### Companion (right panel)
- **Always-mounted, resizable Companion** — Right panel persists width in `localStorage` (default 312, clamp 280–600); drag the 4px left-edge handle to resize, double-click to reset. _Support:_ `src/App.tsx`; `src/components/Companion.tsx`. _Entry:_ left-edge drag handle.
- **Collapse to slim strip** — Collapses to a 56px strip carrying only the mode switcher (icon form), persisted; expand/collapse buttons. _Support:_ `App.tsx`; `Companion.tsx`. _Entry:_ collapse button / expand button on the strip.
- **Collapsed-strip mode switcher + pulse** — Icon buttons (Run=SquareTerminal, Talk=MessagesSquare, Review=GitCompare, Direct=Workflow); active state brass-ghost; pulses the matching icon on background attention. _Support:_ `Companion.tsx`. _Entry:_ the slim strip.
- **Mode-specific content crossfade** — Below the shared header/Jira block, mode content crossfades via `FadeSwap` keyed on mode. _Support:_ `Companion.tsx`; `src/components/primitives/FadeSwap.tsx`. _Entry:_ mode switch.
- **Talk Companion** — `CompanionHistory` (chats) + `CompanionContext` (context meters) + `SavingsLedger`. **Run** — `CompanionTerminals`. **Review** — `CompanionReview`. **Direct** — `CompanionRuns`. _Support:_ `Companion.tsx`. _Entry:_ per mode.

### Companion · Chats (CompanionHistory)
- **Conversation thread list** — Lists persisted chat threads for the workspace; active thread highlighted with a reserved (non-shifting) left border; title + relative-time meta (ticks each minute). _Support:_ `src/components/CompanionHistory.tsx`; threads from `chatStore`. _Entry:_ Talk mode panel.
- **New / select / delete conversation** — `+` starts a new thread; row click switches active thread; hover/focus-revealed `X` deletes a thread. _Support:_ `CompanionHistory.tsx`; `chatStore.newThread/selectThread`, `App.handleDeleteChat`. _Entry:_ Chats eyebrow / rows.
- **Empty state** — "No active chats." when none. _Support:_ `CompanionHistory.tsx`.

### Companion · Context (CompanionContext)
- **Token-usage meter** — "tokens used / limit" plus a brass progress bar; numerator is the last assistant turn's `inputTokens`, denominator the active model's `maxContext` (default 200k). _Support:_ `src/components/CompanionContext.tsx`; `ipc.listModels`. _Entry:_ Talk Companion.
- **Unstaged & tool-call counters** — "unstaged" = changed-file count; "tool calls" = live count of `role:"tool"` messages in the active chat (ticks in real time). _Support:_ `CompanionContext.tsx`. _Entry:_ Talk Companion.
- **Spending rows** — Per-period (Today/Month) spend vs budget with a bar that turns warning/rouge at 80%/100%; workspace budget preferred over global; rendered only when a matching budget exists. _Support:_ `CompanionContext.tsx`; `budgetsStore`. _Entry:_ Talk Companion (when budgets set).

### Companion · Terminals (CompanionTerminals)
- **Terminal list with status dots** — Each row shows a brass(running)/mute(stopped) dot, label; active row highlighted. _Support:_ `src/components/CompanionTerminals.tsx`; `terminalsStore`. _Entry:_ Run Companion.
- **New / select / rename / close terminal** — `+` opens a terminal (auto-named); row click sets active; double-click the label to rename inline (Enter commit / Escape cancel / blur commit); hover/focus-revealed `X` deletes. _Support:_ `CompanionTerminals.tsx`; `createTerminal/renameTerminal/deleteTerminal`. _Entry:_ rows / eyebrow.
- **Restored badge** — "↺ Restored" pops in on rows whose PTY was reattached from a prior Octopush run; cleared ~5s later. _Support:_ `CompanionTerminals.tsx`; `terminalsStore`. _Entry:_ automatic on session restore.
- **Empty state** — "No active terminals." _Support:_ `CompanionTerminals.tsx`.

### Companion · Review cockpit (CompanionReview)
- **Readiness verdict** — One-line AI-free verdict from working-tree state: clean / "Resolve N conflicts first" (rouge) / "N staged · ready to commit" / "N changes to review", plus a file/+adds/−dels/staged summary. _Support:_ `src/components/CompanionReview.tsx`. _Entry:_ Review Companion.
- **Provenance ("How this change was built")** — Traces which agent turns shaped the changed files: "Shaped by N agent turns across M files"; each turn expandable to show its model + truncated message; file chips jump into the diff. States: tracing/loading, "likely hand-written", or the turn list. _Support:_ `CompanionReview.tsx`; `ipc.listFileEdits`, `ipc.getMessage`. _Entry:_ Review Companion.
- **Branch & publish** — Sync line: "Not published yet" / "Up to date with origin" / "↑ahead · ↓behind"; plus last commit short-SHA + subject. _Support:_ `CompanionReview.tsx`; `ipc.getLastCommit`. _Entry:_ Review Companion.

### Companion · Runs (CompanionRuns / CompanionCurrentRun)
- **Run list** — Lists Direct runs for the workspace with status glyph+word, cost, optional linked issue key; active/viewed run highlighted; stale-while-revalidate cache. _Support:_ `src/components/CompanionRuns.tsx`; `runsStore`, `runStatusMeta`. _Entry:_ Direct Companion.
- **Begin a new run** — `+` clears the viewed run to start fresh. _Support:_ `CompanionRuns.tsx`. _Entry:_ Runs eyebrow `+`.
- **Savings ledger line** — "saved $X across N runs" (only when ≥ $0.005). _Support:_ `CompanionRuns.tsx`; `aggregateSavings`. _Entry:_ Direct Companion.
- **Current-run summary** — For the viewed run: brass "current run" eyebrow + status, a glanceable per-stage colored dot strip, current stage title, cost + ↑in/↓out tokens. _Support:_ `src/components/CompanionCurrentRun.tsx`. _Entry:_ Direct Companion (run selected).
- **Empty state** — "No runs yet — direct your first." _Support:_ `CompanionRuns.tsx`.

### Companion · Work context (WorkContextPanel) & Elsewhere
- **Jira work-context panel** — Pill nav (Mine / Subtasks|Siblings / Blocking / Blocked by / Epic) with counts and a gliding brass indicator; rows show status dot, type-tinted key, summary, status name; click opens the ticket in Jira; right-click → backlog context menu. _Support:_ `src/components/WorkContextPanel.tsx`; `issueTrackerSelectors`; gated by tracker configured + resolvable project key. _Entry:_ top of Companion in any mode.
- **Per-project collapse (persisted)** — Chevron collapses the panel; choice persists per project (`companionPrefsStore`). _Support:_ `WorkContextPanel.tsx`. _Entry:_ chevron.
- **Refresh** — `RotateCcw` refreshes Mine/Epic lists. _Support:_ `WorkContextPanel.tsx`. _Entry:_ refresh button.
- **Workspace-jump chip** — Tickets already owned by a workspace (via link or branch) get a tint-colored dot that expands on hover into a named pill; click jumps to that workspace. _Support:_ `WorkContextPanel.tsx` `WorkspaceJumpChip`. _Entry:_ per-row chip.
- **Elsewhere footer + modal** — Footer "N tickets in-progress elsewhere" opens `ElsewhereModal` grouping those tickets by project prefix, each opening in Jira. _Support:_ `src/components/ElsewhereFooter.tsx`, `ElsewhereModal.tsx`. _Entry:_ Companion footer.

### Command palette (⌘K)
- **⌘K palette** — `cmdk`-based fuzzy command palette in a top-anchored `ModalShell`; ⌘K toggles, Esc closes. _Support:_ `src/components/CommandPalette.tsx`. _Entry:_ ⌘K.
- **Groups** — **Sessions** (New session ⌘T, Switch to <session>, Kill active); **Models** (Model: <name> hot-swaps the active session's agent); **Templates** (session templates → new-session flow); **Actions** (Check for updates, Open Settings · Usage ⌘⇧T, Set token budget, Export session JSON/CSV); **Editor** (toggle word wrap, font ±, cycle tab width, toggle line numbers, toggle blame); **Themes** (Theme: <name>). _Support:_ `CommandPalette.tsx`; `sessionStore`, `ipc.switchAgent`, `updaterStore`, `editorPrefsStore`, `blameStore`, `themeStore`. _Entry:_ ⌘K. Empty: "Nothing matches."

### Workspace search palette
- **⌘P fuzzy file finder** — Lists every non-ignored workspace file (loaded once per open), client-side fuzzy-filtered; selecting opens the file in the in-app editor. _Support:_ `src/components/WorkspaceSearchPalette.tsx`; `ipc.listWorkspaceFiles`. _Entry:_ ⌘P.
- **⌘⇧F workspace text search** — Server-side literal substring scan across every text file (debounced 180ms); results show file, `:line` (brass), and a preview; selecting opens the file at that line. _Support:_ `WorkspaceSearchPalette.tsx`; `ipc.searchWorkspaceText`. _Entry:_ ⌘⇧F.
- **Tab toggles modes** — Tab switches Files↔Text preserving the query; tabs show live counts. _Support:_ `WorkspaceSearchPalette.tsx`. _Entry:_ Tab inside the palette.

### Onboarding / welcome / empty states
- **Welcome screen** — Pre-project landing: § logomark, "Octopush" wordmark, "an atelier for agentic developers" tagline, brass rule, primary CTA "Begin a new study", drop-a-folder / "open one from disk" path input, drag-over dropzone, and footers listing Recent (up to 5) + "⟲ Recently closed" projects. _Support:_ `src/components/WelcomeScreen.tsx`; `projectStore`. _Entry:_ launch with no current project.
- **Folder drag-and-drop open** — Dropping a folder reads its path and opens it. _Support:_ `WelcomeScreen.tsx`. _Entry:_ drag a folder onto the welcome screen.
- **New-project flow** — `NewProjectFlow` full-screen when no project, or as an overlay over the current project from the rail's "Add project". _Support:_ `App.tsx`; `WorkspaceRail.onAddProject`. _Entry:_ Welcome CTA / rail add-project.
- **Empty-project state** — When a project has no active workspace: "No workspaces here yet… Create a workspace" CTA, overlaying the canvas (keeps PTYs alive). _Support:_ `src/components/EmptyProjectState.tsx`. _Entry:_ open a project with zero workspaces.
- **Run empty state** — In Run mode with no terminals: "Start a new terminal." CTA. _Support:_ `App.tsx` `RunEmptyState`. _Entry:_ Run mode, zero terminals.

### Toasts & notifications
- **Toast system** — Bottom-right stacked toasts (info/success/warning/error), auto-dismiss after `timeout` (default 5000ms) or manual `X`; imperative global `pushToast(...)`. _Support:_ `src/components/Toasts.tsx`. _Entry:_ programmatic across the app.
- **Backend-event toasts** — Listens for `octopus://budget-warning`, `octopus://session-error`, `pty://exit` and raises matching toasts. _Support:_ `Toasts.tsx`.
- **Startup "restored sessions" toast** — Fires once if any terminals were restored. _Support:_ `App.tsx`.
- **Budget-threshold toasts** — On chat-stream completion, fires 50% (info) / 80% (warning) / 100% (error, "Budget cap hit — Send blocked") toasts once per threshold per scope. _Support:_ `App.tsx`; `budgetsStore.notifiedThresholds`.
- **Attention chime** — Background chat/terminal completions ring a synthesized two-note brass chime (~250ms), rate-limited to one per 2s, with an AudioContext autoplay-unlock on first gesture; toggle in Settings → General. _Support:_ `src/stores/attentionStore.ts`. _Entry:_ automatic.
- **UpdateNotifier** — Corner update toast mounted at the shell root (see §10). _Support:_ `App.tsx` `<UpdateNotifier />`.

### Cross-cutting overlays, menus & dialogs
- **ModalShell** — Canonical dialog chrome: portal-to-body, tokenized scrim, `.octo-overlay-enter` + `.octo-modal-enter`, Escape (topmost-only via an `escStack`), focus-in/restore, Tab trap, optional click-outside, center/top alignment; exposes `isModalOpen()`. _Support:_ `src/components/ModalShell.tsx`. _Entry:_ reused by palettes, dialogs, modals.
- **MenuSurface** — Canonical context-menu chrome: portal-to-body, `.octo-menu-enter`, viewport clamping + arrow-key nav + Escape/outside-click via `useMenuChrome`. _Support:_ `src/components/MenuSurface.tsx`. _Entry:_ underlies all context menus.
- **Workspace / Project / Backlog context menus** — Right-click a rail monogram, project header, or Jira ticket — see §2 and §9 for full item lists. _Support:_ `App.tsx`; `WorkspaceContextMenu`, `ProjectContextMenu`, `BacklogRowContextMenu`.
- **Settings overlay** — Full Settings opened to a specific tab; refreshes the issue-tracker-configured flag on save. _Support:_ `App.tsx`; `Settings`. _Entry:_ ⌘, / ⌘⇧T / top bar / palette.

### Motion & UI primitives
- **FadeSwap** — Crossfades mutually-exclusive views by key (outgoing `.octo-fade-out` 120ms, then `.octo-fade-in`); honors reduced-motion. _Support:_ `src/components/primitives/FadeSwap.tsx`.
- **Reveal** — Mounted expand/collapse via grid-rows `0fr↔1fr` + opacity; closed content is `inert`. _Support:_ `src/components/primitives/Reveal.tsx`.
- **prefersReducedMotion()** — Shared JS guard for reduced-motion. _Support:_ `src/lib/motion.ts`.

### Notable implementation details
- `activeMode` is derived from `modePerWorkspace[activeWorkspaceId] || "talk"`. All four mode canvases stay mounted as opacity-gated `ModeOverlay`s (no unmount on switch). A single `window` `keydown` listener in `App.tsx` owns every global shortcut (see Appendix C).
- **Attention model** — `attentionStore.ping(wsId, kind)` flags a workspace ("chat"→Talk, "terminal"→Run) and chimes; App mirrors `{workspaceId, mode}` into `src/lib/focus.ts` and clears a flag only when the user is on the matching mode of the flagged workspace.
- **PTY survival architecture** — `allTerminalRefs` flattens `terminalsByWs` so every `TerminalPane` mounts at once (only the active one visible), keeping PTYs + scrollback alive across project switches. A module-level `terminalInitInFlight` Set guards against double-creation of the auto-"Main" terminal.
- **Git/PR refresh cadence** — Git status refreshes on workspace/mode change, on window focus, and on a 3s interval only in run/review (skipped while hidden); the diff is built only in Review. Open-PR is fetched per workspace-switch then every 60s. Token usage refreshes every 30s and on chat-turn completion.

---

## 2. Projects & Workspaces

Workspaces **are git worktrees** living as siblings of the project root under `<parent>/.octopus-worktrees/<branch>/`. The **main workspace** is special: its `worktree_path` equals the project root (git forbids the default branch checked out twice), so the project root *is* the main worktree.

### Project lifecycle — create
- **New-project wizard (2-step, 4 types)** — Italic-serif "A new project" flow with Roman-numeral steps (I Type · II Details). Type cards: **Empty** (∅), **Clone** (⎘), **Open** (⌖), **Template** (❦, "Coming soon", disabled). _Support:_ `src/components/NewProjectFlow.tsx`. _Entry:_ Rail footer "Add project" → full-screen overlay.
- **Create empty project** — Scaffolds a folder under a location (default `~/.octopush/projects`), `git init`, baseline commit, auto-creates the "main" workspace. _Support:_ `projectStore.create` → `create_project` → `db.insert_project` + `git_ops::init_repo`/`ensure_initial_commit` + `ensure_main_workspace`. _Entry:_ Step II "Name your new study".
- **Open existing folder** — Native folder picker; registers the folder as a project, `git init`s it if not a repo, heals empty initial commits. _Support:_ `@tauri-apps/plugin-dialog`, `ipc.openProject` → `open_project`. _Entry:_ Step II "Open a folder.".
- **Clone from remote URL** — Paste git URL → auto-detect repo name + host badge (`§ host`); editable name + location; streams live progress bar (phase · current/total · %). _Support:_ `clone_project` → `clone_via_shell` shells `git clone --progress` through the user's **login shell** (inherits SSH agent/keychain/gitconfig); emits `clone://progress`. URL parsed by `src/lib/parseGitUrl.ts` (mirror of Rust `git_url::parse_git_url`). _Entry:_ Step II "Clone a repository."
- **Clone auth fallback (HTTPS PAT)** — On `AuthRequired`, shows a private-repo panel: username + Personal Access Token, "Remember for {host}"; retries via a temp `GIT_ASKPASS` script. _Support:_ `AppError::AuthRequired`, `ipc.saveGitCredentials`. _Entry:_ inline panel.
- **Clone SSH-key-missing fallback** — On `SshKeyMissing`, suggests `ssh-add …` with "Try again" and "Switch to HTTPS" (rewrites SSH→HTTPS). _Support:_ `AppError::SshKeyMissing`. _Entry:_ inline panel.

### Project lifecycle — open / pin / reorder / customize / close / reopen / delete
- **Open project** — Idempotent: un-closes, bumps `last_opened`, heals missing main workspace, preserves Jira key/pin/tint; persists `lastOpenedProjectPath` (restored next launch). _Support:_ `projectStore.open`, `open_project`, `db.reopen_project`.
- **Recent projects list** — Backend-ordered `pinned DESC, sort_order, created_at ASC`, excludes closed. _Support:_ `projectStore.loadRecent` → `list_recent_projects` → `db.list_projects`.
- **Pin / unpin project** — Toggles `pinned`; pinned sort first. _Support:_ `set_project_pinned`. _Entry:_ Project context menu.
- **Reorder projects (drag + menu)** — Drag-handle reorders the rail (persists `sort_order`); conditional "Move up"/"Move down" menu items. _Support:_ `@dnd-kit`, `projectStore.setOrder` → `set_project_order`. _Entry:_ header grip / context menu.
- **Customize project (name + tint)** — `ProjectCustomizeMenu`: name input + 7-swatch tint grid; persists to **both** localStorage and DB. _Support:_ `ProjectCustomizeMenu.tsx`, `update_project_customization`. _Entry:_ "Change tint" / "Rename project".
- **Set Jira project key** — Optional menu item; stored per-project for branch→issue auto-detection. _Support:_ `update_project_jira_key`. _Entry:_ "Set Jira project key…".
- **Close project (soft)** — Sets `closed_at`, preserves workspaces/terminals/chats; restorable from Recently closed. _Support:_ `close_project`. _Entry:_ context menu danger row.
- **Reopen project** — Clears `closed_at`, bumps `last_opened`. _Support:_ `reopen_project`. _Entry:_ Recently-closed drawer "Restore".
- **Delete project (from disk, permanent)** — Deletes all workspaces+worktrees, then `rm -rf` project dir, then DB row; guarded by a **type-the-name** confirm. _Support:_ `delete_project`; `ConfirmDialog requireInput`. _Entry:_ context menu danger row.
- **Project utility actions** — Reveal in Finder, Copy path, Open in editor, Open in terminal. _Support:_ `reveal_in_finder`/`open_in_editor`/`open_in_terminal`. _Entry:_ context menu.

### Workspace lifecycle — create
- **New-workspace wizard (2-step)** — "A new workspace" flow (I Task & intent · II Setup script). Task input → branch auto-slugged (editable override), live "BRANCH … from {base}" preview; setup-script textarea (remembered per-project); CTA "Begin". _Support:_ `src/components/WorkspaceCreator.tsx`, `workspaceStore.create` → `create_workspace`, `companionPrefsStore`. _Entry:_ per-project "+" on header.
- **Branch name override** — Editable branch field; auto-cleans via slugify; warns "Branch exists — the workspace will reuse it" on collision. _Support:_ `WorkspaceCreator.tsx`, `listBranches`.
- **Base branch picker** — Inline `BaseBranchPicker` lists local branches (repo default first) + a "REMOTE" section (`origin/…`); filter above 8 branches. _Support:_ `BaseBranchPicker.tsx`, `list_branches`; base resolved by `git_ops::resolve_base`. _Entry:_ creator branch-preview row.
- **Start workspace from a PR** — `PrPicker` chip retargets base to a PR's head ref (`ensurePrBranch` fetches it), prefills task with PR title. _Support:_ `WorkspaceCreator.handlePickPr`, `ipc.ensurePrBranch`. _Entry:_ creator branch row.
- **Setup script** — Commands run in the new worktree on create; shows the honest worktree path; remembered as a project template on success. _Support:_ `create_workspace` `setup_script`.
- **Link Jira issue on create** — Optional `linkIssueKeyOnCreate` links the ticket after creation. _Support:_ `update_workspace_link`.
- **Existing-workspace-for-ticket guard** — Modal warns if a workspace already maps to that ticket. _Support:_ `ExistingWorkspaceAlertModal.tsx`.

### Workspace lifecycle — archive / restore / rename / delete / customize / link
- **Archive workspace** — Removes the worktree dir + prunes the worktree ref but **keeps the branch**; flips DB `status='archived'`. Main worktree never touched. _Support:_ `archive_workspace`, `git_ops::delete_worktree`. _Entry:_ context menu (hidden for main).
- **Restore archived workspace** — Recreates the worktree from the kept branch, flips `status='active'`; lists archived rows newest-first. _Support:_ `ArchivedWorkspacesModal.tsx`, `restore_workspace`/`list_archived_workspaces`, `git_ops::create_worktree`. _Entry:_ Project context menu "Archived workspaces…".
- **Delete workspace (permanent)** — Removes worktree dir, prunes ref, deletes branch, removes DB row; confirm dialog. Main worktree: only DB row removed. _Support:_ `delete_workspace`, `git_ops::delete_worktree`/`delete_branch`. _Entry:_ context menu danger (hidden for main).
- **Rename workspace** — Single-field `RenameDialog`. _Support:_ `rename_workspace`. _Entry:_ context menu.
- **Customize workspace (glyph + tint)** — `WorkspaceCustomizeMenu`: 1-char glyph + 7-swatch tint grid; persists `null` when matching defaults. _Support:_ `update_workspace_customization`. _Entry:_ context menu / right-click monogram.
- **Link / change / unlink Jira ticket** — Conditional menu items by linkage state; opens a Jira ticket picker. _Support:_ `update_workspace_link`. _Entry:_ context menu Jira group.
- **Workspace utility actions** — Reveal in Finder, Copy path, Copy branch name, Open in editor, Open in terminal. _Support:_ same ipc helpers. _Entry:_ context menu.

### Workspace Rail (left panel)
- **Hierarchical project→workspace grouping** — Each project is a single-bordered card: `panel-2` header (ProjectMark hexagon + uppercase mono name in tint accent) over its workspace rows. _Support:_ `WorkspaceRail.tsx` `SortableProjectGroup`.
- **Rail collapse / expand** — Two widths: 280px / 50px (220ms). Collapsed = centered monograms; expanded = monogram + name + status column. _Support:_ `WorkspaceRail`; toggle in footer (`PerfMonitorBar.onToggleRail`).
- **Per-project collapse** — Chevron collapses just that project; persisted to localStorage. _Support:_ `WorkspaceRail`.
- **Filter projects & workspaces** — Mono text input (expanded only); matches project or workspace names; Escape clears; auto-expands matches. _Support:_ `WorkspaceRail`.
- **Workspace selection + persistence** — Click selects; remembers last-active workspace **per project**. _Support:_ `workspaceStore.select`/`rememberActiveForProject`.
- **Monogram identity** — Serif glyph (custom or first letter), tint accent/bg. _Support:_ `src/lib/monogram.ts` (`resolveMonogram`, 7 named `TINTS`), `ProjectMark.tsx`.
- **Active-workspace styling** — Brass left edge + brass-ghost bg (brass reserved for active). _Support:_ `WorkspaceRow`.
- **Attention pulse** — Non-active workspace needing attention pulses (brass border) with enriched aria/title. _Support:_ `attentionStore`.
- **Per-workspace git status chips** — Linked-issue key, ahead (↑), behind (↓), open-PR, dirty; tones sage/verdigris/mute; dirty hidden when active. _Support:_ `workspaces_git_summary`, `open_prs_for_project`.
- **Project header aggregate chips** — Rolls up dirty-workspace count + open-PR count. _Support:_ `SortableProjectGroup`.
- **Per-project "+ New workspace"** — Hover-revealed Plus. _Support:_ `onNewWorkspaceForProject`. _Entry:_ header hover.
- **Right-click context menus** — Monogram → workspace menu; header → project menu (coordinates passed through). _Support:_ `WorkspaceRail`.
- **Recently-closed drawer** — Collapsed-by-default footer "⟲ Recently closed · N" (hidden when none), per-row "Restore"; backend caps at 10 newest. _Support:_ `RecentlyClosedDrawer.tsx`, `list_closed_projects`. _Entry:_ rail footer.
- **Add project footer / Project picker modal** — Quiet "Add project" action; generic `ProjectPickerModal`. _Support:_ `WorkspaceRail`, `ProjectPickerModal.tsx`.
- **Empty state** — "No workspaces yet" per project when expanded. _Support:_ `WorkspaceRail`.

### Notable implementation details
- **Worktree mechanics** — `create_worktree` aggressively self-heals from failed prior runs (rm partial dir, prune invalid/same-name worktrees, sweep orphan `.git/worktrees/<name>/`, attach existing branch ref). `delete_worktree` prunes the ref but never the branch. Main-worktree guards canonicalize paths and refuse to `rm -rf` the project root.
- **DB schema — projects:** `id, name, path (UNIQUE), created_at, last_opened`, + `jira_project_key, closed_at, pinned, sort_order, tint`. **workspaces:** `id, project_id (FK CASCADE), name, task, branch, worktree_path, setup_script, status, created_at, last_active`, + `glyph, tint, test_command, linked_issue_key, issue_link_dismissed, from_branch`.
- **Customization dual-persistence** — Workspace glyph/tint → DB only. Project name/tint → both localStorage (`projectCustomizations`) and DB, with a one-time migration into the backend.
- **Tint palette** (`monogram.ts`) — 7 named tints (brass, verdigris, rouge, indigo, lavender, smoke, bone), each `{accent, bg}`.
- **URL parsing parity** — `git_url.rs` (Rust) and `parseGitUrl.ts` (TS) handle HTTPS/SCP/ssh/multi-level GitLab/self-hosted hosts identically; the TS mirror keeps clone-name auto-detect instant.

---

## 3. TALK Mode (AI Chat)

### Conversation threads (multi-thread per workspace)
- **Multi-conversation per workspace** — Each workspace holds many persisted chat threads; the active thread's messages load, others stay server-side. _Support:_ `chatStore.ts`; DB `chat_threads`/`chat_messages`; `list_chat_threads`/`create_chat_thread`/`rename_chat_thread`/`delete_chat_thread`. _Entry:_ Companion "Chats" panel (Talk mode).
- **New / select / delete conversation** — New creates an empty "New conversation" thread; select reloads messages and restores any background streaming indicator + active skill; delete removes thread + messages and tears down the thread's TALK shell PTY, falling back to next/new thread. _Support:_ `newThread`/`selectThread`/`deleteThread` (chatStore) → `delete_chat_thread` → `talk_shell.close()` + cascade. _Entry:_ CompanionHistory rows.
- **Auto-derived thread titles + relative meta** — Untouched default threads are renamed from the first user message (or first `$ cmd`) on send. _Support:_ `chatTitle.ts` (`deriveChatTitle`, `deriveChatMeta`, `formatRelTime`). _Entry:_ CompanionHistory.
- **Default-thread guard / orphan prevention** — `loadHistory` auto-creates a default thread if none exist; `ensureThread` guarantees a real thread before any send; a migration backfills a thread for orphan messages. _Support:_ `chatStore`, `db.rs`.
- **Cross-workspace notifications** — A message arriving for a non-active workspace pings the attention store / rail. _Support:_ `attentionStore.ping`. _Entry:_ rail Talk-icon pulse + chime.

### Streaming responses & the agentic loop
- **Agentic tool-use loop** — Sends messages with tools, executes tool calls, feeds results back, repeats until a final text answer (`MAX_TOOL_ITERATIONS = 25`). _Support:_ `chat_engine.rs::send_agentic`; `send_chat_message`; `chatStore.send`.
- **Streamed final text** — Only the FINAL assistant text is emitted as a `chat://stream` delta (intermediate pre-tool text suppressed); the frontend accumulates a live bubble with a `▊` caret. _Support:_ `ChatStreamEvent`, `ChatCanvas`.
- **"Thinking…" indicator** — Pulsing brass dot + serif "Thinking…" while streaming with no buffer text and no live tools. _Support:_ `ChatCanvas` `ThinkingIndicator`.
- **Done event & attention ping** — A metadata-only `done` event clears streaming state; chimes/pulses the rail only if not already on that chat; fires even for background threads. _Support:_ `chatStore`, `focus`.
- **Per-message token/cost meta** — Assistant turns show `Nk in · Nk out`, with cost persisted. _Support:_ `ChatMessage.tsx`; `token_engine::compute_cost`.
- **Token-usage recording** — Every billed turn records a `TokenEvent` so Companion CONTEXT + Settings · Usage update. _Support:_ `token_engine::TokenEngine::record`.
- **max_tokens truncation recovery** — If truncated mid-tool-use, error `tool_result`s are injected and the loop retries. _Support:_ `send_agentic` MaxTokens branch.
- **Persisted errors** — Provider/loop errors saved as `role="error"` rows, rendered as a rouge "Something went wrong" block (with "Configure API key" CTA when relevant). _Support:_ `ChatCanvas` `ErrorBlock`.

### Tool-call cards (§ TOOL_NAME)
- **Built-in tools** — `run_command` (bash in workspace dir, 50k truncation, exit-code annotation), `read_file` (100k truncation), `write_file` (creates parent dirs, overwrites), `list_files`. _Support:_ `tool_definitions()` + `execute_tool` (chat_engine).
- **Resolved tool card** — Collapsible `§ LABEL summary` card (full brass-dim border), expandable to the raw result in a mono `<pre>` (256px max) with a COPY affordance. _Support:_ `ToolCallCard.tsx`; labels `RUN/READ/WRITE/LIST`.
- **Live "running" tool card** — Between `chat://tool-start`/`tool-end`: pulsing brass dot, fixed-width elapsed timer from the backend's real `startedAt`, flips to verdict on `tool-end`, retires by `callId` when the resolved row lands (no flash). _Support:_ `LiveToolCard.tsx`.
- **write_file body stripping** — Large `content` replaced with `(N chars, written to disk)` for both the live event and the persisted record. _Support:_ `input_for_display`.
- **Card actions** — WRITE cards: "Open in editor", "Reveal in Finder (⊙)", "Open" (for `.html`); `run_command` cards: "Send to terminal" (switches to Run + copies command). _Support:_ ToolCallCard; `navigateToFile`, `revealInFinder`, `openFileInSystem`, `handleRunInTerminal`.
- **File-edit attribution → Review** — `write_file` records `file_edits`; a git-status catch-all credits files changed via `run_command`, so Review can map a change to its agent message. _Support:_ `insert_file_edit`, `git_status_files`; `get_message`.

### Slash commands / Skills
- **`/` skill menu** — A `/` at input start opens a menu of the worktree's skills (filtered after `/`), keyboard-navigable; selecting activates the skill. _Support:_ `SlashMenu.tsx`, `listSkills` → `list_skills` → `scan_skills`.
- **Skill discovery (project ∪ user)** — SKILL.md from `<worktree>/.claude/skills/*/SKILL.md` and `~/.claude/skills/*`; project shadows user. _Support:_ `skills/mod.rs`.
- **Active skill chip** — A `§ skillname` chip (with clear X) above the textarea; persists across turns until cleared; reset when switching threads. _Support:_ `chatStore` `activeSkillByWs`.
- **Skill effect on a turn** — Body appended to the system prompt under `# Active skill:`; if it declares `allowed-tools`, the turn's built-in tool set is filtered (MCP tools unaffected). _Support:_ `send_agentic`.

### @-mentions (files)
- **`@file` autocomplete** — Typing `@` opens a ranked worktree-file popover; arrow/Enter/Tab/Esc nav. _Support:_ `mentions.ts` (`findActiveMention`, `rankFiles`), `MentionPopover.tsx`; catalog via `listWorkspaceFiles`.
- **Mention expansion on send** — Each `@path` matching a known file is expanded into a fenced `§ path` code block (read with a 64k cap; non-text noted) appended to the message, so the model receives the file contents. _Support:_ `extractMentions`, `applyMention`; `readFileChecked`.

### Attachments (images)
- **Image attachments** — PNG/JPEG/GIF/WebP, ≤ 5 MB, via paste / drag-drop / paperclip picker; removable thumbnails; ride along on the next turn only; image-only sends allowed. _Support:_ `attachments.ts`, `AttachmentTray.tsx`; `read_attachment` (magic-byte sniffing); attached as multimodal `LlmBlock::Image` blocks.

### Effort selector
- **Generation effort (Swift/Standard/Deep)** — Segmented control → output-token budget: Swift 8192, Standard 32768, Deep 64000. _Support:_ `EffortSelector.tsx`; `chatStore` `EFFORT_MAX_TOKENS` → `ChatRequest.max_tokens`. _Entry:_ composer control bar.

### `$`-direct shell in chat (hybrid terminal)
- **`$ <cmd>` / `/run <cmd>` direct execution** — Runs a command in the thread's persistent bash shell, bypassing the LLM (zero tokens); persists `$ cmd` as a user turn + output as a `role="tool"` `§ RUN` card so the agent sees it next turn. `\$…` escapes to literal text. _Support:_ `shellCommand.ts::parseShellCommand`; `chatStore.runShell` → `run_shell_command` → `chat_engine::run_shell_command`.
- **Persistent per-thread shell** — One bash PTY per thread keeps cwd/env across commands; reuses the `octopush-pty-server` daemon in capture mode (echo off, marker-wrapped commands with a per-session nonce). _Support:_ `talk_shell.rs`.
- **cwd badge** — After a `cd`, a brass terminal badge shows the shell's working dir (relative, abbreviated). _Support:_ `chatStore` `shellCwdByThread`; `chat://shell-exit`.
- **Output capping** — `$`-direct output capped at 50k bytes with a truncation note. _Support:_ `talk_shell` `cap_output`.

### Live process panel & pinned mini-terminal
- **Promotion to live process** — A command not finishing within ~1500ms becomes a live process (dev servers/watchers stream instead of blocking the turn); the thread's shell is "busy" until it exits. _Support:_ `RunOutcome::{Done,Live,Busy}`, `LiveRun` (talk_shell); `chat://shell-live-start`.
- **Pinned mini-terminal (xterm)** — A bottom-pinned panel renders the live process via xterm.js (raw ANSI), with a Stop button; mounts on start, unmounts on exit. _Support:_ `LiveProcessPanel.tsx` + `TerminalView.tsx`; `chatStore` `liveProcessByThread`.
- **Race-free buffered output** — An always-on store listener buffers `chat://shell-output` chunks (capped) so the panel never loses output to a mount race. _Support:_ `chatStore` `liveOutputByCallId`.
- **Stop process (Ctrl-C)** — Sends SIGINT; the streamer then resolves the `§ RUN` card. _Support:_ `stop_shell_command` → `talk_shell.interrupt`.

### Savings ledger / cost (Companion)
- **Conversation savings ledger** — Shows what the conversation WOULD have cost on the priciest configured model ("all-premium") vs what it actually cost, leading with savings ($ + %) in verdigris; renders after ≥1 billed turn. _Support:_ `SavingsLedger.tsx`; `listProviders`. _Entry:_ Companion (Talk).
- **Inline cost preview** — Composer shows an estimated per-message cost + token count (assumes 30% output ratio). _Support:_ `cost.ts`. _Entry:_ composer control bar.
- **Context-window usage** — Companion CONTEXT card shows last turn's input tokens vs the active model's max context. _Support:_ `App.tsx`, `CompanionContext`.

### Composer (input bar)
- **Autosizing textarea + Enter-to-send** — Enter sends, ⇧↵ newline, grows to 8 lines; placeholder `"Ask anything…   @ file · / skill · $ run a command"`. _Support:_ `Composer.tsx`.
- **Prompt history** — ↑/↓ navigate per-workspace history; Esc exits. _Support:_ `Composer.tsx`.
- **Model picker** — Per-turn model selection (default `claude-sonnet-4-6`). _Support:_ `ModelPicker`; `chatStore` `model`.
- **Send / Stop crossfade** — Single button slot crossfades Send (brass) ↔ Stop (rouge); disabled when nothing to send / over budget. _Support:_ `FadeSwap`, `ComposerActionButton`.
- **Budget hard-stop + override** — Sending blocked when over workspace/global budget (`BUDGET_CAP_MSG`), with an "Override for this turn" one-shot. _Support:_ `budgetsStore`, `BudgetErrorBlock`.

### Cancel / stop
- **Stop generating** — Cancels the in-flight agentic turn for the active thread; persists a `role="stopped"` marker ("Generation stopped.") and emits `done`. Keyed by thread. _Support:_ `chatStore.stop` → `cancel_chat` → `ChatEngine.cancel`. _Entry:_ Stop button while streaming.

### Message rendering / export
- **Editorial assistant rendering** — Assistant content splits into a lead "key phrase" (Spectral upright-serif display) + markdown body; eyebrow `— ModelName` in brass mono; full markdown renderer in Onyx & Brass tokens. _Support:_ `parseKeyPhrase.ts`, `ChatMessage.tsx`.
- **User-turn rendering** — Eyebrow `— You` + plain content, no bubble. _Support:_ ChatMessage.
- **Clickable file paths** — File-path-shaped inline code becomes an "Open in editor" button. _Support:_ `looksLikeFilePath` (ChatMessage).
- **Per-message copy** — Hover-revealed Copy on each message row. _Support:_ `useCopyFeedback`.
- **Session recap / export (RUN-mode sessions)** — `get_session_recap` builds a `SessionRecap` (tokens, cost, duration, model, timestamps); `export_session_json`/`export_session_csv` bundle session + events + recap. _Support:_ `session_recap.rs`. _Note:_ operates on RUN-mode **sessions**, not TALK threads.

### MCP tools in chat
- **MCP tool injection** — Each turn appends tools from configured + reachable MCP servers (namespaced `mcp__server__tool`), discovered off-thread with a 20s timeout. _Support:_ `chat_engine::send_agentic`; `McpRegistry.list_tools` (`mcp/mod.rs`).
- **MCP tool invocation** — `mcp__`-prefixed tool names route to their server via `mcp.call(...)` with a 60s timeout (slow/hung → tool error, not a frozen turn). _Support:_ `is_mcp_tool`; cards render `MCP` label.

### Notable implementation details
- **Streaming** — Not token-by-token; `send_agentic` runs a synchronous agentic loop and emits the whole FINAL assistant text as one `chat://stream` delta, then a metadata `done`; per-tool `chat://tool-start`/`tool-end` drive live cards; every persisted row broadcasts via `chat://message-added`. All events routed by `workspaceId` + optional `threadId`, gated by `isActiveThread`.
- **Shell-in-chat** — Per-thread persistent bash PTY on the shared daemon (capture mode with nonce markers, ANSI stripped, exit code + `$PWD` recovered); ~1500ms promotion window streams long commands via `chat://shell-output`.
- **History → provider context** — `send_agentic` rebuilds context from DB rows; `role="tool"` rows summarized and prepended; consecutive user turns merged (Anthropic 400 guard); `assistant_tool_use` rows hidden on reload; `stopped` never replayed.
- **DB tables** — `chat_threads` (id, workspace_id FK, title, created_at, updated_at) and `chat_messages` (id, workspace_id FK, thread_id, role, content, model, input/output_tokens, cost_usd, created_at). Roles: `user, assistant, assistant_tool_use, tool, error, stopped`.
- **Provider routing** — `resolve_provider(model)` → `ProviderRouter::find_model` selects Anthropic or OpenAI-compatible, per-provider key + base-URL override.

---

## 4. RUN / Direct Mode (Pipeline Orchestration)

The flagship feature: compose pipelines of stages (each an AI agent with a role/model/substrate/tools/checkpoint/loop), run them, gate with checkpoints, iterate with review loops, recover from halts, and track cost/budget against an all-premium baseline.

### Pipelines — templates & authoring model
- **Pipeline templates** — A named, reusable graph of stages; each stage is one AI agent. Stored as templates, instantiated per-run. _Support:_ `pipelines` + `pipeline_stages` tables; `list_pipelines`, `get_pipeline`.
- **4 built-in pipelines (seeded, idempotent)** — `db.rs::seed_builtin_pipelines`: **Feature Factory** (plan→plan_review→implement✓→code_review✓ loop→test✓), **Bugfix relay** (repro→fix✓→verify✓ loop), **Plan & review** (plan→critique→refine✓, linear), **Claude Code build** (plan(api)→implement(cli)✓→code_review(cli)✓ loop→test(cli)✓). A one-shot UPDATE retrofits loop config onto pre-loop builtin installs.
- **Custom pipelines (create / fork / update)** — `save_pipeline` has 3 modes: create new; **fork a builtin to a new custom copy** (builtin never mutated); update a custom in place (transactional). _Support:_ `save_pipeline`; `pipelineStore.save`. _Entry:_ builder "Save as my copy" / "Save pipeline".
- **Delete pipeline** — Custom only; builtins protected. _Support:_ `delete_pipeline`. _Entry:_ builder footer two-step.
- **Pipeline validation** — `validate_pipeline_stages`: ≥1 stage; role must exist; substrate ∈ {api,cli}; non-empty model; `max_iterations` 1..=100; parents form an acyclic DAG; tools a subset of `KNOWN_TOOLS`; instructions ≤ 8000 chars; loop config rules (target requires `can_loop` role, flow-ancestor, mode ∈ {gated,auto}). _Support:_ `db.rs`.

### Node-based visual pipeline builder
- **React Flow node graph (DAG authoring)** — Zoomable canvas (minZoom 0.4, maxZoom 1.75, fitView, dotted brass bg, Controls, MiniMap). _Support:_ `PipelineBuilder.tsx`, `builder/graph.ts`, `builder/StageNode.tsx`, `builder/edges.tsx`. _Entry:_ DirectCanvas builder state.
- **Stage nodes** — 228px card: artifact icon + title + "{archetype} · {shortModel}"; substrate chip (cli=purple/api=blue); 4 tool dots; `⟜ gate` when checkpointed; validation marker; remove X (last-node guard). _Support:_ `StageNode.tsx`.
- **Add / connect / remove stages** — Add via palette drag (`application/octopush-archetype`) or click-to-add; connect by dragging handles (rejects self-connection, duplicate edges, cycles via `flowAncestors`); remove blocked below 1 stage. _Support:_ `graph.ts` `topoOrder` (Kahn sort), `flowAncestors`.
- **Flow & loop edges** — `FlowEdge` = brass smooth-step hairline with arrowhead; `LoopEdge` = dashed brass arc with centered `⟜ ×{loopMax}` pill (+ `· auto`). _Support:_ `builder/edges.tsx`.
- **Node palette** — 188px "Stages" well; roles grouped "Plan & design"/"Build"/"Review"/"Action"/"Your roles"; each item draggable, with Lock(builtin)/`custom` badge, `⟜` loop marker, hover "Fork & edit"; footer "New role". _Support:_ `NodePalette.tsx`.
- **Stage inspector** — 300px Companion editing the selected node: Name, Archetype (Listbox), Model (ModelPicker; CLI locked to Anthropic), Substrate, Approval (`⟜ gate` toggle), Tools (4 switches, last-tool guard, disabled for CLI), Max turns (Stepper 1–100), Instructions, and a Loop section (revealed for `can_loop`): Return-to, Max ×, Mode (Gated/Auto). _Support:_ `StageInspector.tsx`.
- **Live graph validation** — Mirrors the backend; blockers (no nodes, flow cycle, no model, max-turns out of range, empty/unknown tools, loop on non-review, multiple loops per source, loop target not a flow-ancestor) and amber warnings (CLI without a Claude model, `diff` artifact without `write_file`, `tests` without write/run, orphan node, auto-loop note). Save disabled while any blocker stands. _Support:_ `builder/graph.ts` `validateGraph`.
- **Graph ↔ backend serialization** — `graphToStageDrafts` compiles canvas → position-based `StageDraft[]` (topo-ordered, parents mapped, loop derived, `tools=null` for CLI, coords round-tripped); `draftToGraph` reopens a saved pipeline (legacy no-parents → auto-laid-out linear chain). _Support:_ `builder/graph.ts`.

### Stage roles & the role editor
- **15 built-in roles (data-driven, seeded)** — `orchestrator/roles.rs::builtin_roles`: `plan, plan_review(loop), implement, code_review(loop), test, repro, fix, verify(loop), critique(loop), refine, architect, security_review(loop), pull_request(action/cli), merge(action/cli), release(action/cli)`. Each `RoleDef` carries label, prompt_body, artifact_kind, environment, can_loop, default_tools, default_substrate, default_checkpoint, token estimates. _Support:_ `roles` table; `list_roles`; `rolesStore`.
- **Artifact kinds** — `Plan | Review | Tests | Diff | Note`; determines dossier labels and whether the artifact refs the worktree. _Support:_ `orchestrator/types.rs`.
- **Role environment contract** — `Worktree` = headless worker, never touches git (`PREAMBLE_WORKTREE`); `Action` = may commit/push/run git/gh/release (`PREAMBLE_ACTION`, defaults to CLI + checkpoint). _Support:_ `RoleEnvironment`; `compose_system_prompt`.
- **Tool presets** — `ro()`=[read_file,list_files], `run_()`=+run_command, `full()`=+write_file+run_command. _Support:_ `roles.rs`.
- **Custom role editor** — Conversational "prompt-as-hero" modal: name (auto-derives snake_case key), key, environment flip, description, prompt body, and a natural-language brief with inline `ChipMenu` dropdowns (artifact kind, environment, tools, loop, substrate, checkpoint). Built-ins always fork on save. _Support:_ `RoleEditor.tsx`; `save_role`. _Entry:_ palette "New role" / edit pencil.
- **Delete role (referential-integrity guarded)** — Rejects builtin deletion and any role still referenced. _Support:_ `delete_role`.

### Stage substrates & execution
- **API substrate (in-app agentic loop)** — `ApiRunner` runs a stage through `run_agentic_loop`: resolves provider, composes system prompt, builds the input dossier, runs a tool-use loop bounded by `max_iterations`, returns exact token usage + cost. _Support:_ `orchestrator/runner.rs`, `agentic.rs`.
- **Agentic loop internals** — Per-stage tool allowlist; transient-error retry with backoff + journal narration; proactive rate-limit throttle; tool results capped at 24KB fed back; cancel flag checked each iteration; an unfinished loop is a **failure** (usage preserved). _Support:_ `agentic.rs`.
- **CLI substrate (headless Claude Code)** — `CliRunner` spawns `claude -p --output-format stream-json --verbose --model … --append-system-prompt … --permission-mode bypassPermissions --max-turns N` in the worktree, streams NDJSON, parses the terminal `result` event. _Support:_ `cli_runner.rs`.
- **CLI environment & PATH resolution** — Captures the user's full login+interactive shell env once (`SHELL -lic 'env -0'`) so a GUI-launched app inherits PATH/exports; resolves the `claude` executable across login PATH ∪ inherited ∪ common dirs. _Support:_ `login_shell_env`, `resolved_cli_path`.
- **CLI timeouts** — Idle (300s silence) + absolute (3600s) with distinct honest messages; stderr drained concurrently. _Support:_ `cli_runner.rs`.
- **Uniform runner abstraction** — Both substrates implement `AgentRunner::run(stage, input, ctx) -> StageOutcome`; the orchestrator never branches on substrate. _Support:_ `runner.rs`.
- **Stage input dossier (cross-stage handoff)** — Each stage receives the run task, a one-line pipeline breadcrumb, and the **freshest artifact of each kind** from feeding stages (transitive flow-ancestors; sibling branches don't leak), each capped at 16KB. _Support:_ `assemble_stage_input`, `StageInput`.

### Runs — lifecycle & control
- **Create run (draft)** — Copies pipeline_stages into a private `run_stages` copy, applies positional `(position, model)` overrides, inserts as `draft`. _Support:_ `create_run`; `runsStore.begin`.
- **Start run (background drive)** — Spawns the drive as a `tokio` task; persists optional budget. _Support:_ `start_run` → `orch.start_run`.
- **Run status lifecycle** — `draft → running → paused → completed | aborted | failed`. _Support:_ `RunStatus`; status meta in `runStatus.ts`.
- **Stage status lifecycle** — `pending → running → {awaiting_checkpoint | done | failed}`; the drive picks the lowest-position non-`done` stage. _Support:_ `StageStatus`; `runStatus.ts`.
- **Director pause** — Parks the next pending stage at the boundary. _Support:_ `request_run_pause`; `RunningBar` Pause.
- **Stop current stage** — Real cancellation: API loop halts at next check, CLI kills the child; stage lands `failed` in halt-recovery. _Support:_ `stop_stage`; `RunningBar`.
- **Abort run** — Marks `aborted` AND kills the in-flight stage. _Support:_ `abort_run`.
- **One executing run per workspace** — `start_run` rejects a concurrent running/paused run in the same workspace (runs share one worktree); UI gate disables "Begin the run". _Support:_ `has_concurrent_run`; `runsStore.hasExecutingRun`.
- **Interrupted-run recovery (startup)** — Stages stuck `running` after a crash are stamped `failed` (`INTERRUPTED_STAGE_ERROR`); runs re-parked `paused`; the amber Resume affordance keys off the "interrupted" prefix. _Support:_ `db.recover_interrupted_runs`.

### Checkpoints, gates & review loops
- **Checkpoint gates** — A `checkpoint=true` stage parks `awaiting_checkpoint` + run `paused` on completion. _Support:_ `checkpoint` column; `drive_inner`.
- **Review loops — two modes** — A review stage (`can_loop`) can route work back to a `loop_target`. **Gated:** the run pauses; the human chooses Send-back vs Approve-anyway. **Auto:** the orchestrator loops target↔review automatically on a parsed `VERDICT: CHANGES_REQUESTED` until it passes or hits the cap. _Support:_ `LoopMode`; loop columns; `parse_verdict`.
- **Loop-back mechanics** — Resets the contiguous `[target..=review]` range (restricted to flow-ancestors) to `pending`, forwards the reviewer's findings as feedback, archives erased attempts, retires their cost, bumps the loop counter, re-drives. Cap reached → escalates to a checkpoint. _Support:_ `loop_back`, `db.increment_loop_iteration`, `db.retire_stage_cost`.
- **Checkpoint actions (full vocabulary)** — `resolve_checkpoint`: **Approve** (accept & continue; a failed stage's partial work is accepted via a synthesized artifact), **Reject** {feedback, model_override, max_turns_override} (re-run the single stage), **SendBack** {feedback} (loop the review back to its target), **Resume** {max_turns_override} (recover a halted stage; CLI `--resume`s the same session), **Discard** (revert the worktree to the failed stage's baseline), **Edit** (artifact edited out-of-band; continue), **Abort**. _Support:_ `CheckpointAction`; `runsStore.resolve`; `RunControlBar`.
- **Decision bar UI (state-adaptive)** — `RunControlBar.tsx` switches on status: TerminalBar ("Run it again"), DecisionBar (checkpoint/halt, with Resume/Re-run turn-budget Stepper, Accept-partial, Discard-with-confirm, "why this halted" disclosure, feedback editor for reject/send-back, loop-state banner), RunningBar (live). _Entry:_ bottom command bar.

### Live orchestration view
- **Structured live activity channel (`run://log`)** — Both substrates emit `LiveEntry` entries (`text`, `tool {name,hint}`, `tool_result {ok,detail}`, `notice`) through one `LiveEmitter`. _Support:_ `orchestrator/live.rs`; `runsStore` `liveByStage` (200-entry ring buffer per stage).
- **Living pipeline / process cards** — Wrapping row of per-stage cards joined by brass connectors (`⟜` gated / `⟶`); each card: artifact icon + title + Roman numeral, status glyph + word + elapsed timer, model + substrate pill, live-activity line, loop badge `⟲ {iter}/{max}`. Transient-halt cards show amber `⟳` "stalled". _Support:_ `RunFlow.tsx`.
- **Work journal / focus pane** — Selected stage's work: `§ {ROLE}` header, iteration-history navigator, tokens + cost; body renders the journal (text/notice/tool cards). Modes: archived-attempt, failed (sticky halt banner), artifact (text + `SnapshotDiff` or live `DiffViewer`), running (live journal + role-verb liveness), idle. _Support:_ `StageFocus.tsx`.
- **Journal persistence** — `PersistingSink` mirrors every `run://log` entry into `stage_log` (reset events → marker rows) so journals survive reloads and loop-backs. _Support:_ `orchestrator/persist.rs`; `get_stage_log`.
- **Run header** — Stage `n/m` counter + "the brief" eyebrow over the (truncated) run task. _Support:_ `DirectCanvas`.

### Iteration history & diff snapshots
- **Archived stage attempts** — Before every reset, `archive_stage_attempt` snapshots the stage into `stage_iterations` (ordinal, role, model, status, artifact, error, cost, tokens, `closing_feedback`, `diff_snapshot`). _Support:_ `list_stage_iterations`.
- **Iteration navigator** — `‹ attempt N of M ›` when archives exist; viewing a past attempt shows its artifact/error, cost, "sent back with" feedback, journal segment, and `SnapshotDiff`. _Support:_ `StageFocus.tsx`.
- **Stage diff snapshots** — On a code-bearing stage finish (`refs_worktree`), the worktree diff is captured (capped 512KB) so the focus pane shows the worktree as that stage left it, frozen. _Support:_ `capture_stage_diff_snapshot`; `git_ops::get_diff_text`.
- **Focus-follows-action** — A pinned running stage that finishes auto-clears the pin so focus returns to the active stage. _Support:_ `DirectCanvas`.

### Cost estimation & budget enforcement
- **Pre-run cost estimate** — Sums per-stage cost from each role's token estimates; returns `{estimateUsd, baselineUsd}`. _Support:_ `estimate_run_cost` → `cost::stage_cost`/`baseline_cost`.
- **Live cost & all-premium baseline** — Per-stage actual cost accumulated; baseline re-prices the same tokens at the **premium reference model** (highest blended price among enabled providers; per-pipeline overridable). Includes retired (looped/rejected) cost so re-runs count truthfully. _Support:_ `orchestrator/cost.rs`; `recompute_run_cost`; `run://cost`.
- **Cost ledger strip** — Savings-first: "saved $X · N% under all-premium" / "spent $Y"; budget fragment; brass progress bar; expandable per-stage breakdown; a one-shot completion "moment" (`octo-sweep`). _Support:_ `RunLedger.tsx`; `runStatus.ts`.
- **Budget enforcement (between-stage gate)** — Optional per-run `budget_usd`; before a pending stage starts, if spend ≥ budget the stage parks `awaiting_checkpoint` + run `paused` with a budget notice. Approving is a conscious override. _Support:_ `pause_for_budget`, budget gate in `drive_inner`; `set_run_budget`.

### Entitlement & quota (premium — enforcement live)
- **Direct-runs meter** — A quiet "Direct runs · this month" count in the launcher ledger. **Free** shows `used / 25` and tints toward rouge as the cap fills; **Pro** is uncapped (just the count). _Support:_ `src/components/DirectRunsMeter.tsx`, `useEntitlement` hook, `entitlementStore`; command `direct_run_usage` → `db.count_started_runs_this_month` (runs that have *left* `draft` — i.e. been started — since the start of the month). _Entry:_ Direct launcher (`PipelineSetup`).
- **Run quota gate (live)** — `start_run` consults the current entitlement before driving a run; over the monthly Direct-run limit it returns `AppError::UpgradeRequired { feature, used, limit }`, which the frontend catches (`runsStore.begin` → `isUpgradeRequired`) to show an **upgrade sheet** (`UpgradeSheet.tsx` + `upgradeStore`, mounted globally) — a modal with the used/limit and an "Upgrade to Pro" button that opens the Dodo checkout. **Free / signed-out** is the restricted tier (`FREE_DIRECT_RUNS_PER_MONTH` = 25, no premium features); **Pro** grants `direct.unlimited` (uncapped). The plan comes from the signed-in user's Clerk `public_metadata.plan` (`entitlement::current` → `for_plan`). _Support:_ `src-tauri/src/entitlement.rs` (`Entitlement`, `for_plan`, `check_direct_run_quota`, `FREE_DIRECT_RUNS_PER_MONTH`), gate in `commands::start_run`; command `get_entitlement`. See [`docs/premium/`](premium/).

### Halt detection & recovery
- **Halt classification** — `isTransientHalt` (`runStatus.ts`) detects recoverable substrate faults (interrupted/crash, rate limit, overloaded, `API error 429|529|5xx`, timeout, connection reset) to choose the amber Resume affordance. Mirrors backend `ProviderErrorKind::is_transient`.
- **Halt cause copy** — `haltCause(error, maxIterations)` maps `error_max_turns`, `error_during_execution`, "no output for", "exceeded … cap" to plain-English title+remedy. _Support:_ `stageHalt.ts`.
- **Halt journal entry** — A terminal `⏹ Stage halted — {first error line}` notice is appended; the agentic cap emits "iteration cap reached". _Support:_ `record_halt`.
- **Session capture & CLI Resume** — The CLI session id is persisted on each finish; Resume `--resume`s the same session with a fresh turn budget. _Support:_ `session_id`/`resume_pending` columns; `build_cli_args_resume`.
- **Turn-budget override on recovery** — Resume/Reject carry `max_turns_override` (UI default = current ×2 for an `error_max_turns` halt). _Support:_ DecisionBar Stepper; `set_stage_max_iterations`.
- **Accept partial work** — Approving a **failed** stage synthesizes a role-shaped artifact (preserving burned cost) + salvages the journal, completes it `done`, drives on. _Support:_ Approve arm, `salvage_journal_text`.
- **Discard (per-stage baseline revert)** — A baseline (dangling commit of the worktree at stage start, captured via a temporary git index) is snapshotted before each stage; Discard makes the worktree byte-identical to that baseline. _Support:_ `orchestrator/git_baseline.rs`; `baseline_commit` column.

### Run navigation & the run hub
- **Viewed-run vs executing-run decoupling** — Three-state per-workspace view: absent=active run, `null`=launcher, runId=that run. _Support:_ `runsStore` `getViewedRunId`/`selectRun`.
- **DirectCanvas (RUN-mode shell)** — Crossfades between builder, launcher/empty, and the active run layout (run header + RunFlow + StageFocus + RunLedger + RunControlBar). _Support:_ `DirectCanvas.tsx`.
- **"Run it again" (re-launch prefill)** — Terminal runs offer "Run it again": seeds a one-shot launcher prefill `{task, pipelineId, overrides}`. _Support:_ `LauncherPrefill`; TerminalBar.
- **Launcher ("The Commission")** — Non-graph launch surface: I·The brief (task textarea), II·The ensemble (horizontally-scrolling `PipelineTicket` rail + "Compose a new one"), the selected pipeline's `StageFlow` crew editor, and the ledger; "Begin the run" gated by task + concurrency. _Support:_ `PipelineSetup.tsx`, `direct/PipelineTicket.tsx`, `direct/StageFlow.tsx`.
- **Launcher crew editor** — Per-stage cards with in-place `ModelPicker` overrides (CLI locked to Anthropic), substrate chip, tool dots, gate/loop badges; launch-time model tuning only. _Support:_ `direct/StageFlow.tsx`.
- **Pipeline ticket** — 184px selector card: `&` brass seal for builtins, name, a stage-dot "shape line", "N stages", hover Edit → builder. _Support:_ `direct/PipelineTicket.tsx`.

### Notable implementation details
- **Orchestrator architecture** — `Orchestrator` (`orchestrator/mod.rs`) drives runs as background tokio tasks, one stage at a time, pausing at checkpoints; enforces a single active drive per run, holds per-run cancel flags + pause requests, routes every emit through a `PersistingSink`. The `EventSink` trait decouples it from Tauri for testability.
- **Drive loop** — Pick lowest non-`done` stage; complete the run if none; check budget gate then director-pause; run the stage; on Failed → paused+checkpoint; on Done → auto-loop verdict decision before the gated pause. Aborts mid-stage always win.
- **DB tables** — `pipelines`, `pipeline_stages` (+ pos/parents/tools/custom_name/instructions/loop/max_iterations), `runs` (+ cost/baseline/reference_model/retired/budget/linked_issue_key), `run_stages` (private per-run copy + status/tokens/cost/artifact/feedback/error/loop/diff_snapshot/session_id/resume_pending/baseline_commit), `roles`, `stage_log`, `stage_iterations`, `run_events`.
- **Tauri events** — `run://stage-update`, `run://cost`, `run://checkpoint`, `run://error`, `run://log`. Subscribed once in `runsStore`.
- **Worktree as the blackboard** — Stages never commit (handoff = worktree + structured artifact); all runs in a workspace share the one worktree, which is why only one executes at a time. A completed run leaves changes uncommitted for Review mode.

---

## 5. REVIEW Mode (Diff, Editor & AI Review)

### Mode shell & layout
- **3-column Review canvas** — Left `ReviewSidebar` (Changes/Files navigator) · center `ReviewCanvas` (Diff/Editor) · right `CompanionReview` (change intelligence). _Support:_ `App.tsx`, `ReviewCanvas.tsx`. _Entry:_ ModeSwitcher → Review.
- **Diff ⇄ Editor view toggle** — Segmented control (LayoutList "Diff" / PenLine "Editor"); controlled by parent so any surface can deep-link. _Support:_ `ReviewCanvas.tsx`. _Entry:_ canvas toolbar.
- **Deep-link navigation to file/line** — `navigateToFile(path, "diff"|"editor", line?)` switches mode, opens the file or scrolls the diff, optionally reveals a line. _Support:_ `App.tsx`. _Entry:_ terminal links, chat links, Files tree, AI findings, Changes rows.

### Diff viewer (read & triage)
- **Continuous hybrid diff** — files → sticky hunk rails → syntax-highlighted, word-diffed lines (not cards). _Support:_ `review/DiffView.tsx` → `FileDiffSection` → `HunkRail` + `DiffLines`; `lib/diffParser.ts::parseFullDiff`.
- **Per-hunk rail** — Sticky brass-bordered bar: human range, `+adds`/`−dels`, focused state, Accept / Reject / Why? buttons. _Support:_ `review/HunkRail.tsx`.
- **Accept hunk** — Stages just that hunk (`git apply --cached -p1`). _Support:_ `ipc.stageHunk` → `stage_hunk`.
- **Reject hunk + undo** — Reverse-applies (`git apply --reverse`), shows a 6s undo bar; undo re-applies (`apply_hunk`). _Support:_ `ipc.revertHunk`/`applyHunk`; `friendly_git_error`.
- **Accept all** — Stages every change (`git add -A`). _Support:_ `stage_all_changes`. _Entry:_ toolbar.
- **Inline vs Side-by-side** — Persisted toggle; SBS pairs del/add runs into two synced columns with cross-pane word-diff. _Support:_ `reviewPrefsStore.readingMode`, `DiffLines.tsx`.
- **Ignore-whitespace toggle** — Persisted; hides whitespace-only changes. _Support:_ `reviewPrefsStore.ignoreWhitespace`.
- **Syntax highlighting in diff** — Per-line tokenization via the file's CodeMirror language + a class-only HighlightStyle; bounded memo cache. _Support:_ `lib/diffHighlight.ts`.
- **Word-level diff** — LCS over tokenized runs between paired removed/added lines (cap 400 tokens). _Support:_ `lib/wordDiff.ts`.
- **Per-row line-number gutters** — Old + new line numbers, `+`/`−`/space sign column. _Support:_ `DiffLines.tsx`.
- **File header** — Change-type badge (NEW/DELETED/MODIFIED), path, hunk count, collapse chevron, "mark viewed". _Support:_ `FileDiffSection.tsx`.
- **Collapse / "viewed"** — Collapse a file; marking viewed auto-collapses. _Support:_ `DiffView`.
- **Keyboard triage** — `j`/`k`/↓/↑ move hunk focus, `]`/`[` jump file, `Space` fold, `a` accept hunk, `x` reject, `A` accept whole file, `v` viewed, `o` open in editor, `w` why, `/` focus filter, `c` focus commit, `?` toggle help. _Support:_ `review/useDiffKeyboard.ts`.
- **Jump-to-change / flash** — Scrolls a section (and a specific new-line row) into view and flash-highlights; toasts "Not in the current diff" on miss. _Support:_ `lib/diffJump.ts`.
- **Empty diff state** — "Nothing to review" or "N files staged" + guidance. _Support:_ `review/EmptyDiffState.tsx`.
- **"Why?" drawer (agent origin)** — Traces a file's edit to the agent turn (role, timestamp, model, message) that produced it; explains hand-written changes. _Support:_ `ReviewCanvas.WhyDrawer`; `listFileEdits` + `getMessage`.
- **Read-only DiffViewer (Direct reuse)** — Plain files→hunks renderer, no actions; shares `diffLineStyle` with the review surface. _Support:_ `DiffViewer.tsx`, `lib/diffLineStyle.ts`.

### File explorer (Files tab in review)
- **Changes ⇄ Files navigator** — Tab switcher (+ changed-count badge); collapses to a 44px icon strip (persisted). _Support:_ `ReviewSidebar.tsx`.
- **Lazy windowed file tree** — Flat-row model, per-folder lazy load (`readDirectory`), virtualized 24px rows; expansion/focus cached per workspace. _Support:_ `CompanionFileTree.tsx`, `lib/useVirtualRows`.
- **File-type icons + tints** — Category-based lucide icon + Atelier tint; changed files override to brass. _Support:_ `lib/fileIcons.ts`.
- **Show-ignored toggle** — Reveals `.gitignore`d files (persisted per root). _Support:_ `reviewPrefsStore.showIgnoredFiles`.
- **Tree filter** — Case-insensitive substring over loaded folders, keeps ancestors, highlights matches, count; Esc clears. _Support:_ `CompanionFileTree.tsx`.
- **Keyboard tree nav (roving tabindex)** — ↑/↓ move, →/← expand/collapse, Home/End, Enter/Space activate, ContextMenu/Shift+F10 menu. _Support:_ `CompanionFileTree.tsx`.
- **Context menu + file ops** — Reveal in Finder, Open in system, Open in terminal, Copy path + New file / New folder / Rename / Delete (with confirm). _Support:_ `FileTreeContextMenu`, `FileNameDialog`; `fsCreateFile/fsCreateDir/fsRename/fsDelete`.

### Code editor (CodeMirror 6)
- **Open files as tabs** — Opens via guarded read; existing tabs reactivate; binary/oversize handled. _Support:_ `editorStore.openFile`, `EditorTabs.tsx`, `EditorPane.tsx`. _Entry:_ Files tree, diff `o`, AI finding "Edit", Changes "open in editor".
- **Editor tabs** — Filename, dirty dot, close button, active underline; keyboard nav (←/→/Home/End) + HTML5 drag-reorder; close → next-active fallback. _Support:_ `EditorTabs.tsx`, `editorStore`.
- **Per-tab state preservation** — Each tab's full `EditorState` (undo/cursor/scroll) cached and restored on switch. _Support:_ `EditorPane` `stateCache`.
- **Edit & save (⌘S)** — Manual save with external-change guard. _Support:_ `editorStore.saveActive`, `write_file`.
- **Syntax per language** — 10 languages + plaintext: javascript (ts+jsx), rust, python, java, json, markdown, html, css, xml, yaml. _Support:_ `lib/editorLang.ts`.
- **Atelier syntax theme** — Keywords/types/tags=brass, strings/operators=sage, numbers=rouge, comments=mute, functions=ivory; rebuilt live from CSS tokens on `octo:theme`. _Support:_ `editor/atelierTheme.ts`.
- **Find / replace overlay (⌘F)** — Floating card: match case, whole word, regex, "n of m" tally, next/prev, replace, replace all; seeds from selection. ⌘G/F3 next/prev still work. _Support:_ `editor/EditorSearch.tsx`.
- **Multi-cursor / select-all-occurrences (⌘⇧L)** — One cursor per occurrence; plus rectangular selection (Alt-drag), `⌘D` next-occurrence. _Support:_ `editor/multiCursor.ts`.
- **Diff gutter** — Brass bar on added lines; rouge `▾` with deletion-run count on removed-after lines. _Support:_ `editor/diffGutter.ts`.
- **Blame gutter** — Per-line `shaShort author` (collapsing same-commit runs); native tooltip; global "Toggle blame" command; re-fetches on switch/save. _Support:_ `editor/blameGutter.ts`, `blameStore.ts`, `blame_file`.
- **Editor status bar** — Language dot, Ln/Col, "N selections", "blame: saved version" note, "disk changed" chip; right: Spaces (cycle), Wrap, Ln#, font −/Aa/+. _Support:_ `EditorStatusBar.tsx`, `editorPrefsStore`.
- **Open-at-line reveal** — One-shot cursor placement + center-scroll once the file is active. _Support:_ `editorStore.pendingReveal`.
- **Binary file pane** — "§ Binary", name, size, reason, Reveal in Finder / Open in system. _Support:_ `EditorBinaryPane.tsx`.

### Editor reliability & file I/O
- **Guarded read** — Sniffs for NUL (binary), 50 MB cap, UTF-8 validation; returns Text / Binary / UnsupportedEncoding / TooLarge. _Support:_ `read_file_checked`.
- **Large-file confirm** — Files >2 MB prompt before opening; "TooLarge" re-reads with no cap on confirm. _Support:_ `editorStore`, `App.confirmLargeFile`.
- **External-change detection** — On focus / tab re-visible, stat (`file_meta`) vs tracked mtime; clean buffers silently reload, dirty buffers flag the "disk changed" chip. _Support:_ `editorStore.checkActiveAgainstDisk`.
- **Save conflict dialog** — When disk changed/deleted under a dirty buffer, ⌘S opens a 3-way ConfirmDialog (Overwrite / Reload / Keep editing). _Support:_ `editorStore.saveConflict`.
- **Save-failure toast** — Write errors surface. _Support:_ `editorStore.saveActive`.

### Editor preferences (persisted)
- **Soft wrap / Font size / Tab width / Line numbers** — Toggles + steppers; live-reconfigure via CodeMirror compartments; persisted as `octo-editor-prefs` in localStorage. _Support:_ `editorPrefsStore.ts`.

### AI review pass
- **Request review** — Manual, one-shot model call over the working-tree `gitDiff` (not an agent). _Support:_ `aiReviewStore.run` → `ipc.aiComplete(model, AI_REVIEW_SYSTEM, buildReviewPrompt(diff), {jsonSchema})`. _Entry:_ toolbar Sparkles "AI" → drawer "Review this change ⟶".
- **AI drawer** — Slides over the diff (slim header, model picker, run/re-review CTA, finding count); collapse persisted per workspace. _Support:_ `review/AiReviewPanel.tsx`.
- **Per-workspace model picker** — Default `claude-sonnet-4-6`; persisted; reconciled against the live catalog. _Support:_ `aiReviewStore.modelFor/setModel`.
- **Structured findings** — `summary` + findings `{severity, category, title, detail, file, line}`; schema-forced tool call; tolerant `parseAiReview` fallback. _Support:_ `lib/aiReview.ts`.
- **Severities** — high (rouge), medium (amber), low (mute); ordered high-first. **Categories** — bug · missing-test · security · style · perf · other. _Support:_ `AiFindingCard`.
- **Finding → diff / editor** — `file:line ⟶` scrolls + flashes the diff; PenLine "Edit" opens the file in the editor at the line. _Support:_ `AiFindingCard`.
- **Stale detection** — Result cached by FNV-1a diff hash; "diff changed — re-run" when the changeset moves. _Support:_ `aiReviewStore`.

### AI-assisted conflict resolution
- **Resolve-with-AI** — Reads the conflicted file, asks the workspace's review model for a fully merged version, previews in mono, applies via `write_file` + `mark_conflict_resolved`; warns if markers remain; 48k-char limit. _Support:_ `ConflictAiModal.tsx`, `lib/aiConflict.ts`. _Entry:_ ChangesPanel conflict row → Sparkles.
- **Manual side-take + continue** — OURS/THEIRS (rebase-aware), open-in-editor, Continue/Abort. _Support:_ `ChangesPanel`, `resolveConflictTake` (see §6).

### Test runner drawer
- **Run tests** — Toolbar FlaskConical → popover test-command input; runs via login shell, 60s timeout. _Support:_ `ReviewCanvas.handleRunTests` → `run_test_command`.
- **Persist command** — Saved per workspace. _Support:_ `set_workspace_test_command`.
- **Auto-detect default** — package.json→`npm test`, Cargo.toml→`cargo test`, pytest→`pytest`. _Support:_ `detect_default_test_command`.
- **Result drawer** — Pass/fail "exit N" badge, selectable stdout/stderr; Esc dismisses. _Support:_ `review/TestDrawer.tsx`.

### Notable implementation details
- **AI primitive (`ai_complete`)** is the single shared one-shot model call for AI review, conflict resolution, and commit-message drafting. `resolve_provider(model)` routes to the Rust provider path; default review model `claude-sonnet-4-6`. With `json_schema` it forces a single named tool call; token usage recorded to `token_events` attributed to the workspace.
- **CodeMirror setup** — `EditorPane` hand-builds extensions (no `basicSetup`): gutters, drawSelection, rectangularSelection, history, bracketMatching, search, a custom keymap, language extension, themed via compartment, diffGutter, an updateListener pushing doc/line/col/selection-count; six live-reconfigurable compartments (blame, lineNum, tab, wrap, font, theme).
- **Diff parsing** — `parseFullDiff` (full review structure with `rawText` for `git apply -p1`) and `parseDiffForFile` (editor gutter markers).
- **Two diff surfaces stay in sync** via the shared `lib/diffLineStyle.ts`; three extension tables (`fileIcons`, `languageDetection`, `editorLang`) agree on `getExtension`.

---

## 6. Git & GitHub

### Git status & change detection
- **Working-tree status (libgit2)** — Branch, ahead/behind, has-upstream, conflict count, in-progress operation, and per-file `FileChange` (`path`, `status`, `staged`/`unstaged`/`conflicted` from libgit2 status flags; untracked included). _Support:_ `git_ops::status_files`/`get_status`; `get_git_status` (splits the cheap file-walk from the slow ahead/behind). _Entry:_ `ChangesPanel` polls every 5s.
- **Ahead/behind vs upstream (timed)** — Graph walk under a 3s timeout; on timeout sets `aheadBehindKnown=false` so the UI hides ↑/↓ rather than show a misleading 0. _Support:_ `git_ops::ahead_behind`.
- **In-progress operation detection** — Maps `RepositoryState` to `merge`/`rebase`/`cherry-pick`. _Support:_ `git_ops::operation_state`. _Entry:_ drives the conflict section + Continue/Abort.
- **Fast dirty check (rail)** — `is_dirty` (no untracked recursion) + `dirty_ahead_behind`. _Support:_ `git_ops`.
- **Per-workspace git summary (batch)** — One `WorkspaceGitSummary{dirty, ahead, behind}` per worktree; per-worktree timeouts; a single unreadable worktree defaults to clean. _Support:_ `workspaces_git_summary`. _Entry:_ rail chips.
- **Branch listing** — `{local, remote}` with the default (HEAD) branch promoted first; remote as `origin/dev`, `*/HEAD` excluded. _Support:_ `list_branches`. _Entry:_ GitOpsMenu, base picker.

### Diff reading (git operations side)
- **Working-tree diff** — `diff_index_to_workdir` with untracked synthesized as "new file" diffs, optional `ignore_whitespace`, capped at 1 MiB with a truncation marker. _Support:_ `get_git_diff`.
- **Staged diff** — HEAD-tree → index (`git diff --cached`). _Support:_ `get_staged_diff`. _Entry:_ AI commit-message drafting.
- **Commit log (paginated)** — First-parent revwalk, `skip`/`limit`; each `CommitInfo{sha, shaShort, summary, authorName, timestampMs}`. _Support:_ `git_log`. _Entry:_ `HistoryModal` (page 50).
- **Commit diff** — One commit vs its first parent (root vs empty tree). _Support:_ `commit_diff`. _Entry:_ click-to-expand in HistoryModal.
- **Last commit** — `(shortSha, subject, body)` of HEAD or null. _Support:_ `get_last_commit`. _Entry:_ amend prefill.
- **Blame** — Per-line blame vs HEAD; friendly errors for no-history / >1 MiB. _Support:_ `blame_file`. _Entry:_ editor gutter (§5).

### Staging & unstaging
- **Stage / unstage single file** — `git add` / `git restore --staged` (fallback `git reset HEAD`). _Support:_ `stage_file`/`unstage_file`. _Entry:_ Unstaged/Staged rows in ChangesPanel.
- **Stage all / unstage all** — `git add -A` / `git reset HEAD`. _Support:_ `stage_all_changes`/`unstage_all_changes`.
- **Stage / apply / revert hunk** — Tempfile + `git apply --cached`/`-p1`/`--reverse`. _Support:_ `stage_hunk`/`apply_hunk`/`revert_hunk` (§5 diff UI).

### Commit & amend
- **Commit staged changes** — `git commit -m '<escaped>'` through the user's **login shell** so gitconfig identity, hooks, and signing behave like the terminal; rejects empty; returns the new short SHA. _Support:_ `commit_changes` (holds git_lock). _Entry:_ Commit button / `c` shortcut.
- **Amend last commit** — `git commit --amend`; prefills subject+body from last commit; warns "Last commit is pushed — amending rewrites history" when ahead 0 + upstream. _Support:_ `amend_commit`. _Entry:_ "Amend last commit" checkbox.
- **AI-drafted commit message** — Fetches the staged diff, sends it (model `claude-sonnet-4-6`) with `COMMIT_SYSTEM` (≤50-char subject + optional body) and a 12k-char-capped prompt. _Support:_ `lib/commitMessage.ts`, `ChangesPanel.handleDraft` → `ai_complete`. _Entry:_ "✨ Draft" button.
- **Initial-commit healing** — On project open, ensures HEAD exists and captures on-disk files (fresh "Initial commit" or amends a legacy empty-tree HEAD). _Support:_ `git_ops::ensure_initial_commit`.

### Discard & file operations
- **Discard file** — Tracked → `git restore --staged --worktree`; untracked → drain index + delete worktree copy; containment guard refuses paths outside the workspace. _Support:_ `discard_file`; `ConfirmDialog`. _Entry:_ per-row `×`.
- **File-tree ops (rename/create-file/create-dir/delete)** — All via `contained_path` (refuses paths outside the workspace, the root itself, or anything with a `.git` component); create validates a single component. _Support:_ `fs_rename`/`fs_create_file`/`fs_create_dir`/`fs_delete`. _Entry:_ file-tree context menu.

### Push / pull / fetch (sync)
- **Push / publish branch** — Refuses detached HEAD, then `git push --set-upstream origin '<branch>'` via login shell. _Support:_ `push_branch`. _Entry:_ "Publish branch" / "Push to origin · N ahead".
- **Fetch** — `git fetch` via login shell, under git_lock. _Support:_ `fetch_changes`.
- **Pull (strategy-selectable)** — `--ff-only`/`--rebase`/`--no-rebase`; outcome classified `ok`/`diverged`/`conflict`/`error` via `classify_pull`. _Support:_ `pull`. _Entry:_ "Pull" button; diverged → Reconcile modal (Merge/Rebase).
- **Reconcile diverged** — Modal offering Merge or Rebase; re-runs the pull. _Support:_ `ChangesPanel`.

### Branch / stash / advanced ops (GitOpsMenu)
- **Switch branch** — `git switch` via login shell; worktree-aware friendly errors ("checked out in another workspace"). _Support:_ `switch_branch`. _Entry:_ GitOpsMenu branch list.
- **Create + switch branch** — Idempotent create (local/remote base) then switch. _Support:_ `create_and_switch_branch`. _Entry:_ "Create branch…" → `FileNameDialog` (`validateRefName`).
- **Stash push / list / pop / drop** — `git stash -u` (with optional message), newest-first list, pop (conflicts surface as error), drop. _Support:_ `stash_push`/`stash_list`/`stash_pop`/`stash_drop`. _Entry:_ "Stash changes…", "Stashes…" → `StashesModal`.
- **Clean untracked** — `git clean -fd` (with `LC_ALL=C`); returns removed paths. _Support:_ `clean_untracked`. _Entry:_ "Clean untracked…" → ConfirmDialog.
- **Reset HEAD** — `git reset --soft|--mixed|--hard <target>`. _Support:_ `reset_head`. _Entry:_ per-commit reset in HistoryModal → `ResetDialog`.
- **Cherry-pick** — `git cherry-pick` (no editor); conflict is a tagged outcome (enters cherry-pick state). _Support:_ `cherry_pick`. _Entry:_ per-commit cherry icon.
- **Tags create / list** — Lightweight tag at a SHA or HEAD; alphabetical list. _Support:_ `create_tag`/`list_tags`. _Entry:_ per-commit tag icon → `FileNameDialog` (`validateTagName`).

### Conflict resolution
- **Conflict section** — Shown when conflicted>0 or operation present; header "N conflicts · <op>"; during a **rebase** side labels swap (ours→UPSTREAM, theirs→MINE). _Support:_ `ChangesPanel`.
- **Take ours / take theirs** — `git checkout --ours|--theirs` then `git add`, under one git_lock. _Support:_ `resolve_conflict_take`. _Entry:_ OURS/THEIRS chips.
- **Mark resolved** — `git add` clears the unmerged state. _Support:_ `mark_conflict_resolved` (used by ConflictAiModal).
- **AI conflict resolution** — (See §5.) _Support:_ `ConflictAiModal.tsx`.
- **Continue / abort operation** — `git <op> --continue`/`--abort` (no editor); continue outcome `ok`/`moreConflicts`/`error`. _Support:_ `continue_operation`/`abort_operation`. _Entry:_ "Continue <op>" (only when conflicts cleared) / "Abort" → ConfirmDialog.

### GitHub & pull requests
- **PR-state model** — `PrState` enum `open`/`draft`/`merged`/`closed` collapsing GitHub's `state`+`draft`+`merged_at`; handles REST and `gh` shapes. _Support:_ `github.rs::pr_from_json`.
- **Find PR for current branch** — Reads branch + `origin` URL; bails for non-github.com / detached / no origin. Strategy: `gh pr list … --head` then REST fallback (auth: saved github.com PAT → `GITHUB_TOKEN`/`GH_TOKEN`; unauth OK for public). _Support:_ `find_pr_for_branch`. _Entry:_ ContextHeader PR chip (polled per switch + 60s).
- **Open PRs for project (batch)** — `gh pr list --state open …`; never errors (empty on gh-missing/unauthed). _Support:_ `open_prs_for_project`. _Entry:_ rail PR indicators (15s throttle).
- **List PRs ("start from a PR")** — `gh pr list …`; friendly empty state if gh missing. _Support:_ `list_prs`. _Entry:_ `PrPicker` in WorkspaceCreator.
- **Ensure PR branch (fetch head)** — No-op if the branch exists, else `git fetch origin 'pull/<n>/head:<branch>'` (works for fork PRs). _Support:_ `ensure_pr_branch`.
- **Save git credentials** — Persists `{username, token}` per host to `~/.octopush/settings.json`. _Support:_ `save_git_credentials`. _Entry:_ Settings; consumed by PR lookups and clone.

### Notable implementation details
- **git2 vs shell-out boundary** — Read/inspect ops use libgit2 (status, diffs, log, blame, branch/stash list, create_branch, tags, worktree lifecycle). Mutating/auth-sensitive ops shell out so they inherit the user's full git environment: commit, amend, push, fetch, pull, switch, cherry-pick, continue/abort, reset, clean, stage/unstage, hunk apply, conflict take, discard, PR-branch fetch.
- **Auth model** — Push/pull/fetch/switch/commit/cherry-pick/continue/abort run via the user's **login shell** (`$SHELL -l -c`) so SSH agents, the osxkeychain helper, and `~/.gitconfig` behave as in a terminal. Clone uses a `GIT_ASKPASS` tempfile reading the saved PAT. PR lookups use the saved github.com PAT or `GITHUB_TOKEN`/`GH_TOKEN`, preferring `gh`.
- **The git lock** — `git_lock.rs` keeps a global per-path async mutex so two mutating ops on the same worktree can't interleave; read-only commands take no lock.
- **PR state classification** lives entirely in `github.rs`; the frontend only maps `PrState` → color/glyph. The pure classifiers (`classify_pull`, `classify_continue`, `friendly_switch_error`, `pr_from_json`, `parse_git_url`) are heavily unit-tested.

---

## 7. Terminals, PTY Daemon & Sessions

### PTY Daemon — out-of-process architecture
- **Standalone PTY daemon (`octopush-pty-server`)** — A separate Rust binary that owns ALL pseudo-terminals so shells survive Octopush restarts/auto-updates. _Support:_ `src-tauri/src/bin/octopush-pty-server/*`; bundled as a sibling binary. _Entry:_ auto-spawned on app launch by `pty_daemon::ensure_daemon_running()`.
- **Detached spawn** — Launched with `setsid()` + null stdio so it escapes Octopush's process group and is adopted by launchd. _Support:_ `pty_daemon.rs::spawn_detached`.
- **Binary resolution** — Sibling of `current_exe()`, then `$PATH`, then `target/debug/…`. _Support:_ `resolve_daemon_binary`.
- **Unix domain socket** — Newline-delimited JSON-RPC at `~/.octopush/pty-server.sock` (chmod 0700). _Support:_ `pty_daemon.rs`, `main.rs`.
- **PID-file double-start protection** — `~/.octopush/pty-server.pid`; a second instance verifies the PID is alive AND is an `octopush-pty` process before exiting. _Support:_ `main.rs::acquire_pid_file`.
- **Protocol version handshake / stale-daemon replacement** — Reuses a running daemon across version bumps if `protocol_version` matches (`EXPECTED_PROTOCOL_VERSION = 2`); on mismatch SIGTERMs the old daemon and spawns the new one. _Support:_ `query_daemon_protocol`, `kill_existing_daemon`.
- **Idle auto-exit** — Exits when zero live PTYs AND zero clients for `OCTOPUSH_PTY_AUTO_EXIT_SECS` (default 3600s). _Support:_ `server.rs` idle thread.
- **Clean shutdown + crash recovery** — SIGTERM/SIGINT removes pid/socket; a stale socket is unlinked on startup; orphan scrollback logs swept. _Support:_ `main.rs`, `storage.rs`.
- **fd-limit raising** — Raises `RLIMIT_NOFILE` so terminal spawns don't fail with EMFILE. _Support:_ `main.rs::raise_fd_limit`.
- **Daemon log** — `~/.octopush/pty-server.log`, rotated at 5 MiB. _Support:_ `storage.rs`.

### Daemon socket protocol
- **Request methods** — `list_terminals`, `spawn`, `attach{since_seq?}`, `detach`, `write`, `resize`, `kill{signal?}`, `remove`, `shutdown`, `version`. _Support:_ `protocol.rs`, `server.rs::dispatch`.
- **Streaming events** — `data{id,seq,bytes}`, `exit{id,code?}`, `error{id,message}`, `attention{id}`. _Support:_ `protocol.rs::Event`.
- **Per-connection model** — Each connection on its own thread; a writer thread drains an unbounded channel; on disconnect, only that connection's attachments detach. _Support:_ `server.rs::handle_connection`.

### Scrollback persistence & replay
- **Dual buffering: ring + disk** — Each chunk gets a monotonic `seq`, stored in a 64 KiB ring buffer AND appended to a disk log. _Support:_ `session.rs::push_output`.
- **Disk-backed log** — `~/.octopush/pty-state/<id>.log`, capped at 1 MiB by rotation. _Support:_ `storage.rs`.
- **Scrollback replay on attach** — Atomic snapshot under the lock: full disk log replay if `since_seq` is older than the ring, else ring backlog; live data streams after with no overlap. _Support:_ `server.rs::cmd_attach`.
- **Sessions outlive their shells** — A session is kept after its shell exits (for replay) but its fds are released eagerly. _Support:_ `server.rs`, `session.rs`.

### Spawning, attaching & terminal lifecycle (daemon side)
- **Spawn a shell** — Opens a PTY via `portable_pty`, launches `$SHELL` (or `/bin/zsh`) as a login shell in `cwd` with a curated env allowlist + `TERM`/`COLORTERM`, then merges caller env. _Support:_ `server.rs::cmd_spawn`.
- **Duplicate-id / respawn-in-place** — A spawn for a live id is refused; an EXITED id is replaced in place (log deleted, seqs restart). _Support:_ `cmd_spawn`.
- **Write / resize / kill / remove** — base64 write; PtySize resize; SIGTERM/SIGKILL kill (session retained); `remove` SIGKILLs the process group + deletes the log. _Support:_ `cmd_write`/`cmd_resize`/`cmd_kill`/`cmd_remove`.

### Attention detection (daemon-side)
- **"Waiting for input" detection** — A 1s thread fires `Event::Attention` on (A) command-finished (fg pgroup returns to the shell) or (B) TUI-parked (fg child <1% CPU for two ticks + ≥2s quiet). _Support:_ `server.rs` attention thread, `session.rs::check_attention`.
- **False-positive gating** — Requires ≥200 bytes since last alert; a 3s post-attach grace; baselines wiped on attach. _Support:_ `session.rs`.

### App-side daemon client
- **`DaemonClient`** — One `UnixStream`; a reader thread multiplexes responses (per-`reqid` waiters, 5s timeout) and per-terminal event subscribers. _Support:_ `pty_client.rs`.
- **Single-subscriber-per-terminal routing** — A re-attach replaces the prior subscriber so each byte renders once. _Support:_ `pty_client.rs::attach`.
- **Self-healing reconnect** — On socket EOF the next call re-runs `ensure_daemon_running()` and swaps in a fresh socket. _Support:_ `try_reconnect`.
- **Stub client (degraded mode)** — If the daemon binary is absent, a pre-broken stub lets Octopush still launch and heals on first reconnect. _Support:_ `pty_client.rs::stub`.
- **`PtyManager` + Tauri event bridge** — Forwards `TermEvent`s as `pty://data`/`pty://exit`/`pty://attention`/`pty://reattached`. _Support:_ `pty_manager.rs`.
- **`spawn_or_attach` + `OutputHook`** — Reattaches a running id (replays scrollback) or spawns fresh; an optional `OutputHook` runs per chunk for token scanning. _Support:_ `pty_manager.rs`.

### Backend commands & session model
- **Session commands** — `create_session` (UUID, ContextGuard env, token hook, mark Active), `list_sessions`, `write_to_session`/`write_text_to_session`, `resize_session`, `kill_session`, `delete_session`. _Support:_ `commands.rs`.
- **Terminal commands (Run mode)** — `list_terminals`, `create_terminal`, `rename_terminal`, `delete_terminal` (DB-first, then daemon `remove`). _Support:_ `commands.rs`; `terminals` table.
- **PTY-bridge commands** — `spawn_or_attach_terminal` → `{mode:"Spawned"|"Reattached", pid?}`; `list_pty_sessions` (swallows daemon errors → empty for graceful degradation). _Support:_ `commands.rs`.
- **Session record & statuses** — `Session{id, name, color, icon, project_root, agent(provider/model/…), token_budget, tokens_used, status, context_files, tags, …}`; status `Active|Idle|Paused|Completed|Error`. _Support:_ `session.rs`.

### Session restore & env injection
- **`restore_active_sessions`** — On `.setup()`, re-spawns a PTY for each `Active`/`Idle` session, re-applying ContextGuard env + the token hook; marks `Error` on failure. _Support:_ `lib.rs`.
- **`ContextGuard::auto_configure`** — Produces the isolated PTY env: `HISTFILE` (per-session isolated history), `OCTOPUS_PROJECT_TYPE` (Rust/Node/Python/Go/Java/Ruby/Unknown), `OCTOPUS_GIT_BRANCH`. _Support:_ `context_guard.rs`.
- **Context-file detection** — Detects `CLAUDE.md`, `.claude/settings.json`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`, `CONVENTIONS.md` (stored on the session, not exported). _Support:_ `context_guard.rs`.
- **`OCTOPUS_MODEL` injection** — `create_session` injects the model id so CLI agents can read it. _Support:_ `commands.rs`.
- **Token-scan output hook** — The per-chunk `OutputHook` runs `token_engine::scan_pty_output` → `TokenEngine.record`. _Support:_ `commands.rs`, `lib.rs`.

### xterm.js front-end (TerminalPane)
- **Terminal instance** — `@xterm/xterm` with cursorBlink, JetBrains Mono, shared `XTERM_THEME` (Onyx bg, purple cursor, full ANSI palette; RUN & TALK identical), 10000-line scrollback. _Support:_ `TerminalPane.tsx`, `lib/xtermTheme.ts`.
- **FitAddon + ResizeObserver** — Fits xterm; debounced resize sends `resizeSession` only on actual change; refits on visible toggle + `layoutVersion` bumps. _Support:_ `TerminalPane.tsx`.
- **WebLinksAddon + file-path link provider** — Linkifies URLs; path-shaped tokens (with `:line[:col]`) become clickable links routing to Review/editor. _Support:_ `TerminalPane.tsx`.
- **Clipboard bridge** — Cmd-C / Ctrl-Shift-C / right-click-with-selection copy via `term.getSelection()`. _Support:_ `TerminalPane.tsx`.
- **Reattach SIGWINCH "wiggle"** — On `pty://reattached`, briefly resizes cols to force alt-screen TUIs (Claude Code/vim/htop) to redraw. _Support:_ `TerminalPane.tsx`.
- **Attention surfacing** — `pty://attention` and xterm's `onBell` ping `attentionStore` only when the pane is NOT visible. _Support:_ `TerminalPane.tsx`.
- **PTY survives unmount** — Cleanup disposes xterm but never kills the PTY; only the × button triggers `deleteTerminal`. App mounts a `TerminalPane` for EVERY `(workspace, terminal)` pair. _Support:_ `TerminalPane.tsx`, `App.tsx`.

### UI surfaces
- **CompanionTerminals** — Run-mode terminal list with status dots, `+`, inline rename, close, restored badge (see §1). _Support:_ `CompanionTerminals.tsx`.
- **SessionSidebar / NewSessionDialog** — The legacy "session" model UI: a session list with status dot, icon, name, project•model, cost•tokens, budget gauge, tags; new-session dialog with template/name/root/model (sets `OCTOPUS_MODEL`)/icon/color/tags. _Support:_ `SessionSidebar.tsx`, `NewSessionDialog.tsx` (predates the Atelier redesign). _Entry:_ ⌘T.

### Notable implementation details
- **Why out-of-process** — PTYs are owned by their spawner; the split lets shells survive app restarts/auto-updates (like JetBrains/VS Code). Protocol v2 forces a one-time daemon replacement that deploys the eager-fd-release + `remove` fixes; running a pre-v2 and v2 build simultaneously makes them fight over the single daemon.
- **Restart flow** — App quits → daemon + shells keep running. Relaunch → reconnect, `list_terminals` reconciles DB rows with live daemon ids (`running`/`restored`); each `TerminalPane` calls `spawn_or_attach` (replays scrollback, fires `pty://reattached`).
- **Env injection summary** — Curated host-env allowlist + `TERM`/`COLORTERM` (daemon) → `HISTFILE`/`OCTOPUS_PROJECT_TYPE`/`OCTOPUS_GIT_BRANCH` (ContextGuard) → `OCTOPUS_MODEL` (session create). Login shell in the project cwd.

---

## 8. Providers, Models, Tokens, Budgets & Usage

### Provider abstraction & wire protocols
- **`LlmProvider` trait** — One normalized `complete(api_base, api_key, req, client) -> LlmResponse` so `chat_engine`/`ai_complete`/orchestrator stay provider-agnostic. _Support:_ `providers/mod.rs` (`LlmRequest`, `LlmMessage`, `LlmContent`, `LlmBlock` {Text, Image}, `LlmTool`, `LlmResponse`, `LlmStopReason`).
- **Anthropic protocol adapter** — POSTs `{base}/v1/messages` with `x-api-key`, `anthropic-version`, output-128k beta; maps tools to `input_schema`, images as base64; parses `usage` incl. cache-read/creation. Requires a key. _Support:_ `providers/anthropic.rs`.
- **OpenAI-compatible adapter** — POSTs `{base}/chat/completions` with optional `Authorization: Bearer` (skipped when key empty, for Ollama); tools as functions, images as data URLs; parses `tool_calls`, `finish_reason`, `usage`. Covers OpenAI, DeepSeek, Ollama, vllm, llama.cpp, LMStudio, LocalAI. _Support:_ `providers/openai_compat.rs`.
- **Rate-limit headroom parsing** — Anthropic remaining-input-tokens + reset → `RateLimitSnapshot` so the agentic loop paces itself. _Support:_ `anthropic.rs::parse_rate_limit`.
- **Transient-failure retry** — `complete_with_retry` retries only transient errors (429/529/5xx/dropped), honoring `retry-after`; capped exponential backoff (max 60s, `DEFAULT_MAX_RETRIES = 5`), interruptible by a director stop. _Support:_ `providers/mod.rs`.

### Provider & model catalog (`provider_router.rs`)
- **`ProviderConfig`** — `name`, `api_base`, `api_key_env`, `models`, `rate_limits`, `enabled`, `protocol` (anthropic | openai-compatible), `local` (true ⇒ UI hides key, base URL editable). Persisted to `~/.octopush/providers.json`. _Support:_ `provider_router.rs`.
- **`ModelInfo` (per model)** — `id`, `display_name`, `input_cost_per_m`, `output_cost_per_m`, `cache_read_cost_per_m`, `cache_creation_cost_per_m`, `max_context`, `supports_vision`, `supports_tools`, `tags` (curated pills). _Support:_ `provider_router.rs`.
- **Built-in provider defaults (4)** — **anthropic** (claude-opus-4-6 $15/$75, claude-sonnet-4-6 $3/$15, claude-haiku-4-5 $0.80/$4); **openai** (gpt-4o, gpt-4o-mini); **deepseek** (deepseek-chat, deepseek-reasoner); **ollama** (local, free: llama3.3, qwen2.5-coder, deepseek-r1). _Support:_ `builtin_providers()`.
- **Catalog load + migrations** — `ProviderRouter::load()` seeds defaults on first run and applies on-disk migrations (protocol coercion, re-enable, backfill cache costs/tags/models, append missing builtins); reloaded fresh on every request (edits apply to the next message, no restart). _Support:_ `provider_router.rs::load`.
- **`list_models` (enabled-only, cost-sorted)** / **`find_model`** / **`suggest_model(TaskType)`** (8 task types → opus/sonnet/haiku with reason + cost tier) / **`validate_providers`**. _Support:_ commands `list_models`, `suggest_model`, `save_providers`, `get_default_providers`.
- **API keys & base-URL overrides stored separately** — keys/overrides live in `~/.octopush/settings.json` (`providerKeys`, `providerBaseUrls`), NOT in providers.json.

### Provider/Model management UI (Settings → Models)
- **Master-detail editor** — Provider list + detail pane; an "Unsaved changes" bar appears when the working copy diverges; Save validates server-side then read-modify-writes settings.json (merging keys/baseUrls so it doesn't wipe other settings) and re-fetches models. _Support:_ `settings/ModelsPane.tsx`.
- **Provider detail** — local/cloud tag, API-key field (password + show/hide, hidden for local), Base URL field, Models list (id, $in/out, ctx, Edit/Remove), "Add a model", "Reset to defaults" / "Remove". _Support:_ `ModelsPane.tsx`.
- **Add a provider (2-step wizard)** — Name, protocol (Anthropic/OpenAI-compatible), "Runs locally" toggle; step II base URL. _Support:_ `settings/AddProviderDialog.tsx`.
- **Add/Edit model dialog** — id (dedup-checked), displayName, inputCostPerM, outputCostPerM, maxContext; preserves non-edited fields. _Support:_ `settings/ModelDialog.tsx`.
- **Remove provider/model confirmation** — Routed through `ConfirmDialog`; removing a provider prunes its keys/baseUrls. _Support:_ `ModelsPane.tsx`.
- **Pricing refresh footer** — "Pricing · {relative time}" + spin-on-fetch refresh; refuses while there are unsaved edits; "Updated X of Y". _Support:_ `ModelsPane.tsx`.

### Pricing engine
- **In-process pricing table** — `cost_per_token(model, TokenType)` for built-in ids incl. cache rates; unknown/local = $0. _Support:_ `token_engine.rs`.
- **Cost computation (two paths)** — `compute_cost` (hardcoded table) and `compute_cost_with_prices` (explicit `ModelInfo` prices; non-Anthropic cache billed at input rate); `record` prefers the catalog-price path. _Support:_ `token_engine.rs`.
- **Pricing refresh from LiteLLM** — Fetches BerriAI/litellm's `model_prices_and_context_window.json`, converts per-token → per-million, updates matching model ids in providers.json by exact id, hot-reloads the router, stamps `last_pricing_refresh`. _Support:_ `commands.rs::refresh_pricing`.
- **Inline per-message cost preview** — `estimatePerMessageCost` (assumes 30% output ratio), `formatPerMessageCost`. _Support:_ `lib/cost.ts`.

### CLI agent adapters (`agent_adapter.rs`)
- **`AgentAdapter` trait** — `name`, `display_name`, `build_command(model, cwd)`, `parse_token_usage`, `supports_hot_swap`. _Support:_ `agent_adapter.rs`.
- **Claude Code adapter** — `claude --model <model>`; token parsing via `scan_pty_output`; no hot-swap. **Aider adapter** — `aider --model <model>`; parses "Tokens: N sent, N received"; hot-swap true. **Custom adapter** — arbitrary command/args. _Support:_ `agent_adapter.rs`.
- **Adapter registry** — `list_adapters` → `AdapterInfo`. **`switch_agent`** — updates the session's `agent.model` in the DB; if a PTY is running the new model takes effect on restart (no live hot-swap yet). _Support:_ `commands.rs`.

### Token engine
- **`TokenEvent` schema** — `{session_id, timestamp, input/output/cache_read/cache_creation_tokens, model, cost_usd}` in the `token_events` table; `session_id` doubles as the workspace id. _Support:_ `token_engine.rs`, `db.rs`.
- **`TokenEngine::record`** — Computes cost if 0 (catalog-aware), inserts the event, increments the session aggregate. _Support:_ `token_engine.rs`.
- **Two recording modes** — **API usage** (authoritative): chat engine + `ai_complete` record real counts. **PTY scraping** (best-effort): `scan_pty_output` matches an embedded `usage` JSON block or a Claude-Code "Total cost: …" summary line. _Support:_ `chat_engine.rs`, `commands.rs`, `token_engine.rs`.
- **`token_report`** — `TokenReport{total_input/output/cached, total_cost, cost_by_session, cost_by_model, hourly_trend, budget_remaining, projected_daily_cost}`. _Support:_ `db.rs`; `get_token_report`; `tokenStore.ts`.
- **Per-session token budget (legacy)** — `budget_status(session_id)` token-count gauge; `set_token_budget`. _Support:_ `token_engine.rs`.
- **Session export** — `export_session_json`/`export_session_csv`. _Support:_ `commands.rs`.

### Budgets (dollar-based, scoped, enforced)
- **`BudgetRow` schema** — `{scope_type, scope_id, period, limit_usd}` keyed unique on (scope, id, period). Scopes: `global`/`workspace`/`project`; periods: `daily`/`monthly`. _Support:_ `db.rs`; `list_budgets`/`set_budget`/`clear_budget`.
- **`period_spend`** — Sums `cost_usd` + tokens since start of day/month UTC per scope. _Support:_ `db.rs`; `current_spend`.
- **Budgets store** — Caches spend per `scope:id:period`, tracks `notifiedThresholds`, `overrideActive`. _Support:_ `budgetsStore.ts`.
- **Hard-cap enforcement** — Before a TALK send, `isOverBudget("workspace") || isOverBudget("global")` blocks with `BUDGET_CAP_MSG`; a one-shot per-turn Override. _Support:_ `chatStore`, `budgetsStore`.
- **Threshold warning toasts (50/80/100%)** — On each finished stream, fires once per (scope:period:threshold). _Support:_ `App.tsx`.
- **Budgets UI (Settings → Usage)** — "Add a budget" (scope/period/limit), grouped rows with inline-editable limit, "Spent: $X · N%", a tinted progress bar, Remove. _Support:_ `settings/UsagePane.tsx`.

### Usage analytics & charts (Settings → Usage)
- **Live polling dashboard** — Polls `getTokenReport` + `getUsageBreakdown` (rolling 30-day) every 10s. _Support:_ `UsagePane.tsx`.
- **Headline stats** — Cost, Tokens, Projected/day, Cache hit %. **Cloud vs local (30d)** — Cloud spend, Local volume (tokens), Est. savings. _Support:_ `UsagePane.tsx`; `get_usage_breakdown`.
- **Burn-rate area chart (24h)** / **Cost-by-session bar chart** / **Cost-by-model list** / **Budget gauge** / **Token breakdown** — Recharts via `useChartColors` (live theme colors). _Support:_ `UsagePane.tsx`.
- **CSV export ("Export ledger")** — Date range → `exportTokenEventsCsv` → save dialog. Header `timestamp,workspace_id,model,input_tokens,output_tokens,cost_usd`. _Support:_ `UsagePane.tsx`; `export_token_events_csv`.

### Model picker / switcher
- **ModelPicker** — Chip dropdown (provider-color dot): Local-only filter, Recommended (depth/speed/cost), Recents (last 3), per-provider groups with `$in/$out · ctx` + tag pills; optional `allowedProviders` (e.g. CLI stages → Anthropic). _Support:_ `ModelPicker.tsx`. _Entry:_ TALK composer, Direct stage flow.
- **ModelSwitcher** — Titlebar popover grouped by provider with a cost badge ($/$$/$$$) + meta; selecting calls `switchAgent`. _Support:_ `ModelSwitcher.tsx`. _Entry:_ titlebar (⌘⇧M).

### "Zero wasted tokens / cost savings" value proposition
- **All-premium savings baseline** — Savings computed against the priciest configured model for the tokens actually used; `savingsVsBaseline` floored at $0; `aggregateSavings` across runs. _Support:_ `lib/runStatus.ts`.
- **TALK SavingsLedger** — "saved vs {model} · $X · N%" over "spent $X". _Support:_ `SavingsLedger.tsx`.
- **Direct run ledger** — "{pct}% under all-premium"; completion "This run saved $X…". _Support:_ `RunLedger.tsx`.
- **Local-model savings estimate** — `usage_breakdown` classifies cloud/local and estimates local savings at a blended cheapest-cloud rate (~$0.21/M). _Support:_ `db.rs::usage_breakdown`.
- **Tagline** — "The IDE for agentic developers — eight arms, zero wasted tokens." _Support:_ `settings/AboutPane.tsx`.

### Notable implementation details
- **Two protocols, not N vendors** — Adding any vendor/gateway means choosing `anthropic` or `openai-compatible`; no per-vendor code.
- **Two stores split** — providers.json (catalog incl. pricing/context) vs settings.json (`providerKeys`, `providerBaseUrls`, `last_pricing_refresh`). Keys never leave the device except in requests to providers.
- **Token-event schema** — a single `token_events` table; `session_id` is the workspace id, so project-scope budgets/savings join `token_events → workspaces`.
- **Budget enforcement has three points** — pre-send hard gate, one-shot override, post-turn threshold toasts. Two budget systems coexist: dollar-scoped budgets (the live UX) and a legacy per-session token budget (the token "remaining" gauge).
- **PTY token scraping is best-effort and fragile by design** — the authoritative path is API usage recorded by `chat_engine`/`ai_complete`.

---

## 9. Integrations: Jira, MCP & Skills

Four distinct integration surfaces: (1) Jira issue tracking, (2) Octopush as an MCP **client** (connecting out to other MCP servers), (3) "Connect to Claude Code" (registering Octopush's own MCP server), (4) the standalone `octopush-mcp` **server**. Plus Skills.

### Jira — backend
- **Tracker-agnostic `Issue` model** — Normalized shape: `key, summary, statusName, statusCategory, issueType, priority?, url, parentKey?, subtask, hierarchyLevel`, + inline `blocks`/`blockedBy`/`subtasks`. _Support:_ `issue_tracker/mod.rs` (`IssueTracker` trait).
- **Status category normalization** — Jira `statusCategory.key` → Todo/InProgress/Done/Unknown. _Support:_ `status_category_from_key`.
- **"My issues" JQL** — `assignee = currentUser() AND statusCategory != Done ORDER BY status, priority`. _Support:_ `my_issues_jql()`.
- **Branch→key detection (Rust)** — Extracts the first `[A-Z][A-Z0-9]+-<digits>` key from a branch. _Support:_ `detect_issue_key`.
- **Jira Cloud auth (HTTP Basic)** — `base64(email:api_token)`; config `{baseUrl, email, apiToken}`. _Support:_ `issue_tracker/jira.rs`.
- **Endpoints** — `list_my_issues` (`POST /rest/api/3/search/jql`), `get_issue` (`GET /rest/api/3/issue/{key}` with issuelinks+subtasks), `list_issues_in_epic` (`parent = EPIC` with a legacy `"Epic Link"` fallback). _Support:_ `jira.rs`.
- **Link parsing** — Blocks/blocked-by from `issuelinks` (only "Blocks" type); subtasks from the inline array. _Support:_ `parse_issuelinks`, `parse_subtasks`.
- **Credential storage** — Token in `~/.octopush/settings.json` under `issueTracker`. _Support:_ `settings.rs`.
- **Commands** — `list_my_issues`, `get_issue`, `list_issues_in_epic`, `get_issue_tracker_config`, `save_issue_tracker_config`, `update_workspace_link`, `update_project_jira_key`. _Support:_ `commands.rs`.

### Jira — frontend
- **`issuesStore`** — Assigned-not-done list (`load()`), per-key detail cache (`loadDetail` — the only place links/subtasks exist), epic-backlog cache (`loadEpic`). _Support:_ `issuesStore.ts`.
- **`parentIssuesStore`** — `loadParent`/`loadAncestors(key, depth)` for the parent chain. _Support:_ `parentIssuesStore.ts`.
- **`useActiveIssue(key)`** — Resolves an issue preferring the detail cache; one network call per active-key change. _Support:_ `hooks/useActiveIssue.ts`.
- **Branch→key detection (TS mirror)** — `detectIssueKey` + `detectIssueKeyForProject` (only accepts a key matching the project prefix). _Support:_ `lib/detectIssueKey.ts`.
- **Linkage + selectors** — `resolveLinkage` (manual link wins → branch-detected → unlinked), `resolveJiraProjectKey`, `selectBacklog`/`selectBlocking`/`selectBlockedBy`/`selectSubtasksOrSiblings`/`selectEpicSiblings`/`resolveEpicKey`/`selectElsewhereIssues`; `issueTypeToken` (type → color). _Support:_ `lib/issueTrackerSelectors.ts`.

### Jira — UI surfaces
- **Active-ticket header / PR chip** — See §1 (ContextHeader). _Support:_ `ContextHeader.tsx`.
- **WorkContext pills panel + workspace jump chip + Elsewhere** — See §1 (Companion). _Support:_ `WorkContextPanel.tsx`, `ElsewhereFooter`/`ElsewhereModal`.
- **Backlog row context menu** — Right-click a Mine row → "Create workspace". _Support:_ `BacklogRowContextMenu.tsx` → `App.startCreateForTicket`.
- **Inline ticket picker** — Scope toggle (PROJECT vs All), fuzzy search over cached tickets, exact-key fallback (verified via `getIssue`). _Support:_ `InlineTicketPicker.tsx`.
- **Jira ticket picker modal / project-key modal** — Link/Change/Unlink a ticket; set/clear a project's Jira key. _Support:_ `JiraTicketPickerModal.tsx`, `JiraProjectKeyModal.tsx`.
- **Settings → Issue tracking** — Master-detail: tracker list (Jira active; Linear & Azure DevOps "Soon"); Jira detail (Base URL / Email / API token + show-hide) + per-project Jira-key inputs. _Support:_ `settings/IssueTrackingSection.tsx`.

### In-app MCP client (Octopush → other MCP servers)
- **Config shape & sources** — Claude-Code-compatible `{ "mcpServers": { "<name>": { command, args, env } } }` from `~/.claude/mcp.json` (user) ∪ `<worktree>/.claude/mcp.json` (project overrides user). _Support:_ `mcp/mod.rs`.
- **stdio JSON-RPC client** — Newline-delimited JSON-RPC 2.0; handshake `initialize` → `notifications/initialized` → `tools/list`; replies method-not-found to server→client requests. _Support:_ `mcp/mod.rs`.
- **Tool namespacing** — Tools surface as `mcp__<server>__<tool>`. _Support:_ `mcp/mod.rs`.
- **Lazy registry with failure memory** — Servers spawned on first use, cached for app lifetime; a failed server is skipped that session; a dead connection is evicted on call error. _Support:_ `McpRegistry`.
- **Test connection** — `test_connect` spawns + handshakes + lists tools without touching the cache. _Support:_ `McpRegistry::test_connect`.
- **Commands** — `list_mcp_tools`, `list_mcp_servers`, `get_mcp_config`, `save_mcp_config`, `test_mcp_server` (15s timeout). _Support:_ `commands.rs`.
- **Settings → MCP Servers** — Per-row card (Test / Remove) + add-form (Name/Command/Args/Env); duplicate-name guarded; note about `npx mcp-remote <url>` for remote servers. _Support:_ `settings/McpServersSection.tsx`.

### "Connect to Claude Code" (Octopush's server → Claude Code config)
- **One-click registration** — Removes any existing `octopush` entry then `claude mcp add octopush -s user -- <binary>` (idempotent across upgrades). _Support:_ `mcp_setup.rs::connect`.
- **Binary & CLI resolution** — `octopush-mcp` sibling-of-exe → `$PATH` → dev trees; `claude` via `$PATH` → well-known absolute locations (GUI apps don't inherit shell PATH). _Support:_ `resolve_mcp_binary`, `resolve_claude_cli`.
- **Status + manual fallback** — `McpStatus{binaryPath?, binaryFound, claudeFound, registered, manualCommand}`; always hands back a copy-pasteable `claude mcp add …`. _Support:_ commands `mcp_connection_status`, `connect_claude_code`.
- **Settings "Coding Agents" card** — Connected/Not-connected dot, "Connect/Reconnect" button, read-only manual command + Copy. _Support:_ `IntegrationsPane.tsx` `ClaudeCodeCard`.

### The `octopush-mcp` standalone server binary
- **What/transport/scope** — A sidecar `[[bin]]` exposing a **read-and-author-only** slice of Octopush over JSON-RPC 2.0 stdio, reusing `octopush_lib::db` against the same SQLite store (WAL-safe while the app is open). **Never executes runs, spends tokens, or mutates a git tree.** _Support:_ `bin/octopush-mcp/main.rs`; doc `docs/octopush-mcp.md`.
- **Protocol handshake** — Negotiates version (latest `2025-06-18`; also `2025-03-26`, `2024-11-05`), advertises `tools`, returns `instructions`; tool errors in-band (`isError: true`). _Support:_ `protocol.rs`.
- **Exposed tools (13)** — _reference:_ `describe_pipeline_schema`. _read:_ `list_pipelines`, `get_pipeline`, `list_projects`, `list_workspaces`, `get_workspace`, `list_runs`, `get_run`. _author:_ `create_pipeline` (validated DAG), `update_pipeline` (forks a builtin / edits a custom), `delete_pipeline` (builtins protected), `link_workspace_issue` (metadata-only), `create_run` (stages a DIRECT run in **`draft`** — not started). _Support:_ `tools.rs`.
- **Pipeline authoring contract** — Same `§3.7` validator as the app's `save_pipeline` (roles, loops on review roles, acyclic parents, substrate, tools subset, maxIterations 1..100, instructions ≤8000). _Support:_ `tools.rs`.
- **Registration & namespacing** — `claude mcp add octopush -- <binary>`; tools appear as `mcp__octopush__<tool>`. Roadmap (not v1): execution control-plane, workspace creation, TALK/REVIEW surfaces, issue-tracker reads. _Support:_ `docs/octopush-mcp.md`.

### Skills
- **Discovery** — `<name>/SKILL.md` from `<worktree>/.claude/skills/*` (project) and `~/.claude/skills/*` (user); project shadows user. _Support:_ `skills/mod.rs`.
- **Frontmatter parsing** — Hand-rolled (no YAML dep): requires a `---` fence; fields `name` (required), `description`, `allowed-tools`/`tools`. _Support:_ `skills/mod.rs::parse_skill`.
- **Command + chat usage** — `list_skills` → `SkillMeta[]`; a selected skill appends its body to the system prompt and optionally restricts the turn's tools. _Support:_ `commands.rs`, `chat_engine.rs`. _Entry:_ `/` SlashMenu (§3).

### Notable implementation details
- **Where config lives** — Jira creds in `settings.json`; per-project Jira key + per-workspace `linked_issue_key` in SQLite; MCP-client servers in `~/.claude/mcp.json` (user) + `<repo>/.claude/mcp.json` (project); skills in `.claude/skills/*`; Claude-Code registration of octopush-mcp lives in Claude Code's own user-scope config.
- **MCP registry/transport** — Two directions: **client** (Octopush spawns external stdio servers, lazy-cached, namespaced `mcp__server__tool`, routed in the chat loop) and **server** (Octopush *is* a stdio MCP server for terminal CLIs). Both hand-rolled JSON-RPC 2.0 over newline-delimited stdio.
- **octopush-mcp safety scope** — communicated three ways (server `instructions`, each tool's description, the doc): never executes, never spends tokens, never mutates git; runs land in `draft` for the user to launch from the app's DIRECT mode; drives the same DB whether or not the app is running.

---

## 10. Settings, Theming, Updates & Platform

### Settings shell & navigation
- **Settings overlay** — Full-screen overlay (not a modal); header eyebrow `Preferences` + serif `Octopus` + `ESC · CLOSE`. _Support:_ `Settings.tsx`. _Entry:_ top-bar gear; `⌘,` (General); `⌘⇧T` (Usage).
- **Grouped master-detail nav** — 4 groups: **Setup** (General, Editor), **Intelligence** (Models, Usage), **Connections** (Integrations), **App** (Appearance, Shortcuts, Privacy, About). Active tab brass; pane crossfades. _Support:_ `lib/settingsTabs.ts`, `Settings.tsx`.
- **Escape handling** — Capture-phase Esc closes but always `preventDefault`s (never exits macOS full-screen); defers to a stacked ModalShell; ignores Esc in inputs. _Support:_ `Settings.tsx`.

### Settings panes
- **General** — "Play sound when an agent or terminal needs attention" toggle. _Support:_ `GeneralPane.tsx`; `attentionStore`.
- **Editor** — Word wrap, Font size (10–22), Tab width (2/4/8), Line numbers, and an "Editor command" override (e.g. `code`/`cursor`; blank = autodetect, shows detected editors). _Support:_ `EditorPane.tsx`; `editorPrefsStore` + `settings.json`; `detectEditors`.
- **Appearance** — Theme picker: a 2-column grid of live-swatch cards built from each theme's palette; click applies instantly. _Support:_ `AppearancePane.tsx`; `themeStore`.
- **Usage** — Token/cost dashboard + budgets (see §8). _Support:_ `UsagePane.tsx`.
- **Shortcuts** — Read-only keymap reference (see Appendix C). _Support:_ `ShortcutsPane.tsx`.
- **Privacy** — Read-only statement: local-only data in `~/Library/Application Support/octopush/octopush.db`, API keys in `~/.octopush/settings.json`, outbound traffic only to configured providers, "No analytics, no telemetry." _Support:_ `PrivacyPane.tsx`.
- **About** — Installed version + Check for updates; renders the updater flow; footer links (GitHub repo, last-checked, Ed25519-signature note). _Support:_ `AboutPane.tsx`; `updaterStore`.
- **Integrations** — Hosts Issue tracking (§9), MCP Servers (§9), and the Claude Code "Connect" card (§9). _Support:_ `IntegrationsPane.tsx`.
- **Account (premium — P1 + P2)** — Sign in / out, reach Clerk's hosted account portal, and **upgrade to Pro**. Signed-out shows a "Sign in" CTA (which becomes "Waiting for your browser…" with a **Cancel** button while a sign-in is in flight); signed-in shows the identity, a **plan badge (Free/Pro)**, "Manage account ↗" (opens the Clerk portal) + "Sign out", and — when Free — an **"Upgrade to Pro"** button that opens a Dodo Payments checkout link in the browser. _Support:_ `settings/AccountPane.tsx`, `useAuth`/`useEntitlement` hooks, `authStore`; commands `auth_begin_sign_in`/`auth_cancel_sign_in`/`auth_status`/`auth_refresh`/`auth_sign_out`/`auth_account_portal_url`/`billing_checkout_url`. _Entry:_ Settings → Account (App group). _Mechanism:_ the OAuth 2.0 Authorization Code + **PKCE (S256)** **public-client** flow runs in the Rust core (`src-tauri/src/auth.rs`) — opens the system browser to Clerk, captures the redirect on a `127.0.0.1:8976` loopback (cancellable mid-flight) that serves a **branded Atelier confirmation page** (onyx/brass, distinct success + error states, dynamic text HTML-escaped), exchanges the code (**no client secret**), fetches `/oauth/userinfo`, and stores the session in the macOS **Keychain** (`keyring`). `auth_status` **silently refreshes** the access token when expired (signs out only on a revoked token, never on a transient/offline failure). **The plan rides on the OAuth session:** sign-in requests the Clerk **`public_metadata`** scope and reads `public_metadata.plan` (e.g. "pro") from userinfo into the session; `entitlement::current()` maps it to the entitlement (Pro = uncapped + all features). `auth_refresh` re-fetches userinfo to pick up a plan change after checkout. **"Upgrade"** (`billing.rs`) opens a Dodo **static checkout link** for the Test-Mode product, stamped with the user's email + `metadata_clerk_user_id` (so a server-side webhook can map the subscription back **by Clerk id, not email**) — the desktop holds **no payment secret**. The plan is set server-side by a **Dodo→Clerk webhook** (a Vercel Function in the separate `octopush-api` repo) on `subscription.active`/`cancelled`, and the **Free Direct-run cap (25/mo) is live** for non-Pro. Clerk/Dodo config is built-in (test) for now.
- **Shared pane primitives** — `PaneHeader`, `SectionLabel`, `ToggleRow`, `Stat`, `Row`, `useChartColors` (live CSS-var theme colors for Recharts). _Support:_ `settings/shared.tsx`.

### Theming
- **Backend theme store** — Themes persisted to `~/.octopush/theme.json`; absent → first built-in (`atelier`). _Support:_ `theme.rs`; `get_theme`/`set_theme`/`list_themes`.
- **`ThemeConfig`** — name + 14 color fields (bg, panel, panel_2, border, accent, accent_dim, success, warning, danger, text, text_dim, text_muted, terminal_bg). _Support:_ `theme.rs`.
- **9 built-in themes** — Brand default **atelier** (onyx/brass; first = default). Premium: **vellum** (only light theme), **mossbank**, **porcelain-indigo**, **ember**. Legacy: **dark**, **midnight**, **solarized-dark**. _Support:_ `theme.rs::builtin_themes`.
- **Theme application** — `themeStore.apply()` → `applyThemeToDom()` writes ~30 CSS custom properties on `document.documentElement` (legacy `--color-octo-*` + canonical semantic tokens), **derives accent-alpha + danger-alpha tokens from the live accent**, sets body bg for first paint, then dispatches an `octo:theme` event so CodeMirror/Recharts reconfigure. _Support:_ `themeStore.ts`.
- **`tokens.ts`** — Typed JS mirror of the static Atelier tokens (fonts, easing, durations) for runtime inline styles. _Support:_ `lib/tokens.ts`.

### Auto-update (tauri-plugin-updater)
- **Updater store** — Phases `idle|checking|available|no-update|downloading|installing|error`; `checkForUpdates(interactive)`, `installAndRelaunch()`. Background failures stay silent. _Support:_ `updaterStore.ts`.
- **UpdateNotifier toast** — Auto-checks on mount + every 6 hours; visible only when an update is available/installing/error; "What's new" link, progress bar, Later / Install & restart. Updates verified with an Ed25519 signature. _Support:_ `UpdateNotifier.tsx`.

### Performance monitor
- **Backend sampling** — `get_perf_stats` samples processes via `sysinfo` into three groups: **app** (main + macOS "responsible" WebKit helpers via FFI), **daemon** (`octopush-pty-server` only), **total** — each with `rss_bytes`, `cpu_pct`, `process_count`; plus home-volume disk free/total. Persistent `PerfState(Mutex<System>)` for CPU deltas. _Support:_ `perf.rs`; `get_perf_stats`.
- **Perf store + footer bar** — Polls every 2000ms (skips when hidden); `PerfMonitorBar` shows `⌗` total RSS · `CPU N%` · disk free, plus the rail-collapse toggle; a popover lists App + Daemon rows and workspace caches. _Support:_ `perfStore.ts`, `PerfMonitorBar.tsx`.

### Disk-cache / workspace-cache monitor
- **Backend cache scan** — `get_workspace_cache_sizes` sums known build/cache dirs (target, node_modules, dist, build, .next, .nuxt, .gradle, __pycache__, .venv, venv, .turbo, out). _Support:_ `perf.rs`.
- **Cache UI** — A "Workspace Caches" section in the perf popover. _Support:_ `PerfMonitorBar.tsx`.

### Scratchpad
- **Scratchpad store** — Multi-tab in-memory notes/code editor (`tabs{id,name,content,language}`, `activeTabId`); create/delete/rename/setContent/setLanguage. **No persistence** (session-scoped). _Support:_ `scratchpadStore.ts`.
- **Scratchpad UI** — Right column of a draggable split (`CanvasSplit`); `ScratchpadTabsBar` + `ScratchpadCodeEditor` (CodeMirror 6, live syntax for js/ts/python/rust/java/json/markdown/html/css/xml/yaml, shared atelierTheme); double-click to rename a tab, `+` adds. _Support:_ `ScratchpadEditor.tsx` et al. _Entry:_ top-bar NotebookPen / `ScratchpadIcon`.

### OS-integration / platform utilities
- **`open_file_in_system`** — OS default opener (macOS `open`, Linux `xdg-open`). _Entry:_ file-tree "Open with default app", issue URLs, "What's new".
- **`reveal_in_finder`** — `open -R` (macOS). _Entry:_ "Reveal in Finder".
- **`open_in_terminal`** — `open -a Terminal` (macOS); Linux terminal fallbacks. _Entry:_ "Open in terminal".
- **`detect_editors` / `open_in_editor`** — Detects VS Code (`code`), Cursor (`cursor`), Zed (`zed`), Sublime (`subl`), IntelliJ (`idea`) on PATH; opens via the configured override else the first detected, falling back to the system opener. _Entry:_ Editor pane + rail "Open in editor".

### Notable implementation details
- **Settings persistence (backend)** — `AppSettings` → `~/.octopush/settings.json` (pretty JSON, camelCase): `provider_keys`, `provider_base_urls`, `git_credentials`, `last_pricing_refresh`, `issue_tracker`, `editor_command`. Legacy `anthropicApiKey`/`openaiApiKey` migrated into `provider_keys`. Full-file last-write-wins (single-window app; callers read-modify-write).
- **Editor prefs persistence (frontend)** — `editorPrefsStore` uses zustand `persist` to `localStorage` (`octo-editor-prefs`); only the editor *command* round-trips through `settings.json`.
- **Theme tokens are runtime CSS variables**, re-derived per theme (incl. accent-alpha/rouge-alpha families) and broadcast via `octo:theme` so canvas/editor/chart surfaces stay in sync.

---

## Appendix A — Backend command index

All Tauri commands are registered in `src-tauri/src/lib.rs` (`invoke_handler`) and implemented in `commands.rs`. Grouped as in the source:

- **Sessions** — `create_session`, `list_sessions`, `write_to_session`, `write_text_to_session`, `resize_session`, `kill_session`, `delete_session`
- **Tokens** — `get_token_report`, `record_token_event`, `get_budget_status`, `set_token_budget`
- **Templates** — `list_templates`, `save_template`, `delete_template`
- **Providers / Agents** — `list_providers`, `list_models`, `suggest_model`, `list_adapters`, `switch_agent`
- **Recap / Export** — `get_session_recap`, `export_session_json`, `export_session_csv`
- **Theme** — `get_theme`, `set_theme`, `list_themes`
- **Projects** — `open_project`, `list_recent_projects`, `create_project`, `update_project_customization`, `set_project_pinned`, `set_project_order`, `close_project`, `list_closed_projects`, `reopen_project`, `delete_project`
- **Workspaces** — `create_workspace`, `list_workspaces`, `delete_workspace`, `archive_workspace`, `list_archived_workspaces`, `restore_workspace`, `update_workspace_customization`, `rename_workspace`, `update_workspace_link`, `update_project_jira_key`, `get_git_status`, `list_branches`, `workspaces_git_summary`, `get_git_diff`
- **Chat** — `send_chat_message`, `run_shell_command`, `stop_shell_command`, `list_chat_messages`, `cancel_chat`, `list_chat_threads`, `create_chat_thread`, `rename_chat_thread`, `delete_chat_thread`, `list_skills`, `read_attachment`, `list_mcp_tools`, `list_mcp_servers`, `get_mcp_config`, `save_mcp_config`, `test_mcp_server`
- **Direct mode** — `list_pipelines`, `get_pipeline`, `save_pipeline`, `delete_pipeline`, `create_run`, `start_run`, `get_run`, `list_runs`, `resolve_checkpoint`, `abort_run`, `stop_stage`, `request_run_pause`, `estimate_run_cost`, `get_stage_log`, `list_stage_iterations`
- **File operations** — `open_file_in_system`, `reveal_in_finder`, `open_in_terminal`, `open_in_editor`, `detect_editors`
- **Clone** — `clone_project`
- **Budgets** — `list_budgets`, `set_budget`, `clear_budget`, `current_spend`, `export_token_events_csv`
- **Usage / Pricing** — `get_usage_breakdown`, `refresh_pricing`
- **Settings** — `get_settings`, `save_settings`, `save_git_credentials`
- **Provider catalog** — `save_providers`, `get_default_providers`
- **Terminals / PTY** — `list_terminals`, `create_terminal`, `rename_terminal`, `delete_terminal`, `list_pty_sessions`, `spawn_or_attach_terminal`
- **Performance** — `get_perf_stats`, `get_workspace_cache_sizes`
- **Directory / File I/O** — `read_directory`, `read_file`, `read_file_checked`, `write_file`, `file_meta`
- **Review / edits** — `list_file_edits`, `get_message`
- **Hunks** — `revert_hunk`, `apply_hunk`, `stage_hunk`, `stage_all_changes`
- **Stage / commit / push** — `stage_file`, `unstage_file`, `unstage_all_changes`, `commit_changes`, `get_staged_diff`, `get_last_commit`, `git_log`, `commit_diff`, `blame_file`, `amend_commit`, `discard_file`
- **File ops** — `fs_rename`, `fs_create_file`, `fs_create_dir`, `fs_delete`, `push_branch`, `fetch_changes`, `pull`
- **Conflicts** — `resolve_conflict_take`, `mark_conflict_resolved`, `continue_operation`, `abort_operation`
- **Branch & stash** — `switch_branch`, `create_and_switch_branch`, `stash_push`, `stash_list`, `stash_pop`, `stash_drop`
- **Advanced git** — `reset_head`, `clean_untracked`, `cherry_pick`, `create_tag`, `list_tags`, `find_pr_for_branch`, `open_prs_for_project`, `list_prs`, `ensure_pr_branch`
- **Search** — `list_workspace_files`, `search_workspace_text`
- **Test runner** — `run_test_command`, `set_workspace_test_command`, `detect_default_test_command`
- **Issue tracker** — `list_my_issues`, `get_issue`, `list_issues_in_epic`, `get_issue_tracker_config`, `save_issue_tracker_config`
- **AI primitive** — `ai_complete`
- **MCP setup** — `mcp_connection_status`, `connect_claude_code`
- **Roles** — `list_roles`, `save_role`, `delete_role`
- **Entitlement (premium scaffolding)** — `get_entitlement`, `direct_run_usage`
- **Accounts (P1)** — `auth_begin_sign_in`, `auth_cancel_sign_in`, `auth_sign_out`, `auth_status`, `auth_refresh`, `auth_account_portal_url`
- **Billing (P2)** — `billing_checkout_url`

---

## Appendix B — Data model (SQLite)

Database at `~/Library/Application Support/octopush/octopush.db`; all schema + migrations in `src-tauri/src/db.rs` (additive `add_column_if_missing`). Principal tables:

- **projects** — id, name, path (UNIQUE), created_at, last_opened, jira_project_key, closed_at, pinned, sort_order, tint
- **workspaces** — id, project_id (FK CASCADE), name, task, branch, worktree_path, setup_script, status, created_at, last_active, glyph, tint, test_command, linked_issue_key, issue_link_dismissed, from_branch
- **sessions** — id, name, color, icon, project_root, agent config, token_budget, tokens_used/input/output, status, context_files, tags, created_at, last_active
- **terminals** — id, workspace_id (FK), label, position, created_at
- **chat_threads** — id, workspace_id (FK CASCADE), title, created_at, updated_at
- **chat_messages** — id, workspace_id (FK CASCADE), thread_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at
- **file_edits** — attribution of changed files to the chat message that produced them
- **pipelines** — id, name, description, is_builtin, created_at
- **pipeline_stages** — id, pipeline_id, position, role, agent_model, substrate, checkpoint, max_iterations, pos_x, pos_y, parents, tools, custom_name, instructions, loop_target_position, loop_max_iterations, loop_mode
- **runs** — id, workspace_id, pipeline_id, task, status, cost_usd, baseline_cost_usd, reference_model, retired_cost/tokens, budget_usd, linked_issue_key, timestamps
- **run_stages** — private per-run copy of stages + status, tokens, cost, artifact, feedback, error, loop_iterations, diff_snapshot, session_id, resume_pending, baseline_commit
- **roles** — key, label, description, prompt_body, artifact_kind, environment, can_loop, default_tools, default_substrate, default_checkpoint, token estimates, is_builtin
- **stage_log** — persisted live-journal entries per run stage (incl. reset markers)
- **stage_iterations** — archived stage attempts (ordinal, role, model, status, artifact, error, cost, tokens, closing_feedback, diff_snapshot)
- **run_events** — append-only run audit log
- **token_events** — session_id (= workspace id), timestamp, input/output/cache_read/cache_creation tokens, model, cost_usd
- **budgets** — scope_type, scope_id, period, limit_usd, updated_at (UNIQUE on scope_type+scope_id+period)

---

## Appendix C — Keyboard shortcuts

Global shortcuts are owned by a single `keydown` listener in `src/App.tsx`. (The Settings → Shortcuts pane documents a curated subset.)

| Shortcut | Action |
|---|---|
| `⌘1` … `⌘9` | Switch to workspace N |
| `⌘⇧1` / `⌘⇧2` / `⌘⇧3` | Talk / Run / Review mode |
| `⌘⇧D` | Direct mode |
| `⌘N` | New workspace (current project) |
| `⌘K` | Toggle command palette |
| `⌘P` | Workspace file finder |
| `⌘⇧F` | Workspace text search |
| `⌘\` | Toggle companion (layout refit) |
| `⌘,` | Open Settings (General) |
| `⌘⇧T` | Open Settings · Usage |
| `⌘⌥1` … `⌘⌥9` | Cycle to the Nth terminal within the active workspace |
| `⌘T` | New session (command palette / session sidebar) |
| `⌘⇧M` | Model switcher (titlebar) |
| **Chat** | `↵` send · `⇧↵` newline · `↑`/`↓` prompt history |
| **Editor** | `⌘S` save · `⌘F` find/replace · `⌘G`/`F3` next/prev · `⌘⇧L` select all occurrences · `⌘D` next occurrence · `⌘=`/`⌘−` font · `Alt-Z` wrap |
| **Diff triage** | `j`/`k`/↓/↑ move hunk · `]`/`[` jump file · `Space` fold · `a` accept · `x` reject · `A` accept file · `v` viewed · `o` open in editor · `w` why · `/` filter · `c` commit · `?` help |
| **File tree** | ↑/↓ move · →/← expand/collapse · Home/End · Enter/Space activate · ContextMenu/Shift+F10 menu |
| **Dialogs** | `Esc` close topmost · `Tab` trap within ModalShell |

---

## Appendix D — Processes & on-disk locations

- **Processes** — the Tauri app (`octopush`), the PTY daemon (`octopush-pty-server`, out-of-process, launchd-adopted), and on demand the MCP server (`octopush-mcp`, stdio, spawned by a CLI like Claude Code). Direct CLI stages spawn `claude -p …`; Run terminals spawn the user's login shell.
- **`~/.octopush/`** — `settings.json` (keys, base URLs, git credentials, issue-tracker config, editor command, last pricing refresh), `providers.json` (provider/model catalog incl. pricing), `theme.json`, `projects/` (default scaffold location), `pty-server.sock` / `pty-server.pid` / `pty-server.log`, `pty-state/<id>.log` (terminal scrollback), `history/<session>.hist`.
- **`~/Library/Application Support/octopush/`** — `octopush.db` (SQLite: projects, workspaces, sessions, terminals, chats, pipelines, runs, roles, journals, token events, budgets, …).
- **`~/.claude/`** — read for `mcp.json` (MCP servers) and `skills/*` (user skills); Claude Code's own config receives the `octopush` MCP registration.
- **Per-project** — `.octopus-worktrees/<branch>/` (workspace worktrees), `.claude/skills/*` and `.claude/mcp.json` (project-scoped skills/servers), and the migration from legacy `~/.octopus-sh` / `octopus-sh` dirs runs once on launch.
- **Privacy posture** — local-first, no analytics/telemetry; outbound traffic only to configured AI providers and to integrations the user enables (Jira over HTTPS, GitHub via `gh`/REST).

---

_Last assembled from a full read-through of the codebase. When in doubt, the code in `src/` and `src-tauri/src/` is authoritative — and when you change it, change this file too._
