/* eslint-disable */
// Screenshot harness for the Octopush README.
//
// Octopush is a Tauri app: every IPC call goes through `invoke` from
// `@tauri-apps/api/core`, which calls `window.__TAURI_INTERNALS__.invoke(...)`.
// We run the normal Vite dev server (frontend only) and inject a mock
// `__TAURI_INTERNALS__` via Playwright's addInitScript so the real React UI
// renders against seeded data — no source changes, no backend.
//
// Run:  NODE_PATH=<playwright>/node_modules node scripts/screenshots/capture.cjs
// Requires the Vite dev server on http://localhost:1420.

const path = require("path");
const { chromium } = require("playwright");

const OUT_DIR = path.resolve(__dirname, "../../docs/screenshots");
const URL = "http://localhost:1420";

// ─── Seed data ────────────────────────────────────────────────────────────
const now = "2026-06-20T12:00:00Z";

const ATELIER = {
  name: "atelier", bg: "#0c0a08", panel: "#14110d", panel2: "#1a160f",
  border: "#2a2419", accent: "#d4a574", accentDim: "#e8c39a", success: "#8fc9a8",
  warning: "#dfae4a", danger: "#d18b8b", text: "#f4ecdb", textDim: "#95897a",
  textMuted: "#6d6354", terminalBg: "#0c0a08",
};

const PROJECT = {
  id: "proj-octo", name: "octopush", path: "/Users/dev/code/octopush",
  jiraProjectKey: null, pinned: true, tint: "brass",
};

const ws = (id, name, branch, task, tint, linked, fromBranch) => ({
  id, projectId: PROJECT.id, name, task, branch, worktreePath: "/Users/dev/code/octopush/.octopus-worktrees/" + branch,
  setupScript: "", status: "active", createdAt: now, lastActive: now, glyph: null,
  tint, testCommand: null, linkedIssueKey: linked, fromBranch: fromBranch || "main",
});
const WORKSPACES = [
  ws("ws-main", "main", "main", "", "brass", null, null),
  ws("ws-prem", "premium-features", "premium-features", "Accounts & subscriptions", "verdigris", null, "main"),
  ws("ws-talk", "talk-terminal-parity", "talk-t2-live", "Unify the terminal in TALK", "indigo", null, "main"),
  ws("ws-review", "direct-review-loop", "direct-review-loop", "Review loop L2–L4", "lavender", null, "main"),
];

const GIT_SUMMARIES = [
  { workspaceId: "ws-main", dirty: false, ahead: 0, behind: 0 },
  { workspaceId: "ws-prem", dirty: true, ahead: 3, behind: 0 },
  { workspaceId: "ws-talk", dirty: false, ahead: 0, behind: 1 },
  { workspaceId: "ws-review", dirty: true, ahead: 1, behind: 0 },
];

const OPEN_PRS = [
  { branch: "talk-t2-live", pr: { number: 78, title: "feat(talk): live process cards", url: "https://github.com/octopush/octopush/pull/78", isDraft: false, state: "merged" } },
  { branch: "premium-features", pr: { number: 80, title: "docs: feature map, README & premium plan", url: "https://github.com/octopush/octopush/pull/80", isDraft: true, state: "draft" } },
];

const GIT_STATUS = {
  branch: "premium-features",
  changedFiles: [
    { path: "docs/FEATURES.md", status: "new", staged: false, unstaged: true, conflicted: false },
    { path: "README.md", status: "new", staged: false, unstaged: true, conflicted: false },
    { path: "CLAUDE.md", status: "modified", staged: false, unstaged: true, conflicted: false },
    { path: "src/lib/entitlement.ts", status: "new", staged: true, unstaged: false, conflicted: false },
  ],
  ahead: 3, behind: 0, hasUpstream: true, conflicted: 0, aheadBehindKnown: true, operation: null,
};

