## Octopush 0.4.151

### Features

- **The Octo in the menu bar counts crews that need you** — The Octo now sits in the macOS menu bar with the number of crews that need you. Its menu lists them, the longest-waiting first, and opens the one you choose, even with the window closed.

### Improvements

- **Talk approvals wait for you, and say so** — A command in Talk that needs your approval now waits until you answer, instead of being denied after five minutes. While it waits, the rail, Mission Control, the Dock badge and the menu bar show it, and you get a notification. With the card focused, ⌘↵ approves and Esc denies.
- **Talk shows @ attachments as chips under your message** — A message with `@` files, ranges, sessions or the diff now shows what you typed, with a chip per attachment that opens it in place. From the next turn on, an attachment of 8,000 characters or more is sent shortened, and the model can fetch it whole again when it needs it.
- **A failed command in Talk reads as failed** — In Talk, a tool call that failed now says so after it ends: a rouge mark and its exit code or the reason, such as `exit 1` or `timed out`. A command you denied is marked in mute, and a folded round counts its failures.
- **Talk rides out a busy provider, and Stop is instant** — When the provider is overloaded or rate-limited, or the connection can't be opened, Talk now retries on its own, and the Octo says so ("Model overloaded — retrying in 8s"). Stop ends the request in flight at once instead of waiting for the whole answer.

### Fixes

- **MCP results in Talk stay small** — An MCP tool that returns an image or a file no longer pours its base64 into the conversation: the tool card and the model see a short note such as "[image omitted: image/png, 48 KB]". Very long MCP results are trimmed for the model, which can still read them in full, and MCP tools keep one order, so Talk reuses its prompt cache instead of paying for it again each message.
- **Talk's shell runs commands with ! and tabs as written** — A command with `!` in it, such as `node -e "if (!x) …"` or `git commit -m "Fix it!"`, no longer fails with "event not found" in Talk's shell, and a heredoc keeps its tabs, so a Makefile written that way works.
