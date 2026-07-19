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
| `list_roles` | read | Every role (built-in + custom) with its full config — the vocabulary a stage's `role` draws from. |
| `save_role` | author | Create/update a **custom** role (the agent persona a stage runs as). Only `label` + `promptBody` required; `key` derived from the label if omitted. Built-in keys protected. |
| `delete_role` | author | Delete a custom role by key (built-ins protected; a role used by any pipeline/run stage is protected). |
| `list_projects` | read | Open projects (git repos). |
| `list_workspaces` | read | Workspaces (worktrees) of a project. |
| `get_workspace` | read | One workspace: branch, path, status, linked issue. |
| `list_missions` | read | A project's missions (threads of intent): intent, title, status, the two isolation axes, linked workspace/issue. |
| `get_mission` | read | One mission by id. |
| `create_workspace` | author | Ensure a workspace for a branch (explicit branch used **verbatim**; task-derived ones slugified). Returns `status`: created \| adopted \| existed \| restored. Reuses a tracked workspace, **adopts** an already-checked-out branch rather than failing, else creates a worktree. **Pairs the workspace with a mission** — pass `intent` (`build` default / `fix`) — so MCP-created workspaces match the app's "no workspace without a mission" guarantee. Never duplicates. The one tool that touches git. Shows in the rail on next focus/refresh. |
| `create_mission` | author | Author a mission (a thread of intent). For code work prefer `create_workspace` (it pairs a `build` mission); use this for missions with no worktree (design/probe) or to attach a specific intent/isolation. Authoring only — never executes. |
| `link_workspace_issue` | author | Link/unlink a workspace to an issue key (metadata only). |
| `create_run` | author | Stage a run in `draft` from a pipeline + task (does **not** start it). |
| `list_runs` | read | Runs of a workspace, newest first. |
| `get_run` | read | One run + per-stage detail (status, tokens, cost, artifacts). |
| `list_routines` | read | Every routine (scheduled crew): schedule, workspace mode, enabled, next due, last outcome. |
| `create_routine` | author | Create a routine (a pipeline that fires on a schedule). Created **disabled** unless `enabled:true`. Validates project/pipeline/workspace exist. |
| `update_routine` | author | Update a routine's fields by id + recompute next due (leaves `enabled` untouched). |
| `delete_routine` | author | Delete a routine by id (ungated). |
| `set_routine_enabled` | author | Enable (starts firing on schedule) or disable a routine. |

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

### Role authoring contract

A stage's `role` is a role's `key`. Beyond the built-ins you can author your own
with `save_role`, then reference them from a stage. Only `label` + `promptBody`
are required; every other field defaults (see `describe_pipeline_schema` →
`customRoles` for the exhaustive field list). Key rules:

- `key` is the stable id a stage references. Omit it to derive one from the label
  (lowercase, each run of non-alphanumerics → `_`, trimmed) — it's always
  returned by `save_role`. An existing **custom** key updates in place; a
  **built-in** key is rejected (never overwritten).
- `artifactKind` ∈ `plan|review|tests|diff|note` (default `note`);
  `environment` is `worktree` (default — never touches git, leaves changes for the
  next stage) or `action` (may commit/push/PR/merge/release);
  `defaultTools` ⊆ `read_file, list_files, write_file, run_command`
  (default `[read_file, list_files]`); `defaultSubstrate` `api`|`cli`;
  `canLoop`/`defaultCheckpoint` default false; `tokenEstIn`/`tokenEstOut` feed the
  cost preview (defaults 4000/1000).
- `delete_role` refuses a built-in and refuses a role still used by any
  pipeline/run stage (re-point or remove those stages first).
- **Library sync caveat:** like `delete_pipeline`, a role authored/deleted over
  MCP is **not** pushed to the Pro cloud library from the MCP process — edit it
  once in-app to sync it across machines.

### Routine authoring contract

A **routine** is a pipeline that fires on a schedule in a workspace (a Pro
feature; `create_routine`/`update_routine` share one validated payload). It stays
**author-only** and **safe by default**:

- **Created DISABLED unless `enabled:true`.** Authoring never silently schedules
  token spend — the agent stages the routine; you enable it in Settings →
  Routines or via `set_routine_enabled`. An enabled routine fires **only while the
  Octopush app runs** and **your plan includes routines** (re-checked at fire
  time). There is deliberately **no `run_routine_now`** over MCP — firing a crew
  *now* is execution, which stays in the app.
- **Required:** `name`, `projectId`, `pipelineId`, `scheduleKind`,
  `scheduleSpec`. All ids are **validated to exist** (a dangling routine would
  fail silently at fire time).
- **Schedule:** `scheduleKind` `interval` (`scheduleSpec` = whole **seconds** as a
  string, ≥ 60 — `"3600"` = hourly) or `daily` (`scheduleSpec` = `"HH:MM"` 24h).
- **Workspace mode:** `fixed` (default — needs `fixedWorkspaceId`, which must
  exist and belong to `projectId`; a fire is skipped while that workspace has a
  live run) or `fresh` (a new worktree per fire — **requires `daily`**; takes
  `baseBranch`/`branchPrefix`).
- **Optional:** `task`, `referenceModel`, `budgetUsd`, `stageModelOverrides`
  (`[position, model]` pairs, like `create_run`), and `fireCondition` — a pre-fire
  shell command run in the workspace; the routine fires only if it **exits 0**
  (non-zero ⇒ skip with zero tokens, no run). `update_routine` leaves `enabled`
  unchanged.

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
