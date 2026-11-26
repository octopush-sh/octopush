# What's new — the contract

Every user-visible change ships with a **changeset**: a small Markdown file written in the
same PR as the code. One file feeds four things, so they can never disagree:

1. the **release notes** (GitHub release body and the updater's `latest.json` `notes`, which
   the in-app update alert shows);
2. the **What's new modal** shown after an update (tips);
3. the **guided tour** behind each tip's *Show me* button (highlights the real UI);
4. the **recorded clip** shown in the tip (the recorder performs the same steps on the real
   frontend with mocked IPC).

## 1. The changeset file

Path: `whats-new/unreleased/<slug>.md` — `slug` is kebab-case, unique, ≤ 48 chars.
PRs with no user-visible change (refactors, CI, tests, dependency bumps) add none.

```markdown
---
title: Run history syncs only if you turn it on      # ≤ 60 chars, English, user-facing
kind: feature            # feature | improvement | fix
area: app                # app | api | web — only `app` entries reach the in-app modal
highlight: true          # optional (default: false for fix, true otherwise). true ⇒ a tip in the modal
scenario: default        # optional demo fixture the tour preview and clip recorder start from (§4)
steps:                   # optional; drives the tour AND the clip. Omit for text-only tips.
  - open: settings/account          # optional: a named surface to open first (§3)
    target: settings-account-sync   # a data-tour id that exists in src/ (§2)
    caption: Turn on run-history sync here — it's off until you do.
    action: none                    # none | click | hover | type (the tour never acts; the recorder does)
  - target: settings-account-sync-note
    caption: Turning it off stops future uploads.
---
Cloud sync is now opt-in and off by default, per account. Turn on **Sync run history** in
Settings › Account when you want your runs on your other Macs.
```

Rules (enforced by `node scripts/whats-new.mjs check`, which CI runs):

- Frontmatter keys and enum values exactly as above; unknown keys are an error.
- `title` ≤ 60 chars; body 1–3 sentences, ≤ 400 chars, Markdown inline only.
- Every `target` must exist as `data-tour="<id>"` somewhere in `src/`; every `open` must be a
  registered surface (§3); `text` is required when `action: type`.
- At most 6 steps. A clip, if committed, lives next to the file as `<slug>.webm`, ≤ 1.5 MB.
- UI copy rules from `CLAUDE.md` apply: English, calm, no hype.

## 2. `data-tour` ids

A tour or clip can only point at elements that carry a stable `data-tour="<id>"` attribute.
Ids are kebab-case, scoped by surface (`settings-account-sync`, `direct-launcher-begin`,
`review-ai-pass`). Adding an id to an element is cheap and encouraged; renaming one breaks
changesets that use it, so `check` catches it. Retiring an element whose id a **released**
changeset points at: in the same PR, remove that step from the released changeset (its
text stays as the record of what shipped) and the id's row from the table below, so `check`
stays green and no tour points at an element that no longer exists. The registry of surfaces and the tour runner
live in `src/lib/tour/`.

An id assigned through a variable (one per mode, one per settings tab) is written as
`tourId("mode-run")` (`src/lib/tour/ids.ts`, the identity function) so `check` still sees it.

Current anchors:

