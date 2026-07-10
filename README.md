<div align="center">

# Octopush

### The IDE for Agentic Developers — eight arms, zero wasted tokens.

Octopush turns a single brief into a reviewed pull request by orchestrating a **crew of AI agents** across git‑worktree workspaces — and shows you the cost saved against the all‑premium baseline on every run.

<br/>

![Octopush — welcome](docs/screenshots/01-welcome.png)

<br/>

![version](https://img.shields.io/badge/version-0.1.93-d4a574?style=flat-square&labelColor=14110d)
![platform](https://img.shields.io/badge/platform-macOS-95897a?style=flat-square&labelColor=14110d)
![stack](https://img.shields.io/badge/Tauri%202%20·%20React%2019%20·%20Rust-95897a?style=flat-square&labelColor=14110d)
![byok](https://img.shields.io/badge/BYOK%20·%20local%20models-8fc9a8?style=flat-square&labelColor=14110d)

</div>

---

## Why Octopush

Most AI coding tools bolt a chat box onto an editor. Octopush is built the other way around — the **agent workflow is the product**, and the editor, terminal, and git tooling are first‑class citizens that serve it.

- **🐙 Direct mode — multi‑agent orchestration.** Compose a pipeline of stages (plan → implement → review → test), each an AI agent with its own role, model, and tools. Gate stages with human checkpoints, let reviewers **loop work back** until it passes, and recover gracefully from halts. Run it through the in‑app API or a headless **Claude Code** CLI.
- **💬 Talk mode — an agent that can actually do things.** A conversational agent that reads files, runs commands, and writes changes inside the workspace's worktree. Type `$ npm test` to run it with **zero tokens**; `@file` to attach context; `/skill` to load a `SKILL.md`.
- **🔍 Review mode — read every change like a senior engineer.** A continuous, word‑diffed, syntax‑highlighted diff with per‑hunk accept/reject, a real CodeMirror editor, an **AI review pass**, AI‑assisted conflict resolution, and a one‑click test runner.
- **🌿 Workspaces are git worktrees.** Every task gets an isolated branch + working tree as a sibling folder — switch between five in‑flight features without stashing, and run an agent in each.
- **💸 Zero wasted tokens.** Bring your own keys, mix cheap and premium models per stage, run **local models for free**, and watch the savings against an "all‑premium" baseline accumulate on every conversation and run.
- **🔒 Local‑first.** Your code, keys, and history stay on your machine (`~/.octopush` + a local SQLite database). No analytics, no telemetry. Traffic only goes to the providers and integrations you configure.

> 📖 For the **exhaustive** catalogue of every feature and how it's implemented, see **[`docs/FEATURES.md`](docs/FEATURES.md)** — the source of truth for what Octopush can do.

---

## A tour

### Direct — orchestrate a crew of agents

Describe the work, pick (or compose) a pipeline, tune the model on any stage, and launch. Octopush drives the run one stage at a time, pausing at the checkpoints you choose. The ledger shows what you spent versus what an all‑premium run would have cost.

![Direct mode — the launcher](docs/screenshots/04-direct.png)

Pipelines are authored on a **visual node graph**: drag roles from the palette, wire the flow, add a review **loop** that sends work back until it passes. Built‑in pipelines (Feature Factory, Bugfix relay, Plan & review, Claude Code build) are one click away, or fork them into your own.

![Direct mode — the pipeline builder](docs/screenshots/05-builder.png)

### Talk — a conversation that ships code

The agent works inside the workspace worktree with `read_file` / `write_file` / `run_command` / `list_files` tools, MCP tools from your configured servers, and any project skills. Every tool call is a `§` card you can expand; every change is attributed back to the turn that made it. The Companion keeps a running tally of context, spend, and **savings versus the priciest model**.

![Talk mode — chat with the savings ledger](docs/screenshots/02-talk.png)

### Review — accept the change, hunk by hunk

A continuous diff with sticky hunk rails, inline or side‑by‑side reading, word‑level highlighting, and keyboard‑driven triage (`a` accept, `x` reject, `]` next file). The Companion verdict tells you what's ready to commit and **how the change was built** — which agent turns shaped which files. Run an AI review pass or the test suite without leaving the screen.

![Review mode — diff and the review cockpit](docs/screenshots/03-review.png)

---

## Bring your own keys

Octopush is **BYOK‑first**. Configure providers in Settings → Models; keys live only in `~/.octopush/settings.json` and never leave your machine except in requests to the provider you chose.

| Provider | Models (built‑in defaults) | Notes |
|---|---|---|
| **Anthropic** | Claude Opus 4.6 · Sonnet 4.6 · Haiku 4.5 | First‑class; powers the API substrate and Claude Code CLI stages |
| **OpenAI** | GPT‑4o · GPT‑4o‑mini | OpenAI‑compatible protocol |
| **DeepSeek** | deepseek‑chat · deepseek‑reasoner | Cheapest cloud option |
| **Ollama (local)** | llama3.3 · qwen2.5‑coder · deepseek‑r1 | **Free** — runs on your machine, no API key |

Add any other vendor or gateway by choosing one of two protocols (`anthropic` or `openai‑compatible`) and a base URL — there's no per‑vendor code. Pricing is editable per model and can be refreshed from the public LiteLLM catalogue, so the savings math stays honest.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Octopush.app  (Tauri 2)                                       │
│                                                                │
│  Frontend  (src/)            Backend  (src-tauri/src/)         │
│  React 19 + TypeScript       Rust                              │
│  Tailwind v4 · Zustand       ~190 Tauri commands              │
│  CodeMirror · xterm.js       SQLite (db.rs) · providers/*      │
│  React Flow (builder)        orchestrator/*  · git_ops/*       │
│        │  invoke (ipc.ts)    chat_engine · issue_tracker/*     │
│        └───────────────►     token_engine · mcp/*             │
└───────────────┬──────────────────────────┬───────────────────┘
                │                           │
   ┌────────────▼───────────┐   ┌───────────▼──────────────┐
   │  octopush-pty-server    │   │  octopush-mcp            │
   │  out-of-process PTY      │   │  read+author MCP server  │
   │  daemon — terminals      │   │  exposes pipelines/runs  │
   │  survive app restarts    │   │  to Claude Code & CLIs   │
   └─────────────────────────┘   └──────────────────────────┘
```

- **Frontend** — React 19 + TypeScript, Tailwind v4 design tokens, Zustand stores, all IPC funnelled through `src/lib/ipc.ts`. CodeMirror 6 editor, xterm.js terminals, React Flow pipeline builder, Recharts usage analytics.
- **Backend** — Rust. Tauri commands in `commands.rs`, SQLite via `db.rs`, the Direct‑mode orchestrator in `orchestrator/*`, a unified provider layer (`providers/*`), git via libgit2 + login‑shell shell‑outs, and Jira/GitHub/MCP integrations.
- **Two sidecar binaries** — `octopush-pty-server` owns all pseudo‑terminals so your shells (and live dev servers) survive app restarts and auto‑updates; `octopush-mcp` exposes Octopush's pipelines, projects, workspaces, and runs to external CLIs over MCP (read‑and‑author only — it never executes runs or spends tokens).

---

## Getting started

**Prerequisites:** [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) (stable), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (on macOS: Xcode Command Line Tools).

```bash
# Install JS dependencies
npm install

# Run the full desktop app in dev mode (frontend + Rust backend)
npm run tauri:dev

# Frontend only (Vite dev server — no Rust backend)
npm run dev
```

| Command | What it does |
|---|---|
| `npm run tauri:dev` | Full Tauri app in dev mode |
| `npm run dev` | Vite dev server (frontend only) |
| `npm run build` | Typecheck + Vite production build |
| `npm run typecheck` | TypeScript check only |
| `npm test` | Vitest (frontend unit tests) |
| `cd src-tauri && cargo test` | Rust tests |
| `npm run tauri:build` | Build a distributable `.app` (bundles both sidecars) |

On first launch Octopush creates `~/.octopush/` (settings, provider catalogue, theme) and a SQLite database under `~/Library/Application Support/octopush/`.

---

## Project layout

```
src/                      React frontend
  components/             UI — modes, rail, companion, builder, review, settings…
  stores/                 Zustand state (chat, workspaces, runs, tokens, …)
  lib/ipc.ts              the single typed bridge to Rust
src-tauri/src/            Rust backend
  commands.rs             every Tauri command (registered in lib.rs)
  orchestrator/           Direct-mode multi-agent engine
  providers/              Anthropic + OpenAI-compatible adapters
  git_ops.rs · github.rs  git (libgit2 + shell-outs) and PR integration
  issue_tracker/          Jira
  bin/octopush-pty-server PTY daemon (terminals survive restarts)
  bin/octopush-mcp        MCP server exposing Octopush to other CLIs
docs/
  FEATURES.md             ← exhaustive feature map (source of truth)
  design-system.md        Atelier in Onyx & Brass — tokens & patterns
  premium/                accounts & subscriptions plan (in progress)
```

---

## Design

Octopush has a deliberate visual identity — **Atelier in Onyx & Brass**. Onyx surfaces, a single surgical brass accent, three type voices (an upright serif for moments, a system sans for body, JetBrains Mono for meta), and calm, token‑driven motion. It's meant to feel like *itself*, not like a generic AI tool. See **[`docs/design-system.md`](docs/design-system.md)**.

---

## Roadmap — accounts & premium

Octopush is currently fully local and free. Accounts and an optional paid subscription are being designed so that the **BYOK promise stays intact** — your keys and local models remain free, while the multi‑agent orchestration harness, parallel/background runs, and team features become the premium tier (aligned with how the rest of the industry prices agentic tooling). The full proposal lives in:

- **[`docs/premium/premium-features-plan.md`](docs/premium/premium-features-plan.md)** — what's free vs. premium, and why.
- **[`docs/premium/accounts-and-subscriptions-implementation-plan.md`](docs/premium/accounts-and-subscriptions-implementation-plan.md)** — auth (Clerk) + billing + entitlement enforcement for the desktop app.

---

## Documentation

- **[`docs/FEATURES.md`](docs/FEATURES.md)** — every feature, and how it works.
- **[`docs/design-system.md`](docs/design-system.md)** — the design system cheatsheet.
- **[`docs/octopush-mcp.md`](docs/octopush-mcp.md)** — the bundled MCP server.
- **[`CLAUDE.md`](CLAUDE.md)** — guidelines for AI assistants working in this repo.
- **[`docs/superpowers/`](docs/superpowers/)** — design specs and implementation plans.

---

<div align="center">

**Octopush** · an atelier for agentic developers

</div>
