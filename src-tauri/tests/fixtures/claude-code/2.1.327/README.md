# Claude Code contract fixtures — v2.1.327 (partial, not a full recording)

Not a full recording. This directory holds a `SYNTHETIC` file instead of
`VERSION`, so `claude_code_contract.rs` doesn't run the full recording suite on
it; only the tests that name these files read them. When a full 2.1.327 (or
later) recording is made, carry these files into it by hand.

## Provenance

All six files are **live**: the stdin payload a command hook received from
Claude Code 2.1.327 on Linux, with a fresh `HOME`, signed out (no request was
ever sent, so nothing was billed), hooks registered in the project's
`.claude/settings.local.json`. Session ids, the prompt id and the paths were
replaced with fixed values; nothing else was changed.

| File | Surface | How it was produced |
|---|---|---|
| `hooks/session-start-startup.json` | `SessionStart` when the terminal UI starts: `source: "startup"`, with `model` | `claude` in a pty |
| `hooks/session-end-clear.json`, `hooks/session-start-clear.json` | `/clear`: `SessionEnd` (`reason: "clear"`) for the old session id, then, 28 ms later, `SessionStart` (`source: "clear"`) for a **new** session id | `/clear` typed in that session |
| `hooks/session-end-exit.json` | `SessionEnd` on `/exit`: `reason: "prompt_input_exit"` | `/exit` typed in that session |
| `hooks/session-start-print.json`, `hooks/session-end-print.json` | print mode fires both too: `source: "startup"` (no `model` while signed out) and `reason: "other"` | `claude -p hi` |

## What the same runs showed that is not in a file

- **The hook's environment says how the session was started.** `CLAUDE_CODE_ENTRYPOINT`
  was `cli` for the terminal UI and `sdk-cli` for `claude -p`. `octopush-mcp hook` reads
  it (`agent_adapter::ENTRYPOINT_ENV`) so that a `claude -p` an agent runs inside a Run
  terminal, which inherits `OCTOPUSH_TERMINAL_ID`, is never taken for that terminal's
  session. The variable is not part of the payload, so no file pins it: re-check it when
  re-recording (`env | grep CLAUDE_CODE_ENTRYPOINT` in a `SessionStart` hook).
- **Order on `/clear`:** end of the old session first, start of the new one second. The
  poller applies rows in queue order and relies on it.
- **A closed terminal** (the pty's master closed, so `SIGHUP`): `SessionEnd` fired with
  `reason: "other"`. A process killed with `SIGKILL` can fire nothing.
- **A synchronous `SessionEnd` command hook completed on `/exit`, on `/clear`, on a closed
  terminal and at the end of a `-p` run.** Octopush installs its `SessionEnd` hook
  synchronous for that reason; an `async` one also completed in these runs, but the
  changelog records async hooks being cancelled when a session ends.

## Not verified here

- That a `SessionStart` hook's stdout is added to the conversation could not be observed
  signed out. It is documented behaviour (and the changelog's 2.1.295 entry, "an async
  SessionStart hook's unchanged context being added to the conversation again on every
  resume", says it holds for `async` hooks too), so Octopush's session hooks run a command
  that discards stdout and stderr in the shell (`agent_adapter::session_hook_command`).
- `/resume`, `--resume`, `--continue` and a compaction need a signed-in session with a
  transcript. Their `source` values (`resume`, `compact`, `fork`) are from the hook input
  types; the changelog has `SessionEnd` firing on an interactive `/resume` since 2.1.79 and
  `fork` reported since 2.1.214, both below the 2.1.314 floor Octopush installs hooks at.
