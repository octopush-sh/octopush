## Octopush 0.4.152

### Features

- **Your runs now suggest which stage is on the wrong model** — Once a crew has 8 runs on this Mac, the Direct launcher can suggest a change, such as starting a stage that usually escalates on the stronger model. The builder's stage inspector shows each stage's **Track record**: first-pass, loop and escalation rates and the median cost.
- **See the skills and sub-agents Talk can use** — The Companion's **can use** row now counts the conversation's skills and sub-agent types beside its MCP servers. Open either to see each one's description and where it comes from; a skill adds `/name` to your message, and an agent shows its tier or model and the tools it may use.
- **Talk follows your CLAUDE.md** — Talk and its sub-agents now follow your `CLAUDE.md` files and the project's, with their imports, or `AGENTS.md` when there is no `CLAUDE.md`. A repository file that points outside its repository is never read. Edits apply on the next turn, and the Companion's **follows** row lists the files.
- **Talk picks the skill a task needs** — Talk now sees your skills' names and descriptions and loads the one a task matches by itself, so it works without remembering `/name`. Sub-agents can load skills too. A skill's `allowed-tools` hold for the rest of the turn, and `/name` works as before.

### Improvements

- **The file finder names its mode in the search line** — The ⌘P and ⌘⇧F palette drops its Files/Text tab strip and its file count. The mode now reads at the start of the search line, and the footer says where **Tab** takes you.
- **Calmer model list in Settings › Models** — Settings › Models lists a provider's models as plain rows on one hairline, without a frame around each one. Edit and remove are quiet icons that show when you hover or focus a row.
- **Usage says when your organization sets Claude Code's rates** — When your organization's managed Claude Code settings set its own rates (`modelPricing`), Settings › Usage now says so. Finished Claude Code stages and their `--max-budget-usd` cap use those rates, while Talk, stopped stages and the savings baseline use list prices, so totals can mix the two.
- **Long Talk turns keep going as tool results pile up** — A long Talk turn no longer stops when its own tool results fill the model's context window: older ones are shortened in the request, and the model can still read them whole. When a model refuses a prompt as too long, Talk shortens it and retries once. A conversation whose earlier turns alone fill the window can still end the turn.
- **Swift and Deep set how hard Talk thinks** — Swift now asks for the least reasoning each model takes, never more than Standard, and Deep for the most it takes (or a thinking budget, on models that use one), as well as their output caps. Standard sends no effort setting: each model keeps its own default. Sub-agents keep their tier's effort.

### Fixes

- **A remote MCP entry no longer hides your other servers** — An entry in `~/.claude/mcp.json` written as `"type": "http"` or `"type": "sse"` with a `url` (and optional `headers`) now loads as a remote server in Settings and Talk, through the same mcp-remote bridge as the Remote form. An entry Octopush can't run is skipped on its own, and a save from Settings keeps it in the file as it was. Before, either one made every server in the file disappear.
- **Mission Control's bands read as separate groups** — In Mission Control, each band's label (Needs you, In flight, Settled) now sits right above its own cards, with more room above it, so it no longer floats halfway between two bands.
- **A project's skills and agents stay inside the project** — A project's skills and agent definitions are read only when they resolve inside its own repository, and every file is size-checked first. The `/` menu names a skill it left out as "skipped: outside the project". Your own skills and agents in `~/.claude` load as before.
- **Talk asks before MCP writes and files outside the workspace** — Talk now asks before it calls an MCP tool that isn't marked read-only, and before it reads or writes a file outside the workspace, links included. Places that usually hold credentials, such as `~/.ssh`, say so and lead with Deny. A file outside the workspace asks every time.
- **More risky agent commands ask before they run** — Talk's command check now reads commands inside `$(…)`, backticks and `bash -c "…"`, knows `/bin/rm` is `rm`, and asks before a `+main` push, a remote branch delete, a downloaded script run through `bash <(curl …)`, or a `curl` upload of a dotfile such as `.env`.
- **Talk asks before commands that reach outside the workspace** — An agent command that names a place that usually holds credentials, such as `~/.ssh/id_ed25519`, now asks first and leads with Deny, through braces, globs, links and `cd` too. Other outside paths ask, except system folders, and a folder can be allowed for the conversation. A path built while the command runs isn't seen: it is a net, not a sandbox.
- **Talk marks tool and MCP output untrusted** — Every tool and MCP result Talk's agent reads now names where it came from and is marked untrusted, and the agent is told never to follow instructions found in it unless you asked.
- **Each conversation runs its own turn, with its own Stop** — Switching back to a conversation whose turn is still running shows it running, and Stop reaches that turn. A conversation never runs two turns at once, and switching quickly between conversations can no longer show one's messages under another or let Edit & resend cut the wrong history.
- **Talk stays read-only in a read-only mission** — In a workspace whose mission is read-only, Talk and its sub-agents now refuse MCP tools whose server doesn't mark them read-only, agent types that write, and commands that change something elsewhere, such as `git push`. A command the read-only sandbox stops now says why.

### Maintenance

Entitlement token: drop the iat check, add the key checklist and mutation tests (#1204)
