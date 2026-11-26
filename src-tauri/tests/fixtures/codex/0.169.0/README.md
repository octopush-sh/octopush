# Codex CLI contract fixtures — v0.169.0

Recorded output of the `codex` CLI (`@openai/codex` 0.169.0 from npm) that
Octopush builds argv from and parses. The tests in
`src-tauri/src/codex_contract.rs` feed these files to the production code
(`orchestrator::cli_runner`, `agent_adapter::codex_help_lists_exec_resume`).

Every directory under `tests/fixtures/codex/` that has a `VERSION` file is
tested, so a new recording is covered as soon as it is committed.

## Provenance

| File | Surface | Source |
|---|---|---|
| `version.txt` | `codex --version` | **real** |
| `cli-help.txt` | `codex --help` | **real** |
| `exec-help.txt` | `codex exec --help` (the fresh-run flags: `--json`, `--skip-git-repo-check`, `-m`, `-s/--sandbox`, `-c`, `--dangerously-bypass-approvals-and-sandbox`, `[PROMPT]` / `-` from stdin, the `resume` subcommand) | **real** |
| `exec-resume-help.txt` | `codex exec resume --help`: `[SESSION_ID] [PROMPT]` (`-` reads stdin), `-c`, `-m`, `--json`, `--skip-git-repo-check`, `--dangerously-bypass-approvals-and-sandbox`; **no** `-s/--sandbox`, `-C/--cd` or `--add-dir` | **real** |
| `resume/sandbox-after-subcommand.stderr` | `codex exec --json --skip-git-repo-check resume -s read-only <id> -`: `error: unexpected argument '-s' found`, exit 2. `--sandbox` must come before `resume` | **real** |
| `resume/unknown-session.stdout`, `resume/unknown-session.stderr` | `codex exec --json --skip-git-repo-check -m gpt-5.5 --sandbox read-only resume <unknown uuid> -`: empty stdout (no JSONL at all), `Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)` on stderr, exit 1 | **real** (stderr reduced to the `Error:` line; the backtrace and a PATH-alias warning dropped) |
| `stream-json/fresh-offline.jsonl` | the first events of a fresh `codex exec --json` run | **real**, but offline: no credentials and no route to the API, so the run never got past `turn.started` (the reconnect `error` events after it are dropped) |
| `stream-json/resume-offline.jsonl` | the first events of `codex exec --sandbox read-only resume --json <that thread id> -`: a `thread.started` with the **same** `thread_id` as the fresh run, then `turn.started` | **real**, offline as above |
| `stream-json/resume.jsonl` | a resumed turn that finished: same `thread_id`, items, last `agent_message`, `turn.completed` whose `usage` is the **thread's running total** (the earlier run's tokens included) | **synthetic** — event shapes from `codex-rs/exec/src/exec_events.rs`; the cumulative usage from `event_processor_with_jsonl_output.rs` (`usage_from_last_total` reads `ThreadTokenUsage.total`) and `core/src/session/mod.rs` ("Seed usage info from the recorded rollout" on resume). A real successful resume needs a signed-in CLI, which the recorder must not use |
| `stream-json/resume-turn-failed.jsonl` | a resumed turn that failed before any assistant message: `error`, then `turn.failed` | **synthetic** — the message is `CodexErr::ContextWindowExceeded`'s text (`codex-rs/protocol/src/error.rs`) |

## What the source says (openai/codex at tag `rust-v0.169.0`, a41fe5b443)

- `codex-rs/exec/src/cli.rs`: `ResumeArgsRaw` takes only `SESSION_ID`, `--last`,
  `--all`, `-i/--image` and `PROMPT`. `--json`, `--skip-git-repo-check`,
  `-m/--model`, `--dangerously-bypass-approvals-and-sandbox` and
  `--output-last-message` are `global = true`, so they work on either side of
  `resume`. `-s/--sandbox`, `-C/--cd` and `--add-dir` are not global: they go
  before `resume`. `-c` is the root CLI's global override.
- `codex-rs/exec/src/lib.rs` `thread_resume_params_from_config`: the resumed
  thread gets this invocation's sandbox, approval policy, model and cwd, not
  the ones it was started with. `resolve_resume_thread_id`: a UUID is resumed
  as is; when no rollout has it, `thread/resume` fails (the error above). A
  name that matches nothing would start a **new** thread, so Octopush only ever
  passes the UUID from `thread.started`.
- `codex-rs/exec/tests/suite/resume.rs`
  (`exec_resume_preserves_cli_configuration_overrides`) runs
  `codex exec --sandbox workspace-write --model … <prompt> resume --last` and
  checks the resumed run reports the new sandbox and model.

Recorded in a Linux container on 2026-11-16, with `HOME` and `CODEX_HOME` in a
throwaway directory, no credentials and no login.
