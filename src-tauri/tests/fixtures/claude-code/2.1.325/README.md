# Claude Code contract fixtures — v2.1.325 (synthetic only)

Not a recording. This directory holds a `SYNTHETIC` file instead of `VERSION`,
so `claude_code_contract.rs` doesn't run the full recording suite on it; only
the tests that name these files read them. When a real 2.1.325 (or later)
recording is made, carry these files into it by hand.

## Provenance

| File | Surface | Source |
|---|---|---|
| `stream-json/stopped-with-subagent.jsonl` | a `claude -p --output-format stream-json --verbose` run stopped before its `result` event (no result line): an Opus 5 main-session message that spawns an `Agent`, then two content-block events of ONE subagent message (`parent_tool_use_id` set) answered by `claude-haiku-4-5-20251001`. Every `assistant` event carries `message.model` | **synthetic** — the event shape is copied from the real 2.1.314 recording (`message.model` is on every recorded `assistant` event there, dated for Haiku); the subagent-on-another-model case follows the subagents docs ("To choose its model yourself, set the `model` field in its definition") and the 2.1.325 changelog ("Fixed subagents on a different model sizing file reads and MCP results with the main session's model") |
