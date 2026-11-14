## Octopush 0.4.122

### Improvements

- **Legacy themes get their own group in Appearance** — Settings › Appearance now shows theme names in title case and lists the legacy themes (Dark, Midnight, Solarized Dark) in their own group below Atelier and its sibling palettes.
- **Move a Fable 5.1 crew to Fable 5.2 in one click** — When a crew still uses Fable 5.1, as a stage model or an escalation model, the Direct launcher offers **Switch this crew**: it moves that crew to Fable 5.2, which costs about 20% less per token. **Keep 5.1** hides the offer for that crew. Nothing switches unless you ask.
- **Quieter brass in Models and Integrations** — Settings › Models and Settings › Integrations use brass for the selection and one save action only. "Connect another provider", "Bring in another model", "Save the link", "Connect to Claude Code" and "Copy" are now ghost buttons.

### Fixes

- **Codex stages keep their writes in the worktree** — A Codex CLI stage that changes files now runs in Codex's own workspace-write sandbox. Its commands can write only the worktree and the temp dirs, with the network still on, so they can't commit in a linked worktree. Inside a sandboxed mission, Octopush's sandbox confines it as before.
