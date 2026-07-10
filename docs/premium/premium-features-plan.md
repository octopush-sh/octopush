# Octopush — Premium Features Plan (Free vs. Paid)

> **Status:** Proposal · 2026-06-20 · branch `premium-features`
> **Companion doc:** [`accounts-and-subscriptions-implementation-plan.md`](accounts-and-subscriptions-implementation-plan.md) — how we build accounts + billing + entitlement enforcement.
> **Inputs:** the full feature map ([`docs/FEATURES.md`](../FEATURES.md)) and a 2025–2026 survey of how AI‑coding tools price free vs. paid (Cursor, Copilot, Windsurf/Devin, Zed, Replit, JetBrains, Tabnine, Warp, Augment, Cline/Roo/Continue/Aider).

This document decides **which Octopush features are free and which are premium**, and *why*. It deliberately separates the *what* (this doc) from the *how* (the implementation plan). Octopush today has **no accounts and no billing** — everything is free and local. This is the plan for introducing a paid tier without betraying what makes Octopush trustworthy.

---

## 1. Principles (the rules we're optimizing against)

1. **Never paywall the user's own keys or compute.** Octopush is BYOK‑first. Your Anthropic/OpenAI/DeepSeek keys and your **local Ollama models** must stay free, forever. Charging for access to inference *you* pay for is the fastest way to lose a developer's trust.
2. **Free has to be genuinely useful** — a real daily driver, not a crippled demo. The whole industry gives away the editor/core UX; we should too.
3. **Charge for the thing that is genuinely ours to run** — the multi‑agent **orchestration harness**, background/parallel execution, hosted history/sync, and team governance. These have real engineering and (optionally) infrastructure cost even when the *tokens* are the user's.
4. **Mirror the industry's gates, not invent new resentment.** Gate what other tools gate (agentic/background features, team/SSO, privacy/self‑host, higher limits); keep free what others keep free (core editing, BYOK, local models, a taste of the agent).
5. **Local‑first stays the default.** No feature should *require* the cloud to function offline that doesn't inherently need it. Premium adds capability; it doesn't hold your existing local data hostage.
6. **Honesty in the meter.** If we ever introduce usage limits, show them plainly (Octopush already shows token spend and savings — extend that, don't hide it).

---

## 2. What the industry does (the pattern we're aligning to)

From the pricing survey (full citations in the implementation plan's research appendix):

**Almost always FREE**
- The editor / core UX (Zed, Cline, Continue, Aider are free/OSS; the terminal in Warp is free).
- Basic completion and a **limited taste of the agent** (Cursor, Copilot, Windsurf, Replit, Warp all give a small free agent quota).
- **BYOK with your own key** — free in the OSS camp (Aider, Cline, Roo, Continue) and, notably, **free on every tier in Zed**.
- **Local models** wherever supported.

**Almost always PAID**
- **Hosted frontier‑model access / inference credits** (the #1 paywall).
- **Higher usage limits** once the free quota runs out.
- **Agentic / background / autonomous features** — Cursor background agents, Windsurf Cascade, JetBrains *Junie* (paid‑only), Replit Agent, Tabnine Agentic. *Agents are the premium tier's reason to exist.*
- **Team & collaboration**, **SSO/SAML/RBAC/audit** (universally Business/Enterprise).
- **Privacy / zero‑retention / self‑hosting** (the enterprise moat, esp. Tabnine, Warp).

**The BYOK fork (the decision that matters most for us).** Two real models exist:
- **BYOK = the free path** (Aider, Cline, Zed): bring your key, pay only the provider.
- **Platform fee + BYOK** (Warp, partial Cursor, Tabnine +5%): you still pay for the *software/harness* even with your own key. Warp's framing is the precedent — *"even with BYOK, it's not free for us to run our agent harness."*

**Price anchors (2025–2026):** individual Pro clusters at **$10–$20/mo** ($20 modal), power tiers **$39–$60**, "whale" **$100–$200**, teams **~$40/seat** (with a rising **flat small‑team** option, e.g. Augment $100, Roo $99).

---

## 3. The strategic decision (brainstorm → choice)

The core question: **for a BYOK tool whose flagship is multi‑agent orchestration, what do we charge for?**

### Options considered

| Option | What it means | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Pure OSS / BYOK‑free** (Aider/Cline model) | Everything free; monetize only enterprise governance later | Maximum goodwill & adoption; no billing to build | No individual revenue; the expensive‑to‑run orchestration is given away; hard to fund development | ❌ Leaves the flagship unmonetized |
| **B. Gate model access / resell inference** (Copilot/Cursor‑credits model) | Charge for hosted model credits | Proven, large revenue | **Directly violates Principle 1** (we'd be reselling tokens over BYOK); kills our differentiator; pits us against the user's own keys | ❌ Off the table |
| **C. Platform fee + BYOK** (Warp model) | Core + BYOK + local free; **charge for the orchestration harness, parallel/background runs, hosted history, and teams** | Aligns revenue with our actual cost & unique value; preserves the BYOK promise; matches where agent‑first tools are converging | Must articulate *why* a BYOK user pays (answer: the harness, not the tokens) | ✅ **Chosen** |
| **D. Optional managed inference add‑on** (Tabnine/Cline‑provider model) | Sell convenience inference at cost+margin to users who don't want BYOK | New revenue line; lowers onboarding friction | Secondary; needs a proxy + margin model; build later | ➕ **Later add‑on, not v1** |

**Decision: Option C, with D as a future add‑on.** Free Octopush is a genuinely complete BYOK agentic IDE (Talk, Review, terminals, worktrees, local models, *and a taste of Direct*). **Pro** unlocks the orchestration harness at scale. **Team** adds collaboration & governance. **Enterprise** adds SSO/self‑host/privacy. A managed‑inference add‑on can come later for the no‑BYOK crowd.

**The one‑sentence pitch we must be able to say with a straight face:** *"Your keys and local models are free forever — you pay for the crew that turns a brief into a reviewed PR, runs many of them at once, and remembers everything."*

---

## 4. The free / premium split (mapped to real Octopush features)

Tiers: **Free** · **Pro** (individual) · **Team** (per‑seat) · **Enterprise** (custom). Everything in a lower tier is included in higher tiers.

### ✅ Free forever (the daily driver)

| Area | What's free |
|---|---|
| **Core app** | The whole Atelier shell, modes, command palette, workspace search, scratchpad, themes, settings, auto‑update. |
| **Projects & Workspaces** | Unlimited projects and **git‑worktree workspaces**, clone/open/create, archive/restore, the rail, customization. |
| **Talk mode** | The conversational agent with full tool use (`read/write/run/list`), `$`‑direct shell, `@`‑mentions, skills, image attachments, threads, the savings ledger — **on your own keys**. |
| **Review mode** | The full diff reader, CodeMirror editor, per‑hunk accept/reject, staging/commit/push, conflict resolution (manual), blame, test runner. |
| **Git & GitHub** | All local git operations, branch/stash/tags, PR detection & "start from a PR". |
| **Providers** | **BYOK** for any provider, unlimited. **Local Ollama models — free and unlimited.** Per‑model pricing, the LiteLLM pricing refresh, the all‑premium savings ledger. |
| **Direct mode (taste)** | Run built‑in & custom pipelines **up to a generous monthly cap of Direct *runs*** (proposed: **25 runs/month**), sequential, with all checkpoints/loops. The visual builder is fully usable. |
| **Terminals** | The PTY daemon, unlimited terminals, restore‑on‑relaunch. |
| **Integrations (personal)** | Jira (personal account), MCP client + the `octopush-mcp` server, "Connect to Claude Code". |
| **Token & cost tooling** | Usage analytics, budgets, CSV export — all local. |

> The Direct **taste** is the single most important free affordance: it lets every user *experience* the flagship before paying, exactly like Cursor/Windsurf/Copilot give a free agent quota.

### 💎 Pro — the orchestration harness, unlocked (individual, ~$20/mo)

| Gate | Free | **Pro** | Why it's premium |
|---|---|---|---|
| **Direct runs** | 25 runs/mo | **Unlimited** | The harness (driving stages, retries, loop‑backs, journaling, cost accounting) is the expensive‑to‑build core value — the industry's universal "agents are paid" gate, BYOK or not. |
| **Parallel / background runs** | One run at a time per workspace | **Multiple workspaces running concurrently**; runs continue in the background | Concurrency and background execution are explicit premium features everywhere (Cursor background agents, etc.). Also the natural place real infra cost would appear. |
| **Run history & artifacts** | Last N runs retained locally | **Unlimited history, iteration archive, stage diff snapshots** retained & (optionally) **synced across machines** | History/sync is a clean "ours to run" value that doesn't touch the user's keys. |
| **Advanced pipelines** | Built‑ins + simple custom | **Unlimited custom pipelines, custom roles library, auto‑mode review loops** | Power‑user surface; mirrors the "advanced agent" gates. |
| **Priority model routing / larger dossiers** | Standard | **Higher per‑stage context caps, premium reference‑model baseline tuning** | Soft, value‑add limits — never a *quality* nerf to free. |

**Pro is BYOK‑honest:** a Pro user still brings their own keys; they pay for *unlimited orchestration, concurrency, and memory*, not for tokens.

### 👥 Team — collaboration & shared craft (per‑seat, ~$40/seat/mo, or a flat small‑team price)

- **Shared pipeline & role libraries** across the team (publish/subscribe to pipelines).
- **Shared Jira/issue configuration** at org scope; team workspace conventions.
- **Central billing & seat management.**
- **Team usage & savings analytics** (aggregate cost saved across the team — a compelling ROI story).
- **Basic roles/permissions** (who can edit shared pipelines).

### 🏢 Enterprise — governance, privacy, scale (custom)

- **SSO / SAML / SCIM**, RBAC, audit logs.
- **Zero‑retention / privacy mode**, on‑prem or VPC deployment of any optional cloud component (history sync, managed inference proxy).
- **Self‑hosted** model gateway, IP indemnification, procurement & support SLAs.
- **Admin policy** (enforce providers, budgets, allowed models org‑wide).

### 🔮 Future add‑on (not v1) — Managed inference

For users who don't want BYOK: an **Octopush‑hosted model gateway** billed at **provider cost + a small margin** (the Tabnine/Cline‑provider model). Lowers onboarding friction; keeps BYOK as the free path. Requires a metering/proxy build — deferred until after the core tiers ship.

---

## 5. The gate table at a glance

| Feature | Free | Pro | Team | Ent |
|---|:--:|:--:|:--:|:--:|
| App, modes, palette, scratchpad, themes | ✅ | ✅ | ✅ | ✅ |
| Unlimited projects & worktree workspaces | ✅ | ✅ | ✅ | ✅ |
| Talk mode (full tools, BYOK) | ✅ | ✅ | ✅ | ✅ |
| Review mode (diff, editor, staging, AI review on your keys) | ✅ | ✅ | ✅ | ✅ |
| Terminals + PTY daemon | ✅ | ✅ | ✅ | ✅ |
| **BYOK (any provider) + local Ollama** | ✅ | ✅ | ✅ | ✅ |
| Visual pipeline builder | ✅ | ✅ | ✅ | ✅ |
| Direct runs | 25/mo | ∞ | ∞ | ∞ |
| Parallel / background runs | — | ✅ | ✅ | ✅ |
| Unlimited run history + cross‑machine sync | — | ✅ | ✅ | ✅ |
| Unlimited custom pipelines/roles + auto‑loops | — | ✅ | ✅ | ✅ |
| Shared pipeline/role libraries | — | — | ✅ | ✅ |
| Shared Jira/org config + central billing | — | — | ✅ | ✅ |
| Team savings/usage analytics | — | — | ✅ | ✅ |
| SSO/SAML/SCIM · RBAC · audit | — | — | — | ✅ |
| Zero‑retention / self‑host / VPC | — | — | — | ✅ |
| Managed inference (cost+margin) | *future add‑on, any tier* | | | |

---

## 6. Pricing recommendation (anchors, to validate)

- **Free** — $0. The complete BYOK agentic IDE + 25 Direct runs/mo.
- **Pro** — **$20/mo** ($16/mo annual). The modal individual price; matches Cursor/Windsurf/Replit/Warp. Unlimited orchestration, concurrency, history/sync.
- **Team** — **$40/seat/mo** (or a **flat ~$120/mo for up to 5 seats** to court small teams, à la Augment/Roo). Shared craft + governance‑lite + central billing.
- **Enterprise** — custom; governance, privacy, self‑host.

> Numbers are anchors for validation, not commitments. The **25 free runs/mo** figure in particular should be tuned from real usage once metering exists (high enough to feel generous, low enough that a daily orchestrator converts).

---

## 7. What we explicitly will **not** do

- ❌ Charge for the user's own API keys or local models.
- ❌ Degrade the **quality** of free model responses (free is "less quantity/concurrency/memory", never "worse answers").
- ❌ Hold existing **local** data (projects, chats, runs) hostage behind a paywall, online or off.
- ❌ Require a network connection for features that work offline today.
- ❌ Resell frontier‑model inference as our primary business (Principle 1).

---

## 8. Migration & rollout posture

- **Grandfather** the current local‑first experience: everything that is free today **stays free**; we are *adding* paid capability, not clawing anything back. The only new limit on existing behavior is the Direct‑runs cap, which should launch high and be communicated clearly (with an in‑app meter, consistent with Octopush's existing honesty about spend).
- **Account is optional for Free.** A user can keep using Free Octopush **without signing in**; sign‑in is required only to purchase/activate Pro+ (see the implementation plan — we still want a lightweight free account for sync later, but it must not gate offline local use).
- Ship the **paywall surfaces** (an upgrade nudge when hitting the Direct cap or attempting a parallel run) tastefully, in the Atelier voice, never nagging.

---

## 9. Open questions (to resolve before GA)

1. **Free Direct cap unit & number** — runs vs. stages vs. agent‑minutes? Proposed: **runs/month** (simplest to explain). Validate the 25 figure.
2. **Does history sync require our cloud, or is it opt‑in?** Recommend opt‑in, encrypted, and Enterprise‑self‑hostable.
3. **Where exactly does "parallel" start?** Concurrent runs across workspaces (recommended) vs. concurrent stages within a run.
4. **Student/OSS free Pro?** Cheap goodwill; decide post‑launch.
5. **Managed‑inference timing** — after Pro/Team are stable.

---

## 10. Summary

Octopush stays a **complete, free, local‑first, BYOK agentic IDE** — Talk, Review, terminals, worktrees, local models, and a real taste of Direct. **Pro** sells the thing that's genuinely ours and genuinely valuable: **unlimited multi‑agent orchestration, run it many‑at‑once, and remember it all.** **Team** sells shared craft and governance‑lite; **Enterprise** sells trust and control. This is exactly where the industry has converged for agent‑first tools — and it lets us charge without ever competing with our users' own keys.
