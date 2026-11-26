## Octopush 0.4.149

### Features

- **Add remote MCP servers by URL** — Settings › Integrations › MCP Servers can now add a remote server by its URL. It signs in through your browser, with a token, or with headers you set, and Octopush builds the `mcp-remote` bridge for you. **Clear sign-in** forgets a browser sign-in.
- **Choose which MCP servers a Talk conversation can use** — The Companion's **can use** row now lists every configured MCP server with its live status: connected with its tool count, not started yet, or failed and why. Click a server to turn it off for one conversation, and its sub-agents, and click again to turn it back on.

### Improvements

- **MCP servers explain failures and can be edited** — A failed **Test** in Settings › Integrations › MCP Servers now says what went wrong and what to try, with the full output under **Details**, where you can select or copy it. Each server can now be edited, and renamed, instead of removed and added again.
- **MCP server tokens stay in your Keychain** — Tokens, secret headers and other secret env values of your MCP servers now live in your login Keychain instead of `~/.claude/mcp.json`. Values that look like secrets move there the next time you save. A saved secret shows as **•••• saved**. Nothing new leaves your Mac.