| Id | Element | Where |
|---|---|---|
| `rail` | The workspace rail | `WorkspaceRail.tsx` |
| `rail-search` | Rail search (placeholder "Find a project or mission"; title "Find a project, group or mission") | `WorkspaceRail.tsx` |
| `rail-group-header` · `rail-group-members` | Rail, only in a project with a mission group: the first group's header line (chevron, name; folded, its count) · its run of indented missions beside the guide (only while the group has missions) | `RailMissionGroup.tsx` via `WorkspaceRail.tsx` |
| `rail-section-header` · `rail-section-projects` | Rail, only with a project group: the first group's header line (the caps name; folded, its count) · its run of projects (only while the group has projects) | `RailProjectSection.tsx` via `WorkspaceRail.tsx` |
| `rail-add-project` | Rail "Add project" button | `WorkspaceRail.tsx` |
| `rail-state-filter` | Rail search line: the state filter (Every mission · Needs you · Working · Idle) | `RailStateFilter.tsx` via `WorkspaceRail.tsx` |
| `rail-merged-archive` | Rail row meta: "merged · archive?" (only on an idle mission whose PR is merged and worktree clean) | `WorkspaceRail.tsx` |
| `mode-switcher` | The mode switcher (whole control) | `ModeSwitcher.tsx` |
| `mode-talk` · `mode-run` · `mode-review` · `mode-direct` | One mode segment | `ModeSwitcher.tsx` |
| `header-branch` | Workspace header: the branch chip (hover/focus opens its provenance popover) | `ContextHeader.tsx` |
| `pr-chip-checks` | Workspace header, PR chip: the CI checks glyph (only on an open/draft PR whose checks could be read; failing adds "Fix failing checks…" beside it) | `ContextHeader.tsx` |
| `genesis-key-save` · `genesis-begin` · `genesis-sketch` | Genesis block (Welcome / New-project "From a prompt"): the inline API-key field (only with no key) · the one primary CTA ("Set a crew on it", or "Wake the crew" with a key and no brief) · "or think it through first" | `GenesisPrompt.tsx` |
| `welcome-new-study` | Welcome: "Begin a new study" on the secondary line | `WelcomeScreen.tsx` |
| `direct-launcher-brief` | Direct launcher: the brief | `PipelineSetup.tsx` |
| `direct-launcher-begin` | Direct launcher: "Begin the run" | `PipelineSetup.tsx` |
| `direct-launcher-estimate` | Direct launcher foot: the "est. $low–$high" range (hover for the per-stage breakdown; once the estimate arrives) | `PipelineSetup.tsx` |
| `direct-launcher-cli-version` | Direct launcher: the amber "Update Claude Code" note (only on an old CLI) | `PipelineSetup.tsx` |
| `direct-launcher-model-floor` | Direct launcher: the amber "Fable 5.2 needs Claude Code 2.1.321 or newer" line (only when a Claude Code CLI stage's model or escalation model needs a newer CLI) | `PipelineSetup.tsx` |
| `direct-launcher-known-bad` | Direct launcher: the amber "Claude Code 2.1.329 drops the retry gateway models need … update Claude Code." line (only on that exact release, when a Claude Code CLI stage or its escalation runs a gateway model) | `PipelineSetup.tsx` |
| `direct-launcher-codex-read-only` | Direct launcher: the amber "A read-only Codex stage can't run in a sandboxed mission yet." line (only when a read-only CLI stage runs on Codex in a sandboxed or readonly mission) | `PipelineSetup.tsx` |
| `direct-launcher-codex-commit` | Direct launcher: the amber "Ship runs on Codex, whose sandbox keeps .git read-only, so it can't commit or push." line (only when an Action-role CLI stage runs on Codex outside a sandboxed mission) | `PipelineSetup.tsx` |
| `direct-launcher-codex-trust` | Direct launcher: the amber "Codex will ignore this repo's .codex/ settings and MCP servers" line and how to trust the project (only when a Codex CLI stage would skip a `.codex/` dir in an untrusted project) | `PipelineSetup.tsx` |
| `direct-launcher-repo-hooks` | Direct launcher, under the launch line: "This repo's own Claude Code config runs 2 hooks and 1 MCP server." and one row per entry (only when a Claude Code CLI stage is in the crew and the worktree's `.claude/settings.json` or `.mcp.json` runs something) | `PipelineSetup.tsx` |
| `pipeline-model-superseded` | Direct launcher, above the selected crew's description: "Fable 5.1 → Fable 5.2: about 20% cheaper per token." with "Switch this crew" / "Keep 5.1" (only while a stage or escalation of that crew uses a superseded model and the user hasn't kept it) | `direct/SupersededModelLine.tsx` via `PipelineSetup.tsx` |
| `direct-launcher-model-retirement` | Direct launcher, under the foot: "Sonnet 4.5 retires Nov 30, so a stage on it will fail from then on." with "Switch to Sonnet 5.5" (only while a stage, launcher pick or escalation of the selected crew uses a model within 30 days of its retirement, or past it) | `direct/RetiringModelLine.tsx` via `PipelineSetup.tsx` |
| `direct-launcher-low-disk` | Direct launcher: the amber "Only 1.4 GB free" line above Begin (only under 2 GB free) | `PipelineSetup.tsx` |
| `direct-run-track` | Direct canvas: the run track's scrolling rail of stage cards (its edges fade while they hide stages; the chevrons sit outside it) | `RunFlow.tsx` |
| `direct-halt-cause` | Direct run bar, on a halted stage: the role and its cause ("Tester Bash `npm test` gave no result for 11 minutes") | `RunControlBar.tsx` |
| `direct-gate-document` · `direct-gate-comment-compose` · `direct-gate-comments` | Direct focus pane, only on a stage parked at its gate with a text artifact: the artifact as a commentable document · the comment composer (only after **Comment** was used on a selected or keyboard-marked passage) · the "your comments · N" list (only with comments) | `comments/CommentableDocument.tsx` via `StageFocus.tsx` |
| `direct-gate-comment-count` | Direct run bar, at a gate with comments: "Plan: 2 comments go with your decision." (or, with no stage left to take them, "Plan: 2 comments. No stage follows to take them: …") | `RunControlBar.tsx` |
| `direct-halt-drop-call` | Direct run bar, on a halted stage whose resumed session waits on a tool that's gone (`tool_deferred_unavailable`, with a session): "Drop the call and continue" | `RunControlBar.tsx` |
| `direct-halt-rerun-feedback` | Direct run bar, on a halted stage whose primary action is Re-run: "Re-run with feedback" | `RunControlBar.tsx` |
| `direct-stage-ran-on` | Direct run track, on a stage card's meta line: the amber "ran on sonnet-5-5" note (only when Claude Code ran the stage on another model than it asked for) | `RunFlow.tsx` |
| `direct-stage-refused` · `direct-focus-refused` | Direct run track, on a finished stage card's live line · the focus pane's header beside the tokens: the amber "2 tool calls refused" (only when Claude Code refused calls in the stage's last attempt) | `RunFlow.tsx` · `StageFocus.tsx` |
| `direct-stage-context` · `direct-focus-context` | Direct run track, on a running Claude Code stage card's meta line (shed when it doesn't fit) · the focus pane's header beside the tokens: the context reading, `ctx 71%` on the card · `ctx 142k / 200k` in the header, amber past 80%, rouge past 95% (only when the model's window is known) | `RunFlow.tsx` · `StageFocus.tsx` |
| `direct-stage-waiting` | Direct run track, only while a running stage has no activity yet: its card's live line "waiting for first tool call" | `RunFlow.tsx` |
| `direct-ledger-strip` · `direct-ledger-usage-unreported` · `direct-ledger-usage-unreported-stage` | Direct run ledger: the cost strip (click unfolds the per-stage breakdown) · the strip's "· N stage(s) usage not reported" fragment after the spent figure (only when a Codex stage ended before its last turn reported usage, or a stopped Claude stage streamed usage with no price — a subagent model or fast mode; visible collapsed, budget or not) · that stage's "usage not reported" cell (once unfolded) | `RunLedger.tsx` |
| `direct-launcher-import-crew` · `direct-launcher-repo-crews` | Direct launcher: the "import a crew" link beside the ensemble eyebrow · the "from this repo" group (only when the worktree has `.octopush/crews/*.octocrew.json`) | `PipelineSetup.tsx` |
| `builder-export-crew` | Pipeline builder, top-right toolbar: "Export crew…" (saved pipelines only) | `PipelineBuilder.tsx` |
| `crew-import-sheet` · `crew-import-add` | Crew import review sheet, while open: the sheet · "Add this crew to my library" | `CrewImportSheet.tsx` |
| `palette-import-crew` | Command palette, Actions: "Import a crew…" | `CommandPalette.tsx` |
| `builder-stage-reasoning` | Pipeline builder, Stage inspector: the Reasoning control (label + effort segments) | `builder/StageInspector.tsx` |
| `run-starting` | Run canvas, until the shell draws its prompt: the "Starting shell in …" line | `TerminalPane.tsx` |
| `run-session-line` · `run-session-cell` | Run mode band, right track: the session line (session cells, `+`, the layout button) · the focused session's cell (hover or keyboard focus opens its instant label) | `run/SessionLine.tsx` |
| `run-layout` · `run-layout-two` | Session line: the layout button · its menu's "Two, side by side" row (while the menu is open) | `run/SessionLine.tsx` |
| `run-setup-session` | Session line: the cell of a workspace's setup terminal (only while the workspace has one) | `run/SessionLine.tsx` |
| `run-pane-caption` · `run-open-beside` | Run canvas: the first pane's caption (a lone pane has one too) · its `⋯` "Session actions" button, whose menu holds "Open beside…" (tours from before the session line, which pointed at the rail flyout's Open beside, land here) | `run/RunPanes.tsx` |
| `run-pane-divider` · `run-empty-seat` | Run canvas, only with two or more panes: the first (main) divider · the empty seat (only while there is one) | `run/RunPanes.tsx` |
| `run-pane-waiting` | Run canvas: the first pane's caption suffix "· waiting on permission" / "· waiting on your input" (only while Claude Code's hooks say that session waits on you) | `run/PaneWaiting.tsx` via `run/RunPanes.tsx` |
| `talk-seat-toggle` | Talk canvas: the `SquareTerminal` icon that opens or closes the terminal seat beside the conversation | `chat/TalkSeat.tsx` |
| `talk-seat-leave` | Talk canvas, while the terminal seat is open: the minus on its caption, "Leave the view · the session keeps running" | `chat/TalkSeat.tsx` |
| `talk-turn-actions` · `talk-turn-rewind` · `talk-turn-fork` | Talk, on a message you sent (revealed on hover or focus, and while a tour points at it): its row of actions · "Rewind files to here" (only when that turn took a checkpoint) · "Fork from here" | `chat/ChatCanvas.tsx` |
| `talk-rewind-dialog` · `talk-rewind-outside` · `talk-rewind-confirm` | Talk rewind confirm, while open: the dialog · the amber "changed outside this conversation" line (only when such a file is listed) · "Rewind the files" | `chat/RewindDialog.tsx` |
| `talk-rewind-untouched` · `talk-rewind-storage` · `talk-rewind-undo` | Talk rewind confirm, while open: the list of paths left untouched (only when there is one) · the line saying where checkpoints are stored · "Undo the rewind" (only after a rewind stopped part-way) | `chat/RewindDialog.tsx` |
| `talk-turn-no-checkpoint` | Talk, on a message you sent whose checkpoint was skipped (in its hover/focus action row): the "This turn has no checkpoint" mark | `chat/ChatCanvas.tsx` |
| `talk-turn-ask` | Talk: a message you sent, set on the panel surface with "— You" and the time (every such turn carries it; a tour finds the first) | `ChatMessage.tsx` |
| `talk-work` · `talk-work-fold` | Talk: the model's work in a turn, its narration and tool calls on one hairline (only when a turn has some) · the summary row of a round of more than five calls (only when one has) | `chat/WorkBlock.tsx` |
| `talk-composer-input` | Talk composer: the draft textarea | `chat/Composer.tsx` |
| `talk-context-chip` | Talk composer, above the draft: the first context chip (a file, line range, folder, Run session or diff the draft's `@` tokens name; only while there is one) | `chat/ContextChips.tsx` |
| `talk-context-cap` | Talk composer, at the end of the context chips: "10 at most · 2 more sent as text" (only while the draft names more than 10 mentions) | `chat/ContextChips.tsx` |
| `talk-composer-estimate` | Talk composer: the cost estimate beside Send ("≈ $0.02 · 3k tokens"; only once there is something to estimate) | `chat/ComposerEstimate.tsx` |
| `run-session-waiting` | Session line: the brass dot of the first session Claude Code's hooks say waits on you while it isn't in focus: on its cell, or on the `+N` / `N sessions` button when it has no cell (only while one does) | `run/SessionLine.tsx` |
| `run-switcher-waiting` | ⌘⌥K switcher (or Open beside), while open: the first row's "· waiting on permission" / "· waiting on your input" (only while a listed session waits) | `run/SessionSwitcher.tsx` |
| `run-pair-input` · `run-pair-pick` | Pairing switcher (Open beside), while open: its query input · its first session row (only when a session is off screen) | `run/SessionSwitcher.tsx` |
| `run-spawn-failed` · `run-spawn-retry` | Run canvas, only when a session didn't start: the rouge eyebrow · "Try the shell again" | `TerminalPane.tsx` |
| `mission-setup-script` · `mission-setup-template` | New-mission wizard step 3: the setup-script field · the line saying it becomes the project's setup script | `MissionCreator.tsx` |
| `mission-setup-conductor` | New-mission wizard step 3: "From .conductor/settings.toml · edit before it runs" (only while the field holds a Conductor repo's setup script exactly as read) | `MissionCreator.tsx` |
| `mission-share` · `mission-share-install` · `mission-share-sandbox` | New-mission wizard step 3: the "Share with new missions" list (only when the main checkout has a dependency folder or env file to share) · its amber "This setup script runs…" line (only while a dependency folder is on and the setup script installs or cleans) · its amber "A sandboxed mission gets neither the links nor the env files" line (only while an entry is on and Execution is Local sandbox) | `MissionCreator.tsx` |
| `routines-run-now-phase` | Settings › Routines, only while Run now is in flight: the row's phase line ("running the setup script…") | `settings/RoutinesPane.tsx` |
| `routines-login-expiry` · `mission-control-login-expiry` | Settings › Routines (above the list) · Mission Control header: the claude.ai sign-in note (only within 10 days of its end, or after it) | `ClaudeLoginNote.tsx` via `settings/RoutinesPane.tsx` · `MissionControl.tsx` |
| `routines-model-retirement` | Settings › Routines: the first row's "Sonnet 4.5 retires Nov 30, so this routine will fail from then on." (only while a Routine's crew uses a model within 30 days of its retirement, or past it) | `settings/RoutinesPane.tsx` |
| `routines-upsell-cta` | Settings › Routines, Free only: the upgrade banner's "Put your crews on a schedule with Pro" | `settings/RoutinesPane.tsx` |
| `logbook-upsell-cta` | Logbook room, Free only: "Open the full logbook with Pro" | `LogbookRoom.tsx` |
| `review-mode-tail` | Review: the mode band's status tail ("2 files changed · +2 −1"; only with changes) | `ReviewTail.tsx` |
| `review-companion-verdict` | Review Companion: the serif readiness verdict ("2 files to review.") | `CompanionReview.tsx` |
| `review-companion-collision` | Review Companion, under the verdict: "Will conflict with refund-webhooks in 1 file." + "Open refund-webhooks" (only while the workspace overlaps another) | `CompanionReview.tsx` |
| `review-companion-secret` | Review Companion, under the verdict: "possible secret · GitHub token in src/a.ts:3" + "Show it" (only while the staged diff holds what Commit's secret guard would stop for) | `CompanionReview.tsx` |
| `review-diff-source` | Review toolbar: the "Working tree" / "Since base · N commits" toggle (only while the workspace has commits since its base) | `ReviewCanvas.tsx` |
| `review-diff-readonly` | Review toolbar: the lock beside that toggle (only in the read-only Since base view) | `ReviewCanvas.tsx` |
| `review-companion-ahead` | Review Companion, Branch & publish: "3 commits ahead of main" (only with commits since the base) | `CompanionReview.tsx` |
| `review-companion-scan-branch` · `review-companion-scan-result` | Review Companion, Branch & publish, only with commits since the base: "Scan this branch's commits" (then "Scan again"; hidden while a scan runs) · its result ("No possible secrets in 3 commits." or what it found; only once a scan answered) | `CompanionReview.tsx` |
| `review-ai-pass` | Review: the AI review button | `ReviewCanvas.tsx` |
| `ai-review-partial` | AI review drawer, under the summary: "Read the first 2 of 14 files; the rest wasn't reviewed." (only when the review read part of the diff) | `review/AiReviewPanel.tsx` |
| `review-accept-all` | Review: "Accept all", the toolbar's one brass action (diff view, with changes) | `ReviewCanvas.tsx` |
| `review-toolbar-more` | Review: "More view options" (only while the canvas toolbar is ≤ 600px wide; hidden at 1280×800) | `ReviewCanvas.tsx` |
| `review-editor` | Review, Editor view: the code editor pane (tabs excluded, status bar included) | `EditorPane.tsx` |
| `review-editor-ask-talk` | Review, Editor view, status bar: "Ask Talk about this" (only while text is selected) | `EditorStatusBar.tsx` |
| `review-sidebar` | Review: the Changes/Files navigator (expanded, or its icon strip) | `ReviewSidebar.tsx` |
| `review-diff-hunk` | Review diff: one hunk (its rail and highlighted lines; the first on screen) | `review/FileDiffSection.tsx` |
| `review-hunk-comment` · `review-comment-composer` · `review-comment-add` | Review diff, working tree only: a hunk rail's "Ask for a change" icon (the first on screen) · the inline comment field under a hunk · its "Ask for this change" (both only while one is open) | `review/HunkRail.tsx` · `review/HunkComments.tsx` |
| `review-comment-pick-keys` | Review diff, in the open "Ask for a change" field's header: "⌥↑ ⌥↓ lines · ⇧ extends" | `review/HunkComments.tsx` |
| `review-companion-comments` · `review-companion-send-comments` | Review Companion, only while a comment is waiting: the "For the agent" tray · its "Send to the agent" | `review/CommentTray.tsx` |
| `review-companion-gate-comments` | Review Companion tray, beside "as send-back to Implementer": ", with 2 comments on Reviewer" (only while the waiting gate has inline comments) | `review/CommentTray.tsx` |
| `review-file-viewed` · `review-file-changed` | Review diff, file header: "mark viewed" / "✓ viewed" · the "changed since viewed" chip (only after a viewed file changed) | `review/FileDiffSection.tsx` |
| `review-open-pr` | Review: "Open a pull request" (published branch, no PR yet, `gh` signed in) | `ChangesPanel.tsx` |
| `pr-composer-create` | PR composer: "Open the pull request" | `PrComposer.tsx` |
| `pr-composer-draft-note` | PR composer, once a draft answered: the note under the form ("Drafted by claude-sonnet-5-5 · $0.02") | `PrComposer.tsx` |
| `settings-nav-<tab>` | Settings nav item, for `general` `editor` `models` `routines` `appearance` `usage` `shortcuts` `privacy` `integrations` `account` `about` | `Settings.tsx` |
| `settings-shortcuts-modes` | Settings › Shortcuts, Navigation: the first mode row ("Run mode" `⌘⇧1`) | `settings/ShortcutsPane.tsx` |
| `settings-models-add-provider` · `settings-models-add-model` | Settings › Models: "Connect another provider" under the provider list · "Bring in another model" in the selected provider's Models header | `settings/ModelsPane.tsx` |
| `settings-claude-code-card` · `settings-claude-cli-version` · `settings-claude-cli-update` | Settings › Integrations: the Claude Code card · its installed-CLI version line · the amber update note (only on an old CLI or one missing a security fix) | `settings/IntegrationsPane.tsx` |
| `settings-integrations-project-link` | Settings › Integrations › Jira, Project links: the first project's name (only with a project opened) | `settings/IssueTrackingSection.tsx` |
| `settings-mcp-reconnect` | Settings › Integrations › MCP Servers: the first server's Reconnect icon button (only with a server configured) | `settings/McpServersSection.tsx` |
| `settings-mcp-edit` | Settings › Integrations › MCP Servers: the first server's Edit icon button (only with a server configured and no form open on it) | `settings/McpServersSection.tsx` |
| `settings-mcp-add` · `settings-mcp-type` | Settings › Integrations › MCP Servers: "Add MCP server" (disabled while a form is open) · the open form's Local command / Remote URL choice (only while the add or edit form is open) | `settings/McpServersSection.tsx` · `settings/McpServerForm.tsx` |
| `settings-readiness-card` · `settings-readiness-again` · `settings-readiness-checked` | Settings › General: the Readiness card · its "Check again" ("Run the check" before the first run) · the "Checked 2m ago" meta (once a check answered) | `settings/ReadinessCard.tsx` |
| `settings-readiness-disk` | Settings › General, Readiness card: the Disk space row | `settings/ReadinessCard.tsx` |
| `settings-readiness-codex` | Settings › General, Readiness card: the Codex CLI row (only when a saved crew or Routine has a Codex CLI stage) | `settings/ReadinessCard.tsx` |
| `settings-readiness-claude-note` | Settings › General, Readiness card: the Claude Code row's sage "Recommended: Claude Code 2.1.332…" note listing each missing fix (only below 2.1.332, to anyone on an older Claude Code; the ExitWorktree fix only while a Run-mode session runs Claude Code) | `settings/ReadinessCard.tsx` |
| `settings-readiness-models` | Settings › General, Readiness card: the Crew models row (only while a saved crew or Routine uses a model within 30 days of its retirement, or past it) | `settings/ReadinessCard.tsx` |
| `settings-account-sync-history-status` · `settings-account-sync-library-status` | Settings › Account › Sync: the last-attempt line under the run-history · library toggle (only while that toggle is on and an attempt was recorded) | `settings/AccountPane.tsx` |
| `settings-account-sync-library-unsent` | Settings › Account › Sync: the amber line under the library toggle naming the items the sync service refused (only while library sync is on and an item is unsent) | `settings/AccountPane.tsx` |
| `settings-claude-hooks` | Settings › General › Attention: "Let Claude Code say what it's waiting on" | `settings/GeneralPane.tsx` |
| `settings-notify-elsewhere` · `settings-notify-elsewhere-url` · `settings-notify-elsewhere-test` · `settings-notify-elsewhere-payload` | Settings › General › Attention, "Notify me elsewhere": the row · its webhook URL field · "Send a test" · the "The message's fields" disclosure (only once the preview loaded) | `settings/NotifyElsewhereRow.tsx` |
| `settings-quiet-claude-code` | Settings › Privacy: the "Quiet Claude Code in crews and Routines" toggle | `settings/PrivacyPane.tsx` |
| `settings-secret-guard` | Settings › General › Safety: "Guard commits against secrets" | `settings/GeneralPane.tsx` |
| `secret-guard-dialog` | The secret guard's confirm (only after a commit, push, PR or Talk `$` command is refused for a possible secret, or a Talk message's `@` block holds one): "Leave it out" · "Commit regardless" (for a message, "Send regardless") | `SecretGuardDialog.tsx` via `ChangesPanel.tsx` · `PrComposer.tsx` · `chat/Composer.tsx` |
| `secret-guard-preview` | The secret guard's confirm, with one finding that has a masked preview: the mono `sk-ant-…9fQ2` line under the lead | `SecretGuardDialog.tsx` |
| `talk-secret-approval` | Talk timeline, only while the secret guard holds an agent's commit, push or `gh pr create`: the inline "Possible secret" card ("Leave it out" · "Run regardless") | `chat/ApprovalCard.tsx` via `chat/ChatCanvas.tsx` |
| `direct-secret-hold` | Direct run bar, on an Action stage held by the secret guard: "Held before Pull request: possible secret · …" | `RunControlBar.tsx` |
| `settings-appearance-legacy` | Settings › Appearance: the Legacy theme group (Dark, Midnight, Solarized Dark; only when the theme list has any) | `settings/AppearancePane.tsx` |
| `about-whats-new` | Settings › About: "What's in this version" | `settings/AboutPane.tsx` |
| `palette-input` | Command palette input | `CommandPalette.tsx` |
| `palette-models` | Command palette: the Models group | `CommandPalette.tsx` |
| `palette-models-more` | Command palette, Models group: "Show all models" (only with no query and more than three models) | `CommandPalette.tsx` |
| `palette-workspaces` | Command palette: the Workspaces group (every open project's workspaces, needs-you first) | `CommandPalette.tsx` |
| `palette-groups` | Command palette: the Groups section (every rail group of the open projects, in rail order; only when there is one) | `CommandPalette.tsx` |
| `file-finder-input` · `file-finder-results` | ⌘P / ⌘⇧F palette: the query input · the virtualized file list (files mode, with matches) | `WorkspaceSearchPalette.tsx` |
| `file-finder-capped` | ⌘P mode bar: "Showing the first 20,000 files" (only when the listing hit the cap) | `WorkspaceSearchPalette.tsx` |
| `companion-run-context` · `companion-run-changes` · `companion-run-read-diff` · `companion-run-mission` | Run Companion: the Context section (only while the focused pane is an agent session Octopush has usage for) · the Changes section · its "Read the diff" link (only with something to read in Review) · the Mission section (only with a mission) | `CompanionRun.tsx` |
| `companion-chats-list` | Companion › Chats: the conversation list | `CompanionHistory.tsx` |
| `companion-can-use` | Talk Companion › Conversation: the "can use" row, one toggle chip per MCP server (only while the workspace has one configured) | `CompanionMcpScope.tsx` via `CompanionContext.tsx` |
| `companion-claude-plan` | Direct Companion, current run: the Claude plan line (only once a Claude-plan stage reported) | `ClaudePlanLine.tsx` |
| `usage-headline` | Settings › Usage: the headline stats row (Cost · Per active day · Last 24 hours · Cache hit), also while the ledger is read | `settings/UsagePane.tsx` |
| `usage-claude-plan` | Settings › Usage: the Claude plan card (only once a Claude-plan stage reported) | `settings/ClaudePlanCard.tsx` |
| `fleet-chip` | Top bar: the fleet chip (`2 needs you` · `1 in flight` · `✓ 3 done`; only while the board has something) | `RunsTray.tsx` |
| `mission-control-away` | Mission Control header: "While you were away" line | `MissionControl.tsx` |
| `rail-collision` | Rail row meta: the `GitCompareArrows` collision mark, amber for a file overlap, rouge for a confirmed conflict (only while another live workspace of the project changes the same files) | `CollisionMark.tsx` via `WorkspaceRail.tsx` |
| `mission-control-card-collision` | Mission Control, a non-settled crew card: the "overlaps auth-flow · 2 files" meta segment (only while its workspace overlaps another) | `MissionControl.tsx` |
| `mission-control-card-task` · `mission-control-card-workspace` · `mission-control-card-spent` | Mission Control crew card: its task title · the workspace name in its meta row · the spent figure in its ledger foot | `MissionControl.tsx` |
| `mission-control-card-size` · `mission-control-settled-order` | Mission Control crew card (settled and needs-you): the `+N −M · K files` diff size in its ledger foot (only once measured) · the Settled band's Oldest first / Smallest first toggle | `MissionControl.tsx` |
| `mission-control-ask-toggle` · `mission-control-ask-accept` | Mission Control `?` card (an `ask_director` block): the questions disclosure · "Accept recommended" | `MissionControl.tsx` |

A target only counts as found when it is visible; the tour waits up to 2s for it after
opening the step's surface, then skips the step.

## 3. Named surfaces (`open:`)

`open` takes a name from the surface registry in `src/lib/tour/surfaces.ts` (e.g.
`settings/account`, `settings/privacy`, `mode/run`, `mode/direct`, `mode/review`,
`palette`, `file-finder`, `run/open-beside`: Run's pairing switcher, only when Open beside would pair — it never leaves an empty seat). Each entry is a function that navigates the real app there. The tour runner and
the clip recorder both call it, so a demo never depends on clicking through menus.

## 4. Scenarios

A scenario is a named fixture of app state for demos: projects, workspaces, a finished
Direct run, a signed-in Pro account, etc. Scenarios live in `scripts/clips/scenarios/` and
are served through Tauri's IPC mocks when the recorder runs the frontend in a browser. The
tour itself always runs on the user's real data and skips steps whose target isn't on
screen.

**Recording clips.** `npm run clips:record -- <version|unreleased> [--slug <s>] [--force]
[--verbose]` records `<slug>.webm` for each `area: app` changeset with `steps` and no clip
yet (`--force` re-records). It serves the real frontend from `clips.html` (a harness
entry that is never part of the app bundle) on a Vite dev server, mocks IPC from the
changeset's scenario via `@tauri-apps/api/mocks`, and drives headless Chromium with
Playwright at 1280×800: through the app's tour runner (`window.__octoTour.play(steps,
{ mode: "record" })`) when present, otherwise with its own token-styled caption and
spotlight. With ffmpeg it trims the blank lead-in and re-encodes to VP9 under 1.5 MB,
lowering fps then bitrate; a clip that can't fit is skipped with a warning. It never
commits. `--verbose` lists every command the app invoked that the scenario doesn't
cover.

| Scenario | State |
|---|---|
| `default` | Signed-in Pro user, one project with two workspaces, a finished Direct run with stages and costs, a short Talk thread, three providers. |
| `empty` | Fresh install: no projects, signed out, free plan. |
| `rail-groups` | `default` with eight missions, two mission groups in the rail and a loose mission after them. |
| `rail-project-groups` | `default` with seven projects in the rail: a pinned one, two project groups and a loose project after them. |
| `rail-groups-everywhere` | `default` with a project group ("Client work": `acme-api`, `acme-web`), a mission group ("Fixes") in `acme-api`, a crew at work in one of its missions (Mission Control reads `Fixes · fix-json-parser`) and an archived mission of the group. Moves and new groups last until the page reloads. |
| `direct-running` | `default` with a crew at work in the active workspace: its Implement stage runs on Claude Code (the CLI substrate) with a context reading of 142k / 200k (`ctx 71%`), and no effort, escalation or ran-on note, so the run card shows the reading. |
| `talk-work` | `default` with a longer Talk thread in the active workspace: an ask, narration and two rounds of tool calls (the second, six calls, folds into one summary row), a long answer with code and a list, then a short follow-up and its answer. Turn times are minutes before the page loads. |
| `talk-mcp` | `default` with three MCP servers in the Companion's "can use" row: `docs-server` connected with 12 tools, `example-remote` failed to start, `issue-tracker` not started yet and off in the open conversation. Toggles last until the page reloads. |

Setup, flags and how to add a scenario: [`scripts/clips/README.md`](../scripts/clips/README.md).

## 5. At release time

`node scripts/whats-new.mjs collect <version>` (run by the release routine):

1. moves `whats-new/unreleased/*` into `whats-new/<version>/`;
2. writes `whats-new/<version>/notes.md` — grouped **Features / Improvements / Fixes**, then
   a **Maintenance** line listing merged PRs without a changeset;
3. the clip recorder then records `<slug>.webm` for every app changeset with `steps`.

The app bundles the released `whats-new/X.Y.Z/` directories at build time (`unreleased/` is
never shipped; dev builds can preview it from the palette). After an update, the What's new
modal shows the `highlight` tips of every version in (last seen, installed]; a fresh install
only records the version. Implementation: `src/lib/whatsNew.ts` (model),
`src/lib/whatsNewLaunch.ts` (launch rule), `src/components/WhatsNewModal.tsx`.

The clip recorder drives the tour through `window.__octoTour` (dev builds, or the page loaded
with `?octo-record=1`):

```ts
window.__octoTour.play(steps, { mode: "interactive" | "record", stepMs?: number }): Promise<void>
```

In `record` mode each step shows its caption, performs its `action` at `stepMs / 2`
(`click` → `element.click()`; `hover` → pointerover/pointerenter/mouseover/mouseenter;
`type` → sets the value of the target, or the first input/textarea inside it, and fires
`input`), and advances at `stepMs` (default 2200). The promise resolves when the tour ends.

## 6. Update channels

| Channel | Manifest | Who |
|---|---|---|
| Stable | `https://octopush.sh/update/latest.json` → GitHub `releases/latest/download/latest.json` | everyone (default) |
| Beta | `https://octopush.sh/update/beta.json` → GitHub `releases/download/beta-channel/latest.json` | Settings › About › Update channel: Beta |

Every tagged release `vX.Y.Z` is first published as a GitHub **prerelease** (beta) and its
`latest.json` is also uploaded to the moving `beta-channel` release. **Promoting** a version
(`.github/workflows/promote.yml`, owner-only) marks it as the latest full release, which makes
it the stable manifest. Stable users skip unpromoted versions.
