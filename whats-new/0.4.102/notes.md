## Octopush 0.4.102

### Features

- **Set reasoning effort on Claude Code stages** — CLI stages that run Claude Code now honour the stage's **Reasoning** and **Escalate on failure** effort, passed as `claude -p --effort`. A `CLAUDE_CODE_EFFORT_LEVEL` exported in your shell no longer overrides it, and the cost estimate learns each effort separately.

### Improvements

- **The Usage page keeps its shape while it loads** — Settings › Usage now lays out its totals, mode cards, trend, spend rows, models and tokens as quiet placeholders while a large ledger is read, and the figures fade into those places. A change of period keeps the previous figures until the new ones arrive, and a small "reading the ledger…" note sits in the filter bar meanwhile.
- **The welcome screen speaks with one voice** — On the welcome screen, the API-key button now reads **Wake the crew** in the same serif voice as the other actions. **or think it through first** is underlined like its sibling links, so it reads as clickable.

### Fixes

- **A stage that finished on a full disk keeps its work** — When Claude Code finishes a stage but can't save its session (a full disk or quota), the stage now says so and shows the free space, instead of reporting the agent's own summary as the error. The result is kept, so you can accept it once space is free, and the run no longer retries it on a stronger model.
- **The Review status line no longer ends in an ellipsis** — The mode band's Review status ("2 files changed · +2 −1") no longer gets cut to "2 files changed · …" when the canvas is narrow. It drops whole parts instead, "changed" first and then the line counts, so it always ends on a complete value, and the full reading stays in its tooltip.
