## Octopush 0.4.117

### Features

- **Share a crew as a file, and import one after a review** — Export a pipeline and its custom roles as a `.octocrew.json` file from the builder, or right-click its ticket. Importing one shows each stage's tools (or the full shell a CLI stage gets), loops, escalation, instructions and models first, and never starts a run. Crews committed under `.octopush/crews/` appear in the launcher, ready to fork.

### Improvements

- **Panes now flag MCP questions too** — When an MCP server asks for your input, through a form or a link, the Run pane now reads **waiting on your input**, just as when Claude Code is waiting on you. Worktrees that already have the hooks pick this up the next time Octopush starts.
- **Review shows its change counts once** — In Review, the Companion no longer repeats the file count and +/− lines the mode band already shows, and its verdict now reads "2 files to review." instead of "2 changes", so every count on screen names its unit.

### Fixes

- **Cached input on GPT-4o is priced at its own rate** — Cached input on GPT-4o and GPT-4o mini is now priced at OpenAI's cached rate ($1.25 and $0.075 per million tokens) instead of the full input price, so their costs match your bill.
- **Large amounts read with thousands separators** — Costs and savings in the Direct Companion, the run ledger and Mission Control now group thousands, so a large figure reads **$85,393.45** instead of $85393.45.
- **Project links keep the end of long project names** — In Settings › Integrations › Project links, a long project name now elides its middle instead of its end, so `octopush-enterprise-mobile` and `octopush-enterprise-billing` no longer read the same. Hover a name for the whole of it.
- **Check again reads your Claude sign-in end directly** — Readiness's **Check again** now asks `claude auth status` when your claude.ai sign-in ends. After you sign in again the row clears at once, a fresh install shows the date before any crew has run, and after you sign out, Check again removes the old date.
