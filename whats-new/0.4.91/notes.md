## Octopush 0.4.91

### Improvements

- **Octopush tells you when Claude Code needs an update** — Octopush now reads your Claude Code CLI version. If it is older than the version Octopush is tested with, Settings › Integrations and the Direct launcher show an amber **Update Claude Code** note: older releases can record wrong token usage and skip sandbox rules. Runs still start.

### Fixes

- **1-hour prompt-cache writes are priced correctly** — Claude Code writes to the 1-hour prompt cache now cost 2× the model's input price, as Anthropic bills them, instead of the 5-minute rate. Run spend from transcripts and stages is no longer under-counted, and savings are no longer overstated.
