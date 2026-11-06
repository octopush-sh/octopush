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
changesets that use it, so `check` catches it. The registry of surfaces and the tour runner
live in `src/lib/tour/`.

An id assigned through a variable (one per mode, one per settings tab) is written as
`tourId("mode-run")` (`src/lib/tour/ids.ts`, the identity function) so `check` still sees it.

Current anchors:

| Id | Element | Where |
|---|---|---|
| `rail` | The workspace rail | `WorkspaceRail.tsx` |
| `rail-search` | Rail search ("Find a project or mission") | `WorkspaceRail.tsx` |
| `rail-add-project` | Rail "Add project" button | `WorkspaceRail.tsx` |
| `mode-switcher` | The mode switcher (whole control) | `ModeSwitcher.tsx` |
| `mode-talk` · `mode-run` · `mode-review` · `mode-direct` | One mode segment | `ModeSwitcher.tsx` |
| `header-branch` | Workspace header: the branch chip (hover/focus opens its provenance popover) | `ContextHeader.tsx` |
| `genesis-key-save` · `genesis-sketch` | Genesis block (Welcome / New-project "From a prompt"): "Wake the crew" beside the inline key field (only with no key) · "or think it through first" | `GenesisPrompt.tsx` |
| `direct-launcher-brief` | Direct launcher: the brief | `PipelineSetup.tsx` |
| `direct-launcher-begin` | Direct launcher: "Begin the run" | `PipelineSetup.tsx` |
| `direct-launcher-estimate` | Direct launcher foot: the "est. $low–$high" range (hover for the per-stage breakdown; once the estimate arrives) | `PipelineSetup.tsx` |
| `direct-launcher-cli-version` | Direct launcher: the amber "Update Claude Code" note (only on an old CLI) | `PipelineSetup.tsx` |
| `builder-stage-reasoning` | Pipeline builder, Stage inspector: the Reasoning control (label + effort segments) | `builder/StageInspector.tsx` |
| `run-starting` | Run canvas, until the shell draws its prompt: the "Starting shell in …" line | `TerminalPane.tsx` |
| `run-session-rail` · `run-session-cell` · `run-open-beside` | Run canvas: the session rail · the focused session's rail cell · a rail cell flyout's "Open beside" / "Replace in the focused pane" (on hover, while Open beside can do something) | `run/SessionRail.tsx` |
| `run-pane-caption` · `run-pane-menu` · `run-pane-divider` · `run-empty-seat` | Run canvas, only with two or more panes: the first pane's caption · its "Pane options" button · the first (main) divider · the empty seat (only while there is one) | `run/RunPanes.tsx` |
| `run-pane-orientation` | The first pane's options menu, while open with two or three panes: "Automatic" | `run/RunPanes.tsx` |
| `talk-seat-toggle` | Talk canvas: the `SquareTerminal` icon that opens or closes the terminal seat beside the conversation | `chat/TalkSeat.tsx` |
| `run-pair-input` · `run-pair-pick` | Pairing switcher (Open beside), while open: its query input · its first session row (only when a session is off screen) | `run/SessionSwitcher.tsx` |
| `run-spawn-failed` · `run-spawn-retry` | Run canvas, only when a session didn't start: the rouge eyebrow · "Try the shell again" | `TerminalPane.tsx` |
| `mission-setup-script` · `mission-setup-template` | New-mission wizard step 3: the setup-script field · the line saying it becomes the project's setup script | `MissionCreator.tsx` |
| `routines-run-now-phase` | Settings › Routines, only while Run now is in flight: the row's phase line ("running the setup script…") | `settings/RoutinesPane.tsx` |
| `routines-upsell-cta` | Settings › Routines, Free only: the upgrade banner's "Put your crews on a schedule with Pro" | `settings/RoutinesPane.tsx` |
| `logbook-upsell-cta` | Logbook room, Free only: "Open the full logbook with Pro" | `LogbookRoom.tsx` |
| `review-mode-tail` | Review: the mode band's status tail ("2 files changed · +2 −1"; only with changes) | `ReviewTail.tsx` |
| `review-ai-pass` | Review: the AI review button | `ReviewCanvas.tsx` |
| `review-accept-all` | Review: "Accept all", the toolbar's one brass action (diff view, with changes) | `ReviewCanvas.tsx` |
| `review-toolbar-more` | Review: "More view options" (only while the canvas toolbar is ≤ 600px wide; hidden at 1280×800) | `ReviewCanvas.tsx` |
| `review-editor` | Review, Editor view: the code editor pane (tabs excluded, status bar included) | `EditorPane.tsx` |
| `review-sidebar` | Review: the Changes/Files navigator (expanded, or its icon strip) | `ReviewSidebar.tsx` |
| `review-diff-hunk` | Review diff: one hunk (its rail and highlighted lines; the first on screen) | `review/FileDiffSection.tsx` |
| `review-file-viewed` · `review-file-changed` | Review diff, file header: "mark viewed" / "✓ viewed" · the "changed since viewed" chip (only after a viewed file changed) | `review/FileDiffSection.tsx` |
| `review-open-pr` | Review: "Open a pull request" (published branch, no PR yet, `gh` signed in) | `ChangesPanel.tsx` |
| `pr-composer-create` | PR composer: "Open the pull request" | `PrComposer.tsx` |
| `settings-nav-<tab>` | Settings nav item, for `general` `editor` `models` `routines` `appearance` `usage` `shortcuts` `privacy` `integrations` `account` `about` | `Settings.tsx` |
| `settings-models-add-provider` · `settings-models-add-model` | Settings › Models: "Connect another provider" under the provider list · "Bring in another model" in the selected provider's Models header | `settings/ModelsPane.tsx` |
| `settings-claude-code-card` · `settings-claude-cli-version` | Settings › Integrations: the Claude Code card · its installed-CLI version line | `settings/IntegrationsPane.tsx` |
| `settings-readiness-card` · `settings-readiness-again` · `settings-readiness-checked` | Settings › General: the Readiness card · its "Check again" ("Run the check" before the first run) · the "Checked 2m ago" meta (once a check answered) | `settings/ReadinessCard.tsx` |
| `settings-claude-hooks` | Settings › General › Attention: "Let Claude Code say what it's waiting on" | `settings/GeneralPane.tsx` |
| `about-whats-new` | Settings › About: "What's in this version" | `settings/AboutPane.tsx` |
| `palette-input` | Command palette input | `CommandPalette.tsx` |
| `palette-models` | Command palette: the Models group | `CommandPalette.tsx` |
| `file-finder-input` · `file-finder-results` | ⌘P / ⌘⇧F palette: the query input · the virtualized file list (files mode, with matches) | `WorkspaceSearchPalette.tsx` |
| `file-finder-capped` | ⌘P mode bar: "Showing the first 20,000 files" (only when the listing hit the cap) | `WorkspaceSearchPalette.tsx` |
| `companion-chats-list` | Companion › Chats: the conversation list | `CompanionHistory.tsx` |
| `companion-claude-plan` | Direct Companion, current run: the Claude plan line (only once a Claude-plan stage reported) | `ClaudePlanLine.tsx` |
| `usage-headline` | Settings › Usage: the headline stats row (Cost · Per active day · Last 24 hours · Cache hit), also while the ledger is read | `settings/UsagePane.tsx` |
| `usage-claude-plan` | Settings › Usage: the Claude plan card (only once a Claude-plan stage reported) | `settings/ClaudePlanCard.tsx` |
| `mission-control-away` | Mission Control header: "While you were away" line | `MissionControl.tsx` |
| `mission-control-card-task` · `mission-control-card-workspace` | Mission Control crew card: its task title · the workspace name in its meta row | `MissionControl.tsx` |
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
