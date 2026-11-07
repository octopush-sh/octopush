## Octopush 0.4.112

### Fixes

- **Claude Code update notes clear without a restart** — After you update Claude Code, run the Readiness check again and the launcher and stage journals stop warning, with no restart. Settings › Integrations now shows the sandbox-fix note too, and an old CLI is told to update to 2.1.319, not to a version that still lacks the fix.
- **The Companion says a starting shell is starting** — While a Run session's shell is still starting, the Companion now reads **starting** instead of *shell idle*, so the canvas and the inspector never disagree about one session.
- **Quieter ink in Privacy, About and Account** — File paths in Settings › Privacy now sit on the code chip in plain ink, and the About links are sage instead of brass. Sync rows in Account stay at full ink while a change saves, so only a row you can't use looks dimmed.
