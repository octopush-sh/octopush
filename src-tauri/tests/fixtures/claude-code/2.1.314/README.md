# Claude Code contract fixtures — v2.1.314

Recorded output of the `claude` CLI that Octopush parses. The tests in
`src-tauri/src/claude_code_contract.rs` feed every file here to the
production parsers; when Claude Code changes a format, one test fails and
its message names the fixture and the missing field.

Every directory under `tests/fixtures/claude-code/` that has a `VERSION` file
is tested, so a new recording is covered as soon as it is committed.

## Provenance

| File | Surface | Source |
|---|---|---|
| `stream-json/simple.jsonl` | `claude -p --output-format stream-json --verbose` | **real** |
| `stream-json/tool-use.jsonl` | same, one `Read` tool call | **real** |
| `stream-json/resume.jsonl` | `--resume <session_id>` continuation | **real** |
| `stream-json/error-unknown-model.jsonl` | API error (`is_error: true`, `subtype: success`) | **real** |
| `stream-json/init-with-definitions.jsonl` | `system/init` listing the fixture skill + agent | **real** |
| `transcript/<session>.jsonl` | `~/.claude/projects/<cwd>/<session>.jsonl` | **real** |
| `cli-help.txt` | `claude --help` (flags Octopush passes) | **real** |
| `mcp/*` | `claude mcp add --help`, `mcp add`, `mcp get`, the `mcpServers` entry written | **real** |
| `definitions/skills/fixture-skill/SKILL.md`, `definitions/agents/fixture-reviewer.md` | frontmatter incl. the custom `effort:` key | hand-written; **loaded by the real CLI** (see `init-with-definitions.jsonl`) |
| `pty/tui-render-sample.ansi` | raw TUI bytes from an interactive start | **real** (the session could not connect, so it shows the error screen) |
| `pty/total-cost-tail.ansi`, `pty/total-cost-tail.txt` | the `Total cost:` summary | **synthetic** — the `/cost` layout, rendered with the cursor-move encoding observed in `tui-render-sample.ansi` |

Recorded in a Linux container (not the owner's Mac) on 2026-10-29 with
`claude-haiku-4-5`. Recording-environment notes:

- `stream_event` lines (partial-message deltas) were emitted because the host
  enables partial messages; the scrubber drops them — Octopush never asks for
  them. `active_goal`, `autocompact_state`, `rate_limit_event` and the various
  `system/*` subtypes are kept (reduced to their type) so the tests prove the
  parsers ignore event types they don't know.
- The host pinned one session id for every run, so all runs share one
  session and one transcript file. On a normal machine each fresh `-p` run
  gets its own id; the tests don't depend on either.
- `--max-turns` is not listed in `claude --help` but is accepted (every
  recording above passed it); the argv test allows it explicitly.

## Re-recording

On a machine with a logged-in `claude`:

```sh
scripts/record-claude-fixtures.sh          # writes tests/fixtures/claude-code/<claude --version>/
cd src-tauri && cargo test claude_code_contract
```

It runs exactly these (in a fresh temp directory containing `note.txt`):

```sh
claude -p "Reply with exactly: ok" --output-format stream-json --verbose --model claude-haiku-4-5 --tools "" --max-turns 1
claude -p "Use the Read tool to read note.txt, then reply with exactly its contents." --output-format stream-json --verbose --model claude-haiku-4-5 --tools Read --allowedTools Read --max-turns 3
claude -p "Now reply with exactly: resumed" --output-format stream-json --verbose --model claude-haiku-4-5 --resume <tool-use session_id> --tools "" --max-turns 1
claude -p "Reply with exactly: ok" --output-format stream-json --verbose --model claude-nonexistent-model-0 --tools "" --max-turns 1
# …again with .claude/skills/fixture-skill/SKILL.md and .claude/agents/fixture-reviewer.md present
claude --help
claude mcp add --help
HOME=<throwaway> claude mcp add octopush -s user -- /Users/dev/Applications/Octopush.app/Contents/MacOS/octopush-mcp
HOME=<throwaway> claude mcp get octopush
```

then copies `~/.claude/projects/<cwd, non-alphanumerics → '-'>/<tool-use session_id>.jsonl`
— the only file it reads under `~/.claude` — makes a best-effort interactive
capture (`/cost`, `/exit`) and runs the scrubber. Three of the calls are
billed (a few cents); the nonexistent-model calls fail before any tokens.

## Scrubbing rules

`scripts/scrub-claude-fixtures.py` (run by the recorder; can be re-run on a raw
directory by hand) applies them, then refuses to finish if a leak survives:

- **Whitelist, not blacklist.** Every JSON line is rebuilt from the fields
  the parsers read plus a few structural ones. Unknown event/line types keep
  only `type`/`subtype`/ids. A field Claude Code adds later never reaches the
  repo by default.
- The recording cwd → `/Users/dev/project`; the throwaway HOME → `/Users/dev`.
- Session ids → `aaaaaaaa-0000-4000-8000-00000000000N`; other UUIDs →
  `00000000-0000-4000-8000-…`; `msg_…`/`req_…`/`toolu_…` → `msg_fixture_NNNN` etc.
  (consistent within a recording, so per-message folding still works).
- Thinking text and signatures are emptied; other text is capped at 200
  characters (the prompts are tiny test strings anyway). The `system/init`
  `agents`/`skills` lists keep only `fixture-*` entries; its `tools` drop
  `mcp__*` (those come from the recording machine's config).
- Leak check: no `/home/`, `/root`, `/tmp/`, `/private/`, `/var/folders`,
  `$HOME`, `sk-ant`, `org_` or `@` anywhere. Review the diff yourself anyway
  before committing.
