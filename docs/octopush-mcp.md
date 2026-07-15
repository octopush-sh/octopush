# Octopush MCP server

`octopush-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes a slice of Octopush to any MCP client — Claude Code first.
It lets a model in your terminal **author DIRECT-mode pipelines** and **inspect
your Octopush projects, workspaces, pipelines and runs**, driving the same local
SQLite store the desktop app uses.

> Example: from Claude Code, *"create a DIRECT pipeline that plans, implements,
> reviews (looping back to implement), then tests — and stage a run of it on the
> `feature/login` workspace."* The model calls `describe_pipeline_schema`, then
> `create_pipeline`, then `create_run`. You open Octopush and press play.

## Design at a glance

- **Same binary family as the app.** It's a sibling `[[bin]]` in the `src-tauri`
  crate (alongside `octopush-pty-server`), so it reuses `octopush_lib::db`
  directly — zero re-implementation of the data layer, no drift.
- **Standalone, no app required.** It opens `~/Library/Application
  Support/octopush/octopush.db` (the same path the app uses, via
  `Db::default_path()`). SQLite WAL means it's safe to run while the app is open.
- **Hand-rolled protocol.** JSON-RPC 2.0 over stdio, newline-delimited, written
  against `serde_json` only (no SDK dependency). Synchronous loop — one rusqlite
  connection, one thread.
- **Read-and-author, never execute.** The server never runs a pipeline or spends
  tokens. Pipelines are saved as reusable templates; runs are staged in `draft`
  for you to launch from the app. The single git mutation it performs is
  `create_workspace`, which materialises a worktree (the same thing the app's
  workspace creator does).

### Files

| File | Role |
|------|------|
| `src-tauri/src/bin/octopush-mcp/main.rs` | stdio loop + JSON-RPC routing |
| `src-tauri/src/bin/octopush-mcp/protocol.rs` | JSON-RPC / MCP envelope helpers |
| `src-tauri/src/bin/octopush-mcp/tools.rs` | tool catalogue + dispatch into `db` |

## Tools (v1)

| Tool | Kind | What it does |
|------|------|--------------|
| `describe_pipeline_schema` | reference | Roles, tools, substrates, loop/checkpoint rules, per-stage reasoning **effort** + model-**escalation** policy, runtime behaviors (escape valve + auto-escalation), recommended models, annotated example. **Call first when authoring.** |
| `list_pipelines` | read | Every pipeline (built-in + custom) with stages. |
| `get_pipeline` | read | One pipeline + stages by id. |
| `create_pipeline` | author | Create a new custom pipeline (validated before save). |
| `update_pipeline` | author | Update a custom pipeline; **forks** a built-in into a new copy. |
| `delete_pipeline` | author | Delete a custom pipeline (built-ins protected). |
| `list_projects` | read | Open projects (git repos). |
| `list_workspaces` | read | Workspaces (worktrees) of a project. |
| `get_workspace` | read | One workspace: branch, path, status, linked issue. |
| `create_workspace` | author | Ensure a workspace for a branch (explicit branch used **verbatim**; task-derived ones slugified). Returns `status`: created \| adopted \| existed \| restored. Reuses a tracked workspace, **adopts** an already-checked-out branch rather than failing, else creates a worktree. Never duplicates. The one tool that touches git. Shows in the rail on next focus/refresh. |
| `link_workspace_issue` | author | Link/unlink a workspace to an issue key (metadata only). |
| `create_run` | author | Stage a run in `draft` from a pipeline + task (does **not** start it). |
| `list_runs` | read | Runs of a workspace, newest first. |
| `get_run` | read | One run + per-stage detail (status, tokens, cost, artifacts). |

### Pipeline authoring contract

A pipeline is a DAG of role-specialized agent stages. Only `role` and
`agentModel` are required per stage; everything else defaults. The full contract
(enforced by the same validator the app uses) is returned by
`describe_pipeline_schema`. Key rules:

- Roles: `plan, plan_review, implement, code_review, test, repro, fix, verify,
  critique, refine`.
- Only **review roles** (`plan_review, code_review, critique, verify`) may carry
  a loop (`loopTargetPosition` → an earlier stage, `loopMode` `gated`/`auto`).
- `parents` are upstream stage positions (earlier, distinct, acyclic). Empty =
  linear chain.
- `substrate` is `api` (in-process LLM) or `cli` (external agent CLI).
- `tools`, when set, is a non-empty subset of `read_file, list_files,
  write_file, run_command`.
- `effort` (`low|medium|high|xhigh|max`; null/omit = off) is optional per-stage
  reasoning effort — **API substrate only**. It takes effect only on
  reasoning-capable models: the current Claude families (Opus 4.5–4.8, Sonnet
  4.6/5, Fable/Mythos 5) and the budget-path models (Haiku 4.5, Sonnet 4.5),
  where higher levels auto-clamp to the model's max (e.g. Sonnet 4.6 caps
  xhigh→high). On any **other** id (legacy `claude-3-5-*`, unknown/non-Claude)
  effort is **silently ignored — no thinking at all, not clamped**. Use a
  current Claude model to get effect.
- `escalateModel` (and optional `escalateEffort`, api-only) sets an escalation
  policy: if the stage **fails** (its tool-turn budget is exhausted unfinished,
  or it errors) it retries **once** at the stronger tier before halting — but
  **only if that raises the tier**. Set `escalateModel` to a genuinely
  different/stronger model than `agentModel` (and/or `escalateEffort` higher than
  the base effort); if the escalated tier would equal the base, no retry happens
  and the stage halts on failure. `escalateModel` applies to `api` and `cli`.

Two **runtime** behaviors need no authoring. **Escape valve (API stages only):**
an API-substrate stage may pause to **ask the director** (`ask_director`) when
genuinely blocked (the run parks like a checkpoint until answered). A `cli` stage
keeps a strict never-ask contract and has **no** ask-director tool, so it never
self-blocks — for a cli stage that might need a human, use a `checkpoint` or an
`escalateModel` instead. **Auto-escalation:** a stage with an escalation policy
that raises the tier auto-retries once at the stronger tier on failure (see
above).

## Build

```bash
cd src-tauri
cargo build --release --bin octopush-mcp
# binary at: src-tauri/target/release/octopush-mcp
```

## Register with Claude Code

```bash
# user scope (available in every project)
claude mcp add octopush -- /ABSOLUTE/PATH/to/src-tauri/target/release/octopush-mcp

# verify
claude mcp list
```

The server needs no arguments and no environment — it finds the Octopush store
on its own. Tools then appear to the model as `mcp__octopush__<tool>` (e.g.
`mcp__octopush__describe_pipeline_schema`).

To use it from other MCP clients, point them at the binary with the stdio
transport; the handshake is the standard `initialize` → `notifications/initialized`
→ `tools/*` lifecycle (protocol version `2025-06-18`).

## Roadmap (not in v1)

- **Execution control-plane** (hybrid): start a staged run — delegated to the
  running app when open, or headless when not. Gated behind explicit opt-in
  because it spends tokens and mutates the worktree.
- **TALK / REVIEW** surfaces: one-shot chat turn, AI review of a diff.
- Issue-tracker reads (Jira), git status/diff context tools.