const DIFF = [
  "diff --git a/README.md b/README.md",
  "new file mode 100644",
  "index 0000000..a1b2c3d",
  "--- /dev/null",
  "+++ b/README.md",
  "@@ -0,0 +1,8 @@",
  "+# Octopush",
  "+",
  "+**The IDE for Agentic Developers — eight arms, zero wasted tokens.**",
  "+",
  "+Octopush turns a single brief into a reviewed pull request by orchestrating",
  "+a crew of AI agents across git-worktree workspaces — and shows you the cost",
  "+savings against the all-premium baseline on every run.",
  "+",
  "diff --git a/src/lib/entitlement.ts b/src/lib/entitlement.ts",
  "new file mode 100644",
  "index 0000000..d4e5f6a",
  "--- /dev/null",
  "+++ b/src/lib/entitlement.ts",
  "@@ -0,0 +1,10 @@",
  "+/** Verifies the signed entitlement returned after sign-in. */",
  "+export interface Entitlement {",
  "+  plan: \"free\" | \"pro\" | \"team\";",
  "+  features: string[];",
  "+  exp: number;",
  "+}",
  "+",
  "+export function hasFeature(e: Entitlement, key: string): boolean {",
  "+  return e.features.includes(key);",
  "+}",
  "diff --git a/CLAUDE.md b/CLAUDE.md",
  "index 1111111..2222222 100644",
  "--- a/CLAUDE.md",
  "+++ b/CLAUDE.md",
  "@@ -3,6 +3,8 @@",
  " This file is read automatically by Claude Code.",
  " ",
  "+## Feature map — the source of truth",
  "+docs/FEATURES.md is the canonical catalogue of every feature.",
  " ## Design system — read this before touching any UI",
  "",
].join("\n");

const THREADS = [
  { id: "th-1", workspaceId: "ws-prem", title: "Designing the entitlement gate", createdAt: now, updatedAt: now },
  { id: "th-2", workspaceId: "ws-prem", title: "Where Clerk fits for a Tauri app", createdAt: now, updatedAt: "2026-06-19T09:00:00Z" },
];

const MESSAGES = [
  { id: 1, workspaceId: "ws-prem", role: "user", content: "How should we gate premium features without breaking the BYOK promise?", model: null, inputTokens: null, outputTokens: null, costUsd: null, createdAt: now },
  {
    id: 2, workspaceId: "ws-prem", role: "assistant",
    content:
      "Gate the orchestration, not the keys.\n\n" +
      "BYOK stays free — your Anthropic, OpenAI, or local Ollama keys, your tokens. What earns a subscription is the **multi-agent harness**: running Direct pipelines, parallel and background runs, and the auto review-loop. That mirrors how Warp and Cursor justify a platform fee even under BYOK.\n\n" +
      "A clean split:\n\n" +
      "- **Free** — Talk, Review, terminals, git worktrees, BYOK & local models, a taste of Direct.\n" +
      "- **Pro** — unlimited pipeline runs, parallel execution, longer run history.\n" +
      "- **Team** — shared pipelines, SSO, central billing.\n\n" +
      "Enforcement is a signed entitlement verified in the Rust core, cached with a 14-day offline grace so the app never nags you on a plane.",
    model: "claude-sonnet-4-6", inputTokens: 4231, outputTokens: 372, costUsd: 0.0183, createdAt: now,
  },
];

