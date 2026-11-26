## Octopush 0.4.145

### Features

- **Hear from your crews when you're away from the Mac** — Turn on **Notify me elsewhere** in Settings › General to get a webhook message when a crew needs your decision, a crew run fails, or a Routine finishes, also from crews that keep working after you quit. It carries a fixed label, the project's name and the mission's title (the start of its task), never code, diffs, questions or agent output.
- **Filter the rail by state, and archive merged missions** — The rail filters by state: **Needs you**, **Working** or **Idle**, counted like the fleet chip. A mission whose PR is merged and whose worktree is clean offers **merged · archive?**; the project menu archives them all, after listing them. Each is checked again when you confirm, and skipped with a reason if it changed. Local files git ignores are named first: Undo can't bring them back.

### Improvements

- **Octopush names Claude Code 2.1.329 as a release to skip** — Claude Code 2.1.329 dropped the retry that gateway models need when a `max_tokens` error names a lower limit, and 2.1.330 put it back. Readiness and the Direct launcher now warn when this Mac has that release. A gateway stage that fails this way names the release and asks you to update.
- **A hook-paused stage names the call it paused** — When a hook pauses a tool call, the halt and the journal now show which call it was, such as `Bash · npm publish --tag beta`. If a resumed session is waiting on a tool that's no longer available, **Drop the call and continue** resumes it without that call.
- **Review's send-back carries the gate's comments** — **Send to the agent** now sends back a waiting gate with the comments you wrote on its stage's output at the gate, in the same message. In Review, ⌥↑ ⌥↓ pick lines from the keyboard, and a half-typed note waits in its workspace when you switch away.
- **Talk checks attached context for secrets before sending** — Before a Talk message is sent, the secret guard now reads every `@` block it attaches, a diff file by file, and asks first when one holds what looks like a credential or can't be checked. A message attaches up to 10 mentions, a line range reads only its lines, and paths with spaces or non-ASCII names work.

### Fixes

- **A resume that comes back empty reruns the stage fresh** — When Claude Code resumes a stage on an empty conversation, the stage is stopped and run fresh with its full input (and your answers, if you answered its questions). The journal names it, and on Claude Code below 2.1.330 says the update fixes it.
- **GPT-6.2 Astra and Sol reuse the cached system prompt** — Talk on GPT-6.2 Astra and Sol now reuses its cached system prompt, so long chats cost less. Direct's API stages on GPT-6.2 Astra and Sol save the same way.
- **History keeps "+ unpriced" on very long runs** — A run too large to sync whole has its last stages folded into one summary. If one of those stages had no price, History now still marks the run's total "+ unpriced" instead of showing it as complete.
- **Talk reconnects MCP servers after their config changes** — Saving an MCP server's config now restarts Talk's connection to it, a server whose process died starts fresh on the next call, and **Reconnect** in Settings › Integrations restarts one by hand. A bare command such as `npx` is now found on your login shell's PATH.
- **Settings panes share one width** — Every Settings pane now lays its cards and notes out in the same column, so the right edge no longer jumps as you move between tabs. Models and Integrations split their two columns inside it. The wording is unchanged.
- **Talk no longer cuts a reply's first line at a URL** — The serif first line of a Talk reply now ends only where the sentence does. A dot inside a URL, inline code, a link, a version like `v0.4.141`, a number or a file name no longer splits it, and a first sentence that carries a URL or a link stays in the body, whole and clickable.
- **Talk's shell finds Homebrew, nvm and other PATH tools** — Commands in Talk, yours (`$`) and the agent's, sub-agents' included, now run with your login shell's PATH, as Direct's CLI stages do, so `gh`, `node` and tools from Homebrew, nvm or similar are found. When a program still isn't found, the result says so, so the agent doesn't take it as not installed.

### Maintenance

Fix flaky PrComposer secret-guard test: press Escape only once the guard listens (#1077)
