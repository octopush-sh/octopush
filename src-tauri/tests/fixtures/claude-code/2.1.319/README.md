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

Each file is the result line only (the events before it carry nothing these
tests read). The exit codes aren't in the files; the tests pass them.
