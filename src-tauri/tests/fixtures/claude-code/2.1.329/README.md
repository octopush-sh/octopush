# Claude Code contract fixtures — v2.1.329 (partial, not a full recording)

Not a full recording. This directory holds a `SYNTHETIC` file instead of
`VERSION`, so `claude_code_contract.rs` doesn't run the full recording suite on
it; only the tests that name these files read them. When a full recording of
a CLI below 2.1.330 is made, carry these files into it by hand.

## Provenance

| File | Surface | Source |
|---|---|---|
| `stream-json/resume-empty.jsonl` | a `claude -p --output-format stream-json --verbose --resume aaaaaaaa-0000-4000-8000-000000000001` run that opened an empty conversation: its `system/init` names **another** `session_id` (`…0002`), and its first top-level `assistant` message reads only the system prompt (`input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` = 14,063), then a `success` `result` on that new session | **synthetic** — the fields follow `simple.jsonl` and `resume.jsonl` (2.1.314); the failure is the one the 2.1.330 changelog fixes ("Fixed `--continue` and `--resume` opening an empty session or failing"). That a normal resume keeps its session id follows from `--fork-session` ("When resuming, create a new session ID instead of reusing the original", `cli-help.txt`). Replace with a scrubbed real capture when one is made |
