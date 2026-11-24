## Octopush 0.4.143

### Fixes

- **Crews can't use Claude Code's worktree tools** — Claude Code stages can't call EnterWorktree or ExitWorktree, so Claude Code's worktree tools can't move a crew's work out of the mission's worktree or remove one another session is using. Shell commands aren't covered: a stage can still run `git worktree` through Bash unless the mission is sandboxed. Readiness recommends Claude Code 2.1.330 while you run it in Run mode.
- **A stage's cost reads in ivory in the focus pane** — The Direct focus pane header now shows the stage's cost in ivory, like every other spent figure on the screen. Brass stays on the role label beside it.
- **Sandboxed crews keep running Bash with your own sandbox on** — If you turned on Claude Code's Bash sandbox, it can't start inside a sandboxed mission, and Claude Code then refused a Bash command. Octopush now turns it off in those stages, because its own sandbox already confines them, and the launch line says so. If a stage still meets that refusal, its card says so.
