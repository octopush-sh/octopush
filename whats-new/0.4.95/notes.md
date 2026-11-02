## Octopush 0.4.95

### Features

- **See what a run will likely cost before you begin** — The Direct launcher now shows a cost range, such as **est. $0.40–$1.10 · saves ~62% vs all-premium**. It comes from this Mac's recent completed runs of each role and effort, priced at the models you chose. With little history the range is marked "rough", and a model with no price shows as unpriced, never $0.

### Improvements

- **The journal shows Claude Code retries and skipped tools** — When Claude Code retries an API call, the stage journal now shows why, which attempt it is and when the next one starts, so a stage that is retrying no longer looks stuck. The journal also lists any MCP server or plugin that failed to load at the start of a stage.
- **Budgets now stop Claude Code stages mid-flight** — A run budget now caps each Claude Code stage at the budget it has left, the same way API stages already stop. A stage that reaches it pauses the run with the work and session kept, so you can resume, accept the partial work or re-run. It never escalates to a stronger model.
- **Claude Code stages finish when their result arrives** — A Claude Code stage that starts a dev server or a watch build in the background no longer holds the run for five minutes or more after it finishes. Octopush waits 30 seconds after the stage's result, then stops the CLI and moves on, and the journal says so.
- **Review keeps its controls whole when space is tight** — When the Review area is under 760px wide, the Changes and Files list folds to its icon strip. When the diff canvas itself is under 600px, the layout, whitespace and test controls move into a **More** menu. AI, Accept all and each hunk's Accept and Reject always stay fully visible.

### Maintenance

nightly-build: PR fix rounds start from the branch merged with main (#394) · agents: pass the prompt on stdin (reviewer hit E2BIG on large PRs) (#390)
