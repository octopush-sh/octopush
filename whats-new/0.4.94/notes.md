## Octopush 0.4.94

### Features

- **See your Claude plan's 5-hour and weekly headroom** — On a Claude Pro or Max plan, Claude Code stages now report your plan's 5-hour and weekly windows. The Companion shows them during a run, with a calm note near the limit, and Settings › Usage lists each one, when it resets and how old the reading is.
- **Open the pull request from Review** — After **Publish branch**, Review offers **Open a pull request**: a drafted title and description from the diff, the linked ticket and the agents that built it — filling your repo's PR template — then `gh pr create`, as a draft if you like.

### Improvements

- **Claude plan headroom handles extra usage and old readings** — Extra usage on your Claude plan now reads as **extra usage**, and as unavailable rather than "used up" when it is off. A plan reading more than a week old whose windows have reset is no longer shown, so it clears after you move to an API key.
- **Pull requests from forks and onto any remote's branch** — The PR composer now opens pull requests from a fork, onto a base on any remote (`upstream/main`) and onto the repo chosen with `gh repo set-default`. Picking another base drafts again, and a branch with no changes can't be opened.
- **Run now shows a Routine's setup as it runs** — **Run now** on a fresh-workspace Routine shows what it is waiting on, and a failed setup gets its own toast. A failed setup never deletes a checkout Octopush didn't create. The new-mission wizard says when its script becomes the project's setup script.

### Fixes

- **Similar chats are easier to tell apart** — In the Chats list, long titles wrap to a second line instead of being cut short, and hovering a row shows its full title. Chats from today show the time of their last message (**14:32**) instead of **just now** or **5m ago**.
- **The Run canvas says when a shell is still starting** — A new session no longer shows a blank pane while its shell starts. The Run canvas reads **Starting shell in ‹workspace›…** until the prompt appears.
- **Stopping a run also stops the servers it started** — Stopping a stage, aborting a run, or a stage hitting its time limit now ends the Claude CLI gracefully, together with everything it started. Dev servers and watch builds no longer keep running in the worktree or holding onto their ports.
- **Setup scripts now run when a mission is created** — The setup script from the new-mission wizard now actually runs: a **setup** terminal opens in the new worktree with its output and exit code, and a failure offers **Open the setup terminal**. Reused workspaces never re-run it, and a Routine's fresh worktree runs the project's script before its crew.

### Maintenance

web-audit: install and build the site in one sandboxed call (#376) · web-audit: give token revocation up to a minute to propagate (#374)
