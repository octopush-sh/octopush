## Octopush 0.4.141

### Improvements

- **Secret guard catches keystores and more MCP configs** — The secret guard now asks before a newly added `.key`, `.p12`, `.pfx` or `.jks` file leaves your machine (Keynote documents stay quiet), and checks credentials in `.claude/mcp.json` and `.vscode/mcp.json` too.
- **The secret guard now checks Talk's commits and pushes** — A commit, push or `gh pr create` run in Talk is now checked for credentials first, whether the agent runs it or you type it after `$`. You see the kind of secret and its file and line, never the value.

### Fixes

- **The Privacy list lines up** — In Settings › Privacy, the list of what stays on your Mac and what leaves is now a proper list: every item and sub-item has the same marker, wrapped lines align with the text, and the note under the toggle starts at the same edge as the rest. The wording is unchanged.
- **The secret guard checks exactly what a push sends** — Before a push, the secret guard now checks the commits that aren't on origin's copy of the branch yet, which is where the push goes. It used to start from the branch's upstream, which can be another remote.
- **A settings file from a newer build still loads** — If settings.json holds an update channel this version doesn't know, for example after going back from a newer beta, Octopush now reads it as Stable and keeps your keys, git credentials and Jira setup. When the file can't be read at all, a notice at launch names the file.
