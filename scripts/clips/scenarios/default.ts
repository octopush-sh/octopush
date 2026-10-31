// `default` — the scenario most clips start from: a signed-in Pro user with
// one project ("octopush") and two workspaces, a finished Direct run with
// stages and costs, a short Talk conversation, and three providers set up.
import type { Scenario } from "./types";
import type {
  AuthStatus,
  DirectRunUsage,
  Entitlement,
  PipelineStage,
  PipelineWithStages,
  Role,
  Run,
  RunDetail,
  RunStage,
} from "../../../src/lib/ipc";
import type {
  AppSettings,
  DirectoryEntry,
  BranchList,
  BranchPr,
  ChatMessage,
  ChatThread,
  GitStatus,
  ModelInfo,
  ModelWithProvider,
  PerfStats,
  ProjectInfo,
  ProviderConfig,
  SyncPrefs,
  TerminalRecord,
  ThreadCost,
  TokenReport,
  Workspace,
  WorkspaceGitSummary,
} from "../../../src/lib/types";
import { ATELIER, NOW } from "./shared";

const EARLIER = "2026-10-28T14:12:00Z";

// ─── Project & workspaces ────────────────────────────────────────────────
const PROJECT: ProjectInfo = {
  id: "proj-octo",
  name: "octopush",
  path: "/Users/dev/code/octopush",
  jiraProjectKey: null,
  pinned: true,
  tint: "brass",
};

const ws = (id: string, name: string, branch: string, task: string, tint: Workspace["tint"]): Workspace => ({
  id,
  projectId: PROJECT.id,
  name,
  task,
  branch,
  worktreePath: branch === "main" ? PROJECT.path : `${PROJECT.path}/.octopus-worktrees/${branch}`,
  setupScript: "",
  status: "active",
  createdAt: EARLIER,
  lastActive: NOW,
  glyph: null,
  tint,
  testCommand: "npm test",
  linkedIssueKey: null,
  fromBranch: branch === "main" ? null : "main",
});

const WORKSPACES: Workspace[] = [
  ws("ws-main", "main", "main", "", "brass"),
  ws("ws-sync", "run-history-sync", "run-history-sync", "Make cloud run-history sync opt-in", "verdigris"),
];
const ACTIVE = WORKSPACES[1];

const GIT_SUMMARIES: WorkspaceGitSummary[] = [
  { workspaceId: "ws-main", dirty: false, ahead: 0, behind: 0 },
  { workspaceId: "ws-sync", dirty: true, ahead: 2, behind: 0 },
];

const GIT_STATUS: GitStatus = {
  branch: ACTIVE.branch,
  changedFiles: [
    { path: "src/components/settings/AccountPane.tsx", status: "modified", staged: false, unstaged: true, conflicted: false },
    { path: "src-tauri/src/sync.rs", status: "modified", staged: false, unstaged: true, conflicted: false },
  ],
  ahead: 2,
  behind: 0,
  hasUpstream: true,
  conflicted: 0,
  aheadBehindKnown: true,
  operation: null,
};

const DIFF = [
  "diff --git a/src-tauri/src/sync.rs b/src-tauri/src/sync.rs",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/src-tauri/src/sync.rs",
  "+++ b/src-tauri/src/sync.rs",
  "@@ -12,7 +12,9 @@ pub fn should_upload(prefs: &SyncPrefs) -> bool {",
  "-    true",
  "+    // Opt-in: nothing leaves the machine until the user turns it on.",
  "+    prefs.history_sync",
  " }",
  "",
].join("\n");

const BRANCHES: BranchList = { local: ["main", "run-history-sync"], remote: ["origin/main"] };
const OPEN_PRS: BranchPr[] = [];

