## Octopush 0.4.148

### Improvements

- **Account actions read like the rest of Settings** — In Settings › Account, **Manage your account ↗**, **Sign out of Octopush** and the sign-in's **Cancel** now use the same serif voice and button shape as the other panes' actions, instead of looking like code chips.
- **See what a repo's own hooks and MCP servers run** — When a crew has a Claude Code stage, the Direct launcher now lists the hooks, status line and MCP servers the repo's committed `.claude/settings.json` and `.mcp.json` run, and says when they run inside the sandbox.

### Fixes

- **Readiness recommends Claude Code 2.1.331** — The Readiness card in Settings › General now lists the Claude Code fixes you're missing, not only the newest. It names 2.1.331's fix for MCP calls that can hang for up to 30 minutes on a local or WebSocket server, and 2.1.330's fix for lost settings saves, to everyone on an older Claude Code, not only while a Run session runs it.
- **Long-prompt requests on the API pay the long-prompt rate** — Direct stages on the API and Talk sub-agents now price each request on its own, so a Haiku 5.5 request over 100K prompt tokens, or a GPT-6 request over 272K, costs the long-prompt rate in spend and savings. A stopped, stalled or crashed Claude Code stage's estimate does the same for Haiku 5.5. A finished Claude Code stage still shows Claude Code's own figure.
- **A timed-out MCP call stops only its own server process** — When a Talk MCP call times out, Octopush now stops the process that call was on, not a newer one started since. A server's output in an error is shorter, with tokens and auth codes redacted. A login shell whose background job keeps running no longer costs you its PATH.
