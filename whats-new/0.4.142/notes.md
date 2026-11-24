## Octopush 0.4.142

### Features

- **Comment on a plan inline before you approve it** — When a Direct run stops at a gate, select a passage of the stage's output and use **Comment** (or move over the passages with the arrow keys and press Enter) to add a note to it. **Send back** and **Reject** send each quoted passage with your note, in document order. **Approve with comments** passes them to the next stage as guidance for that pass.
- **Comment on the diff and send it to the agent** — In Review, leave a comment on a hunk (the speech-bubble icon or `m`) or on lines of it. The comments collect in the Companion; **Send to the agent** sends them as one message, to the mission's Talk thread or, when a crew waits at a review gate, as its Send-back feedback.
- **New missions can borrow node_modules and .env** — The new-mission setup step lists what your main checkout has and git ignores: link `node_modules` or `.venv`, copy `.env` files. A linked folder is the main checkout's own folder, so an install in a mission changes it everywhere. Agents in the mission can read a copied env file. Sandboxed missions get neither, and Routines and MCP workspaces don't share.
- **Hand Talk line ranges, folders, session output and the diff** — Talk's `@` now takes `@path#L10-40`, `@folder/` (its files and sizes), `@session:name` (the last 200 lines a Run session shows) and `@diff` (staged and not staged). Each one shows as a removable chip with its token estimate. In Review, select some lines and choose **Ask Talk about this**.
- **Rewind a Talk turn's files, or fork from it** — Talk takes a checkpoint before each turn that can change files in a git repository. Hover a message you sent: **Rewind files to here** shows what will change and what it leaves untouched (git-ignored files always are), then offers an undo for a few seconds. **Fork from here** starts a new conversation. Checkpoints are git objects under `refs/octopush/talk/`, untracked files included.

### Improvements

- **Mode shortcuts follow the switcher, left to right** — The mode shortcuts now count left to right along the mode switcher: **⌘⇧1** is Run and **⌘⇧2** is Talk (they were the other way around). Review stays ⌘⇧3, and Direct stays ⌘⇧D because macOS keeps ⌘⇧4 for screenshots.

### Fixes

- **The Direct ledger states its savings once** — The Direct run ledger no longer draws a brass bar under its line. The bar filled to the share spent while the text printed the share saved, so the two read as opposite numbers.
- **Gateway-named Claude stages keep the full prompt** — Since Claude Code 2.1.330, a Claude model under a gateway's name (`anthropic/claude-sonnet-5.5`) got the shorter system prompt. Direct stages on such names now keep the full one, and the launch line says "full Claude Code prompt (gateway name)".
- **The palette lists numbered workspaces in number order** — When workspaces in the ⌘K palette were last active at the same moment, it sorted their names as plain strings, so *rollout-10* came before *rollout-3*. Now the numbers inside names sort by value.
- **The secret guard sees a key header added over a key body** — A commit that added only the `BEGIN … PRIVATE KEY` line above key material already in the file went through without a question. The guard now reads the unchanged line under the header, so it asks.