const ANTHROPIC_MODELS = [
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", inputCostPerM: 15, outputCostPerM: 75, cacheReadCostPerM: 1.5, cacheCreationCostPerM: 18.75, maxContext: 1000000, supportsVision: true, supportsTools: true, tags: ["largest ctx", "best reasoning"] },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", inputCostPerM: 3, outputCostPerM: 15, cacheReadCostPerM: 0.3, cacheCreationCostPerM: 3.75, maxContext: 200000, supportsVision: true, supportsTools: true, tags: ["balanced", "coding"] },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", inputCostPerM: 0.8, outputCostPerM: 4, cacheReadCostPerM: 0.08, cacheCreationCostPerM: 1, maxContext: 200000, supportsVision: true, supportsTools: true, tags: ["fast", "cheap"] },
];
const OPENAI_MODELS = [
  { id: "gpt-4o", displayName: "GPT-4o", inputCostPerM: 2.5, outputCostPerM: 10, cacheReadCostPerM: 0, cacheCreationCostPerM: 0, maxContext: 128000, supportsVision: true, supportsTools: true, tags: ["balanced", "vision"] },
];
const OLLAMA_MODELS = [
  { id: "qwen2.5-coder", displayName: "Qwen2.5 Coder", inputCostPerM: 0, outputCostPerM: 0, cacheReadCostPerM: 0, cacheCreationCostPerM: 0, maxContext: 32000, supportsVision: false, supportsTools: true, tags: ["local", "free"] },
];
const MODELS_WITH_PROVIDER = [
  ...ANTHROPIC_MODELS.map((m) => ({ provider: "anthropic", model: m })),
  ...OPENAI_MODELS.map((m) => ({ provider: "openai", model: m })),
  ...OLLAMA_MODELS.map((m) => ({ provider: "ollama", model: m })),
];
const PROVIDERS = [
  { name: "anthropic", apiBase: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", models: ANTHROPIC_MODELS, enabled: true, protocol: "anthropic", local: false },
  { name: "openai", apiBase: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", models: OPENAI_MODELS, enabled: true, protocol: "openai-compatible", local: false },
  { name: "ollama", apiBase: "http://localhost:11434/v1", apiKeyEnv: "", models: OLLAMA_MODELS, enabled: true, protocol: "openai-compatible", local: true },
];

// Direct mode — pipelines, stages, roles
const pStage = (i, role, model, sub, ck, loopT) => ({
  id: "st-" + i, pipelineId: "pl-ff", position: i, role, agentModel: model, substrate: sub,
  checkpoint: ck, loopTargetPosition: loopT ?? null, loopMaxIterations: 2, loopMode: loopT != null ? "gated" : null,
  maxIterations: 25, posX: 80 + i * 250, posY: 120, parents: i === 0 ? [] : [i - 1], tools: null, customName: null, instructions: null,
});
const FF_STAGES = [
  pStage(0, "plan", "claude-haiku-4-5", "api", false),
  pStage(1, "plan_review", "claude-haiku-4-5", "api", false),
  pStage(2, "implement", "claude-sonnet-4-6", "api", true),
  pStage(3, "code_review", "claude-haiku-4-5", "api", true, 2),
  pStage(4, "test", "claude-haiku-4-5", "api", true),
];
const PIPELINES = [
  { id: "pl-ff", name: "Feature Factory", description: "Full build: plan, review, implement, review, test.", isBuiltin: true, createdAt: now },
  { id: "pl-bug", name: "Bugfix relay", description: "Reproduce, fix, verify. Lean and fast.", isBuiltin: true, createdAt: now },
  { id: "pl-plan", name: "Plan & review", description: "Thinking only — no code is written.", isBuiltin: true, createdAt: now },
  { id: "pl-cc", name: "Claude Code build", description: "Plan via API, then implement, review and test with Claude Code (CLI).", isBuiltin: true, createdAt: now },
];
// artifactKind ∈ plan|review|tests|diff|note ; environment ∈ worktree|action (lowercase!)
const role = (key, label, artifactKind, environment, canLoop) => ({
  key, label, description: label, promptBody: "", artifactKind, environment, canLoop,
  defaultTools: ["read_file", "list_files"], defaultSubstrate: "api", defaultCheckpoint: false,
  tokenEstIn: 4000, tokenEstOut: 1000, isBuiltin: true,
});
// list_pipelines returns PipelineWithStages[] (each { pipeline, stages }).
const PIPELINES_WS = PIPELINES.map((p) => ({ pipeline: p, stages: FF_STAGES.map((s) => ({ ...s, pipelineId: p.id })) }));
const ROLES = [
  role("plan", "Plan", "plan", "worktree", false),
  role("plan_review", "Plan review", "review", "worktree", true),
  role("implement", "Implement", "diff", "worktree", false),
  role("code_review", "Code review", "review", "worktree", true),
  role("test", "Test", "tests", "worktree", false),
  role("repro", "Reproduce", "note", "worktree", false),
  role("fix", "Fix", "diff", "worktree", false),
  role("verify", "Verify", "tests", "worktree", true),
  role("critique", "Critique", "review", "worktree", true),
  role("refine", "Refine", "plan", "worktree", false),
  role("architect", "Architect", "plan", "worktree", false),
  role("security_review", "Security review", "review", "worktree", true),
  role("pull_request", "Pull request", "note", "action", false),
  role("merge", "Merge", "note", "action", false),
  role("release", "Release", "note", "action", false),
];

const PERF = {
  app: { rssBytes: 412 * 1024 * 1024, cpuPct: 3.2, processCount: 5 },
  daemon: { rssBytes: 28 * 1024 * 1024, cpuPct: 0.4, processCount: 1 },
  total: { rssBytes: 440 * 1024 * 1024, cpuPct: 3.6, processCount: 6 },
  disk: { freeBytes: 312 * 1024 * 1024 * 1024, totalBytes: 1000 * 1024 * 1024 * 1024 },
  ts: 0,
};

const TOKEN_REPORT = {
  totalInput: 1284000, totalOutput: 96000, totalCached: 410000, totalCostUsd: 3.42,
  costBySession: [], costByModel: [], hourlyTrend: [], budgetRemaining: null, projectedDailyCost: 0.9,
};

// ─── Mock dispatcher (runs in the browser) ──────────────────────────────────
function makeInitScript(data) {
  return `(() => {
  const D = ${JSON.stringify(data)};
  const arg = (a, k) => (a && (a[k] !== undefined ? a[k] : a[k && k.replace(/[A-Z]/g, m => '_' + m.toLowerCase())]));
  function mock(cmd, a) {
    switch (cmd) {
      case "get_theme": return D.theme;
      case "list_themes": return [D.theme];
      case "list_recent_projects": return D.projects;
      case "list_closed_projects": return [];
      case "open_project": return D.project;
      case "create_project": return D.project;
      case "list_workspaces": return D.workspaces;
      case "workspaces_git_summary": return D.gitSummaries;
      case "open_prs_for_project": return D.openPrs;
      case "find_pr_for_branch": {
        const b = arg(a, "branch");
        const hit = D.openPrs.find(x => x.branch === b);
        return hit ? hit.pr : null;
      }
      case "get_git_status": return D.gitStatus;
      case "get_git_diff": return D.diff;
      case "get_staged_diff": return "";
      case "get_last_commit": return { shortSha: "52c3993", subject: "chore: release v0.1.93", body: "" };
      case "git_log": return [];
      case "list_branches": return { local: ["main", "premium-features"], remote: ["origin/main"] };
      case "blame_file": return [];
      case "get_issue_tracker_config": return null;
      case "list_my_issues": return [];
      case "list_models": return D.models;
      case "list_providers": return D.providers;
      case "list_adapters": return [];
      case "list_chat_threads": return D.threads;
      case "list_chat_messages": return D.messages; // arg is a thread id; one seeded conversation
      case "create_chat_thread": return { id: "th-new", workspaceId: arg(a, "workspaceId") || "ws-prem", title: arg(a, "title") || "New conversation", createdAt: D.now, updatedAt: D.now };
      case "rename_chat_thread": return null;
      case "get_message": return null;
      case "list_skills": return [];
      case "list_terminals": return [];
      case "list_pty_sessions": return [];
      case "list_mcp_servers": return [];
      case "list_mcp_tools": return [];
      case "get_mcp_config": return {};
      case "mcp_connection_status": return { binaryFound: true, claudeFound: true, registered: true, manualCommand: "claude mcp add octopush -s user -- octopush-mcp" };
      case "list_budgets": return [];
      case "current_spend": return { costUsd: 0, tokens: 0 };
      case "get_budget_status": return null;
      case "get_token_report": return D.tokenReport;
      case "get_usage_breakdown": return { cloudCostUsd: 3.42, cloudTokens: 1380000, localTokens: 240000, estSavingsUsd: 0.05 };
      case "get_perf_stats": return D.perf;
      case "get_workspace_cache_sizes": return { entries: [], totalBytes: 0 };
      case "list_pipelines": return D.pipelinesWs;
      case "get_pipeline": { const id = arg(a, "pipelineId") || arg(a, "id"); return D.pipelinesWs.find((x) => x.pipeline.id === id) || D.pipelinesWs[0]; }
      case "list_roles": return D.roles;
      case "list_runs": return [];
      case "get_run": return { run: null, stages: [] };
      case "estimate_run_cost": return { estimateUsd: 0.43, baselineUsd: 1.95 };
      case "list_stage_iterations": return [];
      case "get_stage_log": return [];
      case "list_file_edits": return [];
      case "read_directory": return [];
      case "list_workspace_files": return [];
      case "search_workspace_text": return [];
      case "read_file_checked": return { kind: "Text", content: "" };
      case "file_meta": return null;
      case "detect_editors": return [];
      case "get_settings": return { providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} };
      default:
        if (cmd && cmd.indexOf("plugin:event") === 0) return 0;     // listen → fake id
        if (cmd && cmd.indexOf("plugin:updater") === 0) return null; // no update
        return null;
    }
  }
  const callbacks = {};
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: {},
    callbacks,
    invoke: (cmd, a) => Promise.resolve(mock(cmd, a)),
    transformCallback: (cb) => { const id = (window.__cbId = (window.__cbId || 0) + 1); callbacks[id] = cb; return id; },
    unregisterCallback: (id) => { delete callbacks[id]; },
    runCallback: (id, payload) => { const cb = callbacks[id]; if (cb) cb(payload); },
    convertFileSrc: (p) => p,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: "macos" };
})();`;
}

const DATA = {
  now, theme: ATELIER, project: PROJECT, projects: [PROJECT], workspaces: WORKSPACES,
  gitSummaries: GIT_SUMMARIES, openPrs: OPEN_PRS, gitStatus: GIT_STATUS, diff: DIFF,
  threads: THREADS, messages: MESSAGES, models: MODELS_WITH_PROVIDER, providers: PROVIDERS,
  pipelines: PIPELINES, pipelinesWs: PIPELINES_WS, ffStages: FF_STAGES, roles: ROLES, perf: PERF, tokenReport: TOKEN_REPORT,
};

async function shoot(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, name + ".png") });
  console.log("  ✓ captured", name + ".png");
}

