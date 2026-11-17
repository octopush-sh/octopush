# Claude Code contract fixtures — v2.1.326 (partial, not a full recording)

Not a full recording. This directory holds a `SYNTHETIC` file instead of
`VERSION`, so `claude_code_contract.rs` doesn't run the full recording suite on
it; only the tests that name these files read them. When a full 2.1.323 (or
later) recording is made, carry these files into it by hand.

## Provenance

| File | Surface | Source |
|---|---|---|
| `stream-json/settings-refused.jsonl` | the `result` of a `claude -p --output-format stream-json --verbose` run whose `--settings` turn the sandbox on and fail validation: `subtype: error_during_execution`, `is_error: true`, `num_turns: 0`, `errors: ["Sandbox required but unavailable: … failed validation, so none of them apply (<key>: <reason>). …"]`, `startup_failure_reason: "sandbox_required_unavailable"`; exit 1. No other event comes before it | **live** — recorded with Claude Code 2.1.326 on Linux, fresh `HOME`, signed out (the run stops before any request), `--settings '{"permissions":{"blockWritesOutsideWorkingDirectories":"yes"},"sandbox":{"enabled":true}}'`. `session_id` and `uuid` replaced with fixed values |
| `stream-json/settings-refused.stderr.txt` | that run's stderr: `Error: sandbox required but unavailable: … failed validation … (<key>: <reason>). Fix them and start again` and a `Refusing to start without a working sandbox` line | **live** — same run |

The behaviour arrived in 2.1.323 (changelog: "Fixed `claude -p` and the Agent SDK
running Bash unsandboxed when `--settings` or SDK settings that turn the sandbox on
fail validation; Claude Code now stops at start-up and names the invalid setting").
In the same run with the sandbox turned on only in the user's own
`settings.json`, an invalid `--settings` value did not stop start-up. The exit
code isn't in the files; the tests pass it.
