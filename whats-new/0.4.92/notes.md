## Octopush 0.4.92

### Features

- **See if this Mac is ready for a crew** — Settings › General now opens with a **Readiness** card that checks what a crew needs in its first minute: Claude Code and its version, auth, git, the GitHub CLI and Ollama. A failing check shows how to fix it and a command you can copy, and the first-run crew invite links to it.
- **See what your crews finished while you were away** — Runs that finished while Octopush was closed now show up in Mission Control's **Settled** band when you reopen it, with a quiet **While you were away** line in the header. Dismiss a card when you've seen it.

### Improvements

- **Mission Control cards lead with the run's task** — Crew cards in Mission Control now use the run's task as their title, so several crews working in one workspace no longer look alike. The workspace name moves to the small meta row, and hovering the title shows the full task.

### Fixes

- **Long pipeline names stay inside their cards** — Long names in the Ensemble rail, run stage cards and the model picker now end with an ellipsis instead of running over the next card.
- **The mode status line no longer covers the switcher** — On a narrow window, the status line next to the mode switcher (context use, changed files, the active session) now ends with an ellipsis instead of being drawn over the Talk · Run · Review · Direct buttons.
- **Model names stay whole in the command palette** — The command palette's Models rows now show just the model's name, without the extra "Model:" prefix. When a row is tight, the provider name shortens before the model name does, and you can hover it to see the whole thing.
- **Similar mission names stay apart in the rail** — Long mission names in the rail now drop letters from the middle instead of the end, so `Production deploy (octopush-api)` and `(octopush-web)` stay distinguishable. When a name needs the room, the ahead/behind counts move into its tooltip.
- **File headers in Review stay on one line** — In Review, a long file path now drops directories from the middle and keeps the file name, with the full path in its tooltip. The hunk count, **mark viewed** and each hunk's line range no longer wrap, and the hunk count steps aside when the column is narrow.
- **Review's Changes and Files tabs stay in their sidebar** — On a narrow window the Changes and Files tabs no longer draw over the Diff and Editor toggle. Their labels shorten instead, and the icons keep a tooltip.
- **Running runs show in verdigris, not brass** — In the Direct Companion's run list, its current-run summary and Mission Control's in-flight cards, a running run's dot is now verdigris, as on the run track. Brass stays on the run you're viewing and on runs that need you.
- **Settings switches say what they turn on** — Every switch in Settings now carries its setting's name, so screen readers announce it and hovering it shows a tooltip.