async function clickMode(page, label) {
  // ModeSwitcher renders text buttons (Talk/Run/Review/Direct) in the Companion header.
  const tries = [
    () => page.getByRole("button", { name: label, exact: true }).first().click({ timeout: 2500 }),
    () => page.locator("button", { hasText: new RegExp("^" + label + "$") }).first().click({ timeout: 2500 }),
    () => page.getByText(label, { exact: true }).first().click({ timeout: 2500 }),
  ];
  for (const t of tries) { try { await t(); return true; } catch (_) {} }
  console.log("  ! could not click mode", label);
  return false;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });

  // 1) Welcome screen — no open project.
  {
    const page = await context.newPage();
    await page.addInitScript(makeInitScript(DATA));
    page.on("pageerror", (e) => errors.push("[welcome] " + e.message));
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await shoot(page, "01-welcome");
    await page.close();
  }

  // 2) App open — Talk, Review, Direct. Seed lastOpenedProjectPath so it boots in.
  {
    const page = await context.newPage();
    await page.addInitScript(makeInitScript(DATA));
    await page.addInitScript(`localStorage.setItem("lastOpenedProjectPath", ${JSON.stringify(PROJECT.path)});
      localStorage.setItem("lastActiveWorkspacePerProject", ${JSON.stringify(JSON.stringify({ [PROJECT.id]: "ws-prem" }))});`);
    page.on("pageerror", (e) => errors.push("[app] " + e.message + (e.stack ? "\n    " + e.stack.split("\n").slice(0, 4).join("\n    ") : "")));
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2800);
    const rootKids = await page.evaluate(() => document.getElementById("root")?.childElementCount ?? -1);
    console.log("  root child count:", rootKids);
    // Make the rich workspace active (in case the seed didn't take).
    try { await page.getByText("premium-features", { exact: true }).first().click({ timeout: 2000 }); } catch (_) {}
    await page.waitForTimeout(1800);
    await shoot(page, "02-talk");

    if (await clickMode(page, "Review")) { await page.waitForTimeout(1800); await shoot(page, "03-review"); }
    if (await clickMode(page, "Direct")) {
      await page.waitForTimeout(2000); await shoot(page, "04-direct");
      // 05 — node-graph builder. Open Feature Factory's graph (hover ticket → Edit), else compose blank.
      try {
        await page.getByText("Feature Factory", { exact: false }).first().hover({ timeout: 1500 });
        await page.waitForTimeout(300);
        let opened = false;
        const tries = [
          () => page.getByRole("button", { name: /edit/i }).first().click({ timeout: 1200 }),
          () => page.getByTitle(/edit/i).first().click({ timeout: 1200 }),
          () => page.locator('[aria-label*="dit"]').first().click({ timeout: 1200 }),
        ];
        for (const t of tries) { try { await t(); opened = true; break; } catch (_) {} }
        if (!opened) { try { await page.getByText("Compose a new one", { exact: false }).first().click({ timeout: 1500 }); opened = true; } catch (_) {} }
        if (opened) { await page.waitForTimeout(2400); await shoot(page, "05-builder"); }
        else console.log("  ! builder: no trigger found");
      } catch (_) { console.log("  ! builder capture skipped"); }
    }
    await page.close();
  }

  await browser.close();
  if (errors.length) { console.log("\nPage errors:"); errors.slice(0, 30).forEach((e) => console.log("  -", e)); }
  console.log("\nDone → " + OUT_DIR);
})().catch((e) => { console.error(e); process.exit(1); });
