## Octopush 0.4.130

### Features

- **Run sessions move into the mode band** — The session strip beside the terminal is gone: your sessions are icons in the mode band, with a layout button for one to four panes. Each pane's caption is its session's one home: name, what it is doing, rename, and a **⋯** menu with **Close session**. A pane's minus only takes it off screen; the session keeps running.

### Improvements

- **Read-only stages can list stashes and say what they drop** — Read-only stages (Reproduce, Verify and the reviewers) may now run `git stash list` and `git stash show`, and refuse file edits on every substrate. When a custom read-only role's saved tools include file edits, the stage journal says they were removed.
- **Review shows what a crew committed** — After a Direct run commits its work, Review no longer says "Nothing to review". **Since base · N commits** shows the branch's committed changes against its base, read-only, and **Working tree** keeps hunk-by-hunk Accept and Reject for uncommitted edits.
- **More room for the canvas** — The gaps around the workspace header, the mode switcher and the canvas are now 8px, and the header is a little slimmer. At the same window size the canvas is 16px wider and 32px taller in every mode.

### Fixes

- **An aborted run's track no longer looks live** — After an abort, the stage the run stopped on shows a muted "aborted" mark on the run track instead of "running" or "review", and its work journal is back after you reopen Octopush.
- **Aborting a run asks first and reads as aborted** — Abort on the decision bar now asks before ending the run. Afterwards the stage pane shows the run as aborted instead of "Waiting for you", and the fleet chip no longer counts an aborted run as done.
- **Budgets no longer park a run on a stage counted twice** — Right after a Claude Code Direct stage finished, its spend could briefly count twice, so a run near a USD budget was parked for no reason. The duplicate is now removed the moment the stage reports its session.
- **Commits and clones are safe with any text under fish** — Commit, amend and clone now pass the message, URL and target folder to git through the environment instead of quoting them into a shell command, so a backslash next to a quote can no longer break out of the quotes when your login shell is fish.
- **Long GPT-6 prompts are priced at OpenAI's long-context rates** — A GPT-6 request over 272,000 input tokens now costs what OpenAI bills: twice the input and cache price and 1.5 times the output price. Talk turns and one-shot AI calls show the true figure; Codex stages still price at the short-context rate.
- **GPT-6.2 Astra and Sol, and every GPT-6 model, priced** — GPT-6.2 Astra and GPT-6.2 Sol are in the OpenAI model list. They, GPT-6 Astra, Sol and Luna, and GPT-6.1 Sol now have prices, so their Talk turns, API stages and Codex stages count toward cost and savings instead of reading unpriced.
- **Rail, palette and context-size polish** — The rail now scrolls the active workspace into view, and a stray monogram such as "ß" falls back to the workspace's initial. ⌘K shows three models until you type, with **Show all models** for the rest. Context reads the same everywhere, so a 1M window is "1M", never "1000K".
- **No false "ran on" note for Bedrock or Foundry ids** — A Direct stage whose Claude Code session reported a Bedrock inference-profile ARN or a Microsoft Foundry deployment name was flagged as running on another model, and its cost went unpriced. It now shows no note and keeps its cost on the model it asked for.
- **Reproduce, Verify and review stages stay read-only** — Reproduce, Verify and review stages could apply the change themselves and commit it, so a Bugfix relay landed the fix three times. They are now told plainly not to edit files or commit; API stages also lose the file-write tools and Claude Code stages are denied git commits and pushes. They still run commands to reproduce, build and test.
- **Steadier Since base view, palette and aborted run track** — Review's **Since base** view stays put while a crew edits files, and a jump from the Changes rail opens the working tree. After **Show all models**, ⌘K keeps the highlight on the first new model. A selected card on an aborted run keeps its highlight.
