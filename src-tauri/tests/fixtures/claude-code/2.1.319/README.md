# Claude Code contract fixtures — v2.1.319 (synthetic only)

Not a recording. This directory holds a `SYNTHETIC` file instead of `VERSION`,
so `claude_code_contract.rs` doesn't run the full recording suite on it; only
the tests that name these files read them. When a real 2.1.319 (or later)
recording is made, carry these files into it by hand.

## Provenance

| File | Surface | Source |
|---|---|---|
| `stream-json/tool-deferred.jsonl` | the `result` of a `claude -p` run whose PreToolUse hook deferred a call (`permissionDecision: "defer"`): `subtype: success`, `is_error: false`, `result: ""`, `stop_reason`/`terminal_reason: "tool_deferred"`, `deferred_tool_use: {id, name, input}`; exit 0 | **synthetic** — synthesized from the 2.1.319 package text, not a live recording |
| `stream-json/resume-deferred-tool-unavailable.jsonl` | the `result` of a `claude -p --resume` with a prompt, on that session, after the deferred tool's MCP server was removed: `subtype: success`, `is_error: true`, `terminal_reason: "tool_deferred_unavailable"`, the notice naming the tool in `result`, `deferred_tool_use`; exit 1 | **synthetic** — synthesized from the 2.1.319 package text, not a live recording |
| `auth-status/signed-in.json` | `claude auth status` on a claude.ai sign-in: `loggedIn: true`, `authMethod`, `subscriptionType` and `loginExpiresAt` (when the stored sign-in ends); exit 0 | **synthetic** — the field arrived in Claude Code 2.1.318 (changelog: "Added the date a stored claude.ai sign-in ends to `claude auth status` (`loginExpiresAt`)"); its format isn't documented, so this file uses RFC 3339 text and the test also feeds epoch seconds and milliseconds. No account email or org is kept. Whether the command contacts the network is not known, so Readiness runs it (as `claude auth status --json`) only on an explicit Check again. It may refresh the OAuth token, which must not be interrupted (changelog 2.1.301, 2.1.317), so it gets 15 s, SIGTERM before SIGKILL, and is let finish at quit |
| `auth-status/signed-out.json` | `claude auth status` with no sign-in: `loggedIn: false`; exit 1 | **synthetic** — read as signed out: Check again clears the stored sign-in end |
| `auth-status/no-login-expires-at.json` | `claude auth status` from a CLI older than 2.1.318: signed in, no `loginExpiresAt`; exit 0 | **synthetic** |

Each `stream-json` file is the result line only (the events before it carry nothing these
tests read). The exit codes aren't in the files; the tests pass them.
