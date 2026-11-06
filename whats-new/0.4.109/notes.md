## Octopush 0.4.109

### Features

- **A warning before your Claude sign-in ends** — On Claude Code 2.1.318 or newer, Octopush reads when your claude.ai sign-in ends from each CLI stage. Readiness shows the date, and Routines and Mission Control warn you 10 days ahead, so a crew that runs at night doesn't fail on an ended sign-in.
- **A pane on screen says when Claude Code waits on you** — With sessions side by side, the pane Claude Code is blocked in now says so in its caption: **· waiting on permission** or **· waiting on your input**. It clears as soon as you type in that pane, focus it, or Claude Code finishes its turn. Talk's terminal seat shows it too.

### Improvements

- **Readiness and the launcher warn when the disk is nearly full** — The Readiness card has a **Disk space** row, amber under 10 GB free and red under 2 GB, with a link to the workspace caches. Under 2 GB the Direct launcher shows one line above Begin; it never blocks the run.
- **The crew waiting longest stands out in Mission Control** — Cards that need you use less brass now: the status line is sage and the spent figure is mute, so the pulsing card for the crew waiting longest is the brightest thing on the board.

### Fixes

- **The composer's cost estimate stays on one line** — In Talk, the estimate beside Send (`≈ $0.02 · 3k tokens`) no longer wraps over several lines in a narrow composer. It keeps a fixed width, and as the bar narrows it drops the word "tokens" first, then the count. The full figure stays in its tooltip.
- **A running stage no longer looks stalled** — In Direct, a stage that just started now shows "Waiting for the first tool call…" right under its header, and the Thinking… octopus follows the newest journal line instead of sitting at the bottom of an empty pane. At a checkpoint, "Waiting for you" sits right under the stage header.
- **Model tier names render as code, not backticks** — In Settings › Models › Model tiers, the aliases each tier answers to (`haiku`, `fast`, `sonnet`…) now show in mono like the intro above them, instead of with literal backticks.
- **The Readiness card always shows an answer** — The Readiness card in Settings › General no longer looks empty. It shows "Not checked yet" before the first run, keeps the last results on screen while it checks again, and says when it last checked.
- **Subagents run at their stage's effort** — Claude Code no longer passes a stage's effort on to subagents that use another model, so a stage set to `low` could start Explore or Task subagents at a higher, costlier default. Octopush now gives them the stage's effort too. A subagent that sets its own effort keeps it, and a stage on Auto keeps Claude Code's defaults.
