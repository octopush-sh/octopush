## Octopush 0.4.138

### Features

- **Scan a branch's commits for secrets, on demand** — Review's Companion can now scan every commit on a branch since its base for possible secrets with **Scan this branch's commits**. The secret guard's dialog shows a masked preview such as `sk-ant-…9fQ2`, so you can tell two keys apart.

### Fixes

- **Re-runs no longer read "unpriced" in Usage by mistake** — When a stage stopped before its usage was reported and then ran again, Settings › Usage could label the later attempt's spend "unpriced" even though that attempt reported its usage. Each attempt is now labelled by its own usage.
- **Shortened names keep their ellipsis** — If Octopush can't measure one long name in the rail, the other names shortened in the middle, in the rail and elsewhere (such as the branch in the workspace header and the Logbook's project switch), still keep their ellipsis. That name keeps a plain ellipsis too, so it is never cut off without one.
- **Shortened paths keep their ellipsis in Safari's engine** — A long path or name shortened in the middle, such as a Review file header's `src-tauri/…/sync.rs`, now always shows its ellipsis. It is never cut off without one after Octopush measures the row.
- **Resume now resumes the stage the plan paused** — **Resume now** on a Mission Control card now resumes the stage your Claude plan paused. Before, if the run also held a gate you hadn't looked at, it could resolve that gate instead.
- **Failed plan resumes hand over reliably** — When an automatic resume after a Claude plan limit keeps failing to start, the run now waits for you after 10 tries in total, even if the app restarts or a background worker shares the retries. Acting on the run yourself starts the count over.
- **Review file paths keep their ellipsis** — A long path in a Review file header is now shortened in the middle with an ellipsis, keeping the file name, instead of being cut off. The collapse arrow, hunk count and "mark viewed" now sit at the end of the row.
- **Secret guard reads a private key whole** — The secret guard now reads a private key in full, including lines of it your change didn't touch. Two different keys at the same place that differ only in such a line each ask on their own, instead of the second passing on the first one's confirm.
- **Prompt icons draw in the Run terminal** — Branch icons and powerline separators from prompts like starship now use the Nerd Font you have installed instead of showing as empty boxes. Text in the terminal still uses JetBrains Mono.

### Maintenance

Pin the palette's middle-truncated rows to their own ellipsis (#999) · Pin the Logbook project option's head on its own ellipsis (#871) (#998)