// ─── Models & providers ──────────────────────────────────────────────────
const model = (id: string, displayName: string, inp: number, out: number, ctx: number, tags: string[]): ModelInfo => ({
  id,
  displayName,
  inputCostPerM: inp,
  outputCostPerM: out,
  cacheReadCostPerM: inp / 10,
  cacheCreationCostPerM: inp * 1.25,
  maxContext: ctx,
  supportsVision: true,
  supportsTools: true,
  tags,
});
const ANTHROPIC = [
  model("claude-opus-4-6", "Claude Opus 4.6", 15, 75, 1_000_000, ["best reasoning"]),
  model("claude-sonnet-4-6", "Claude Sonnet 4.6", 3, 15, 200_000, ["balanced", "coding"]),
  model("claude-haiku-4-5", "Claude Haiku 4.5", 0.8, 4, 200_000, ["fast", "cheap"]),
];
const OPENAI = [model("gpt-4o", "GPT-4o", 2.5, 10, 128_000, ["balanced"])];
const OLLAMA = [{ ...model("qwen2.5-coder", "Qwen2.5 Coder", 0, 0, 32_000, ["local", "free"]), supportsVision: false }];

const PROVIDERS: ProviderConfig[] = [
  { name: "anthropic", apiBase: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", models: ANTHROPIC, enabled: true, protocol: "anthropic", local: false },
  { name: "openai", apiBase: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", models: OPENAI, enabled: true, protocol: "openai-compatible", local: false },
  { name: "ollama", apiBase: "http://localhost:11434/v1", apiKeyEnv: "", models: OLLAMA, enabled: true, protocol: "openai-compatible", local: true },
];
const MODELS: ModelWithProvider[] = PROVIDERS.flatMap((p) => p.models.map((m) => ({ provider: p.name, model: m })));

const SETTINGS: AppSettings = {
  providerKeys: { anthropic: "sk-ant-demo…", openai: "sk-demo…" },
  providerBaseUrls: {},
  gitCredentials: {},
  lastPricingRefresh: EARLIER,
  historySyncEnabled: false,
  librarySyncEnabled: false,
};

// ─── Talk ────────────────────────────────────────────────────────────────
const THREAD: ChatThread = { id: "th-1", workspaceId: ACTIVE.id, title: "Making sync opt-in", createdAt: EARLIER, updatedAt: NOW };
const MESSAGES: ChatMessage[] = [
  {
    id: 1, workspaceId: ACTIVE.id, role: "user", model: null, inputTokens: null, outputTokens: null, costUsd: null, createdAt: EARLIER,
    content: "Where does the app decide to upload run history?",
  },
  {
    id: 2, workspaceId: ACTIVE.id, role: "assistant", model: "claude-sonnet-4-6", inputTokens: 3120, outputTokens: 214, costUsd: 0.0126, createdAt: EARLIER,
    content:
      "The decision is `should_upload`, and it returns `true` unconditionally — every finished run is pushed.\n\n" +
      "It lives in `src-tauri/src/sync.rs`. Gate it on the per-account `history_sync` preference and default that to **off**; the Account pane already has the toggle wired to `set_sync_pref`.",
  },
  {
    id: 3, workspaceId: ACTIVE.id, role: "user", model: null, inputTokens: null, outputTokens: null, costUsd: null, createdAt: NOW,
    content: "Do it, and add a note under the toggle explaining what turning it off does.",
  },
];
const THREAD_COST: ThreadCost = { spentUsd: 0.0126, subagentsUsd: 0, baselineUsd: 0.063, strongPriced: true, calls: 1, cacheHitPct: 41 };

// ─── Direct ──────────────────────────────────────────────────────────────
const PIPELINE_ID = "pl-ff";
const STAGE_PLAN: Array<[string, string, boolean]> = [
  ["plan", "claude-haiku-4-5", false],
  ["implement", "claude-sonnet-4-6", true],
  ["code_review", "claude-haiku-4-5", false],
  ["test", "claude-haiku-4-5", false],
];
const PIPELINE_STAGES: PipelineStage[] = STAGE_PLAN.map(([role, agentModel, checkpoint], i) => ({
  id: `st-${i}`, pipelineId: PIPELINE_ID, position: i, role, agentModel, substrate: "api", checkpoint,
  loopTargetPosition: null, loopMaxIterations: 2, loopMode: null, maxIterations: 25,
  posX: 80 + i * 250, posY: 120, parents: i === 0 ? [] : [i - 1], tools: null, customName: null, instructions: null,
}));
const PIPELINES: PipelineWithStages[] = [
  {
    pipeline: { id: PIPELINE_ID, name: "Feature Factory", description: "Plan, implement, review, test.", isBuiltin: true, createdAt: EARLIER },
    stages: PIPELINE_STAGES,
  },
];

const role = (key: string, label: string, artifactKind: Role["artifactKind"]): Role => ({
  key, label, description: label, promptBody: "", artifactKind, environment: "worktree", canLoop: artifactKind === "review",
  defaultTools: ["read_file", "list_files"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 4000, tokenEstOut: 1000, isBuiltin: true,
});
const ROLES: Role[] = [
  role("plan", "Plan", "plan"),
  role("implement", "Implement", "diff"),
  role("code_review", "Code review", "review"),
  role("test", "Test", "tests"),
];

const RUN: Run = {
  id: "run-1", workspaceId: ACTIVE.id, pipelineId: PIPELINE_ID, task: "Make cloud run-history sync opt-in, off by default",
  status: "completed", costUsd: 0.41, baselineUsd: 1.87, referenceModel: "claude-opus-4-6", linkedIssueKey: null,
  createdAt: EARLIER, finishedAt: NOW, budgetUsd: null, detached: false,
};
const STAGE_COSTS: Array<[number, number, number, string]> = [
  [5200, 900, 0.008, "1. Gate `should_upload` on `history_sync`.\n2. Default the pref to off.\n3. Add the note under the toggle."],
  [18400, 3100, 0.302, "Diff: 2 files, +14 −3."],
  [9100, 700, 0.022, "Looks right. The default is off and the copy is plain."],
  [6300, 450, 0.078, "12 passed, 0 failed."],
];
const RUN_STAGES: RunStage[] = PIPELINE_STAGES.map((s, i) => ({
  id: `rs-${i}`, runId: RUN.id, position: s.position, role: s.role, agentModel: s.agentModel, escalated: false,
  substrate: s.substrate, checkpoint: s.checkpoint, status: "done",
  inputTokens: STAGE_COSTS[i][0], outputTokens: STAGE_COSTS[i][1], costUsd: STAGE_COSTS[i][2], artifact: STAGE_COSTS[i][3],
  feedback: null, error: null, startedAt: EARLIER, finishedAt: NOW,
  loopTargetPosition: null, loopMaxIterations: 2, loopMode: null, loopIterations: 0,
  diffSnapshot: i === 1 ? DIFF : null, maxIterations: 25, parents: s.parents, tools: null, customName: null, instructions: null,
  sessionId: null, baselineCommit: null,
}));
const RUN_DETAIL: RunDetail = { run: RUN, stages: RUN_STAGES };

// ─── Account & usage ─────────────────────────────────────────────────────
const AUTH: AuthStatus = { signedIn: true, email: "dev@example.com", name: "Demo Developer" };
const ENTITLEMENT: Entitlement = { plan: "pro", features: ["direct_unlimited", "detached_runs", "routines", "history_sync"], directRunsPerMonth: null };
const RUN_USAGE: DirectRunUsage = { used: 7, limit: null, remaining: null };

const TOKEN_REPORT: TokenReport = {
  totalInput: 1_284_000, totalOutput: 96_000, totalCached: 410_000, totalCostUsd: 3.42,
  costBySession: [], costByModel: [], hourlyTrend: [], budgetRemaining: null, projectedDailyCost: 0.9,
};
const MB = 1024 * 1024;
const PERF: PerfStats = {
  app: { rssBytes: 412 * MB, cpuPct: 3.2, processCount: 5 },
  daemon: { rssBytes: 28 * MB, cpuPct: 0.4, processCount: 1 },
  total: { rssBytes: 440 * MB, cpuPct: 3.6, processCount: 6 },
  disk: { freeBytes: 312 * 1024 * MB, totalBytes: 1000 * 1024 * MB },
  ts: 0,
};

export const defaultScenario: Scenario = {
  name: "default",
  description: "Signed-in Pro user · project “octopush” with two workspaces · a finished Direct run · a short Talk thread · three providers.",
  localStorage: {
    lastOpenedProjectPath: PROJECT.path,
    lastActiveWorkspacePerProject: JSON.stringify({ [PROJECT.id]: ACTIVE.id }),
  },
  commands: {
    "plugin:app|version": "0.4.88",
    get_theme: ATELIER,
    list_themes: [ATELIER],
    // project & workspaces
    list_recent_projects: [PROJECT],
    list_closed_projects: [],
    open_project: PROJECT,
    list_workspaces: WORKSPACES,
    workspaces_git_summary: GIT_SUMMARIES,
    open_prs_for_project: OPEN_PRS,
    find_pr_for_branch: null,
    get_git_status: GIT_STATUS,
    get_git_diff: DIFF,
    get_staged_diff: "",
    get_last_commit: { shortSha: "52c3993", subject: "sync: gate uploads on the history pref", body: "" },
    list_branches: BRANCHES,
    // models & settings
    list_providers: PROVIDERS,
    list_models: MODELS,
    get_settings: SETTINGS,
    get_sync_prefs: { historySync: false, librarySync: false } satisfies SyncPrefs,
    sketchbook_path: "/Users/dev/.octopush/sketchbook",
    detect_editors: [],
    // run (terminals): the app opens one on first visit to a workspace
    // files (Review's tree, @file completion)
    read_directory: (a) => {
      const root = String(a.path ?? "");
      const tree: Record<string, Array<[string, boolean]>> = {
        "": [["src", true], ["src-tauri", true], ["package.json", false], ["README.md", false]],
        src: [["components", true], ["App.tsx", false]],
        "src/components": [["settings", true]],
        "src/components/settings": [["AccountPane.tsx", false]],
        "src-tauri": [["src", true], ["Cargo.toml", false]],
        "src-tauri/src": [["sync.rs", false], ["lib.rs", false]],
      };
      const rel = root.replace(/^\/Users\/dev\/code\/octopush(\/\.octopus-worktrees\/[^/]+)?\/?/, "");
      return (tree[rel] ?? []).map(([name, isDir]): DirectoryEntry => ({ name, path: `${root.replace(/\/$/, "")}/${name}`, isDir, isIgnored: false }));
    },
    list_workspace_files: ["package.json", "README.md", "src/App.tsx", "src/components/settings/AccountPane.tsx", "src-tauri/Cargo.toml", "src-tauri/src/lib.rs", "src-tauri/src/sync.rs"],
    list_file_edits: [],
    list_terminals: [],
    spawn_or_attach_terminal: { mode: "Spawned", pid: 4242 },
    create_terminal: (a): TerminalRecord => ({
      id: `term-${String(a.workspaceId)}`, workspaceId: String(a.workspaceId), label: String(a.label ?? "zsh"), position: 0, createdAt: Date.parse(NOW),
    }),
    // talk
    list_chat_threads: (a) => (a.workspaceId === ACTIVE.id ? [THREAD] : []),
    list_chat_messages: (a) => (a.threadId === THREAD.id ? MESSAGES : []),
    get_thread_cost: THREAD_COST,
    // direct
    list_pipelines: PIPELINES,
    get_pipeline: PIPELINES[0],
    list_roles: ROLES,
    list_runs: (a) => (a.workspaceId === ACTIVE.id ? [RUN] : []),
    get_run: (a) => (a.runId === RUN.id ? RUN_DETAIL : { run: null, stages: [] }),
    list_active_runs: [],
    has_ever_started_run: true,
    estimate_run_cost: { estimateUsd: 0.43, baselineUsd: 1.95 },
    // account & usage
    auth_status: AUTH,
    auth_refresh: AUTH,
    get_entitlement: ENTITLEMENT,
    direct_run_usage: RUN_USAGE,
    get_token_report: TOKEN_REPORT,
    get_perf_stats: PERF,
    get_workspace_cache_sizes: { entries: [], totalBytes: 0 },
    mcp_connection_status: { binaryFound: true, claudeFound: true, registered: true, manualCommand: "claude mcp add octopush -s user -- octopush-mcp" },
  },
};

/** The building blocks above, for scenarios that vary them (e.g. `stress`). */
export const DEFAULT_FIXTURES = { PROJECT, WORKSPACES, GIT_SUMMARIES, PIPELINES, ROLES, RUN, RUN_STAGES, THREAD, MESSAGES, PROVIDERS, MODELS };
