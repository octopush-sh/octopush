# Claude Code contract fixtures — v2.1.332 (partial, not a full recording)

Not a full recording. This directory holds a `SYNTHETIC` file instead of
`VERSION`, so `claude_code_contract.rs` doesn't run the full recording suite on
it; only the tests that name these files read them. When a full recording of
2.1.332 (or later) is made, carry these files into it by hand.

## Provenance

| File | Surface | Source |
|---|---|---|
| `skills/deploy-check/SKILL.md` | a committed skill with one inline `` !`…` `` command and one ```` ```! ```` fenced block | **hand-written** for the test, in the documented syntax (code.claude.com/docs/en/skills) |
| `stream-json/skill-shell-disabled.jsonl` | a `claude -p --output-format stream-json --verbose --settings '{"permissions":{"blockWritesOutsideWorkingDirectories":true},"disableSkillShellExecution":true}'` run that loads that skill: a `system/init`, a `Skill` `tool_use`, its `tool_result` with `[shell command execution disabled by policy]` where each command would have run, then a `success` `result` (no refused-settings stop) | **synthetic** — the fields follow `tool-use.jsonl` (2.1.314); the placeholder is the one the skills docs give ("Each command is replaced with `[shell command execution disabled by policy]` instead of being run"). Where the rendered skill text appears in the stream (here, the `Skill` tool's result) and whether a fenced block's fences stay are assumptions. Replace with a scrubbed real capture when one is made |
