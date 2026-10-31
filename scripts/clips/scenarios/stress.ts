// `stress` — the default user with the data real people have and demos don't:
// very long names everywhere (project, workspaces, branches, pipelines, runs,
// threads, models), many items, and big numbers. The visual audit
// (scripts/visual-audit/) renders every surface with it; layout bugs that only
// show with real-world data (#312) surface here first.
//
// When a layout bug escapes to users, add the data that would have caught it.
import type { Scenario } from "./types";
import type { PipelineWithStages, Run } from "../../../src/lib/ipc";
import type { ChatThread, ModelWithProvider, ProjectInfo, TokenReport, Workspace, WorkspaceGitSummary } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES as F } from "./default";

const LONG = [
  "Production deploy (octopush-api)",
  "Production deploy (octopush-web)",
  "Small Change Ship",
  "New Model Rollout with staged canaries and rollback",
  "refactor-the-entire-authentication-and-session-layer",
  "Ü/ñ émojis 🐙 and CJK 長い名前のパイプライン",
  "x",
];
const pick = (i: number) => LONG[i % LONG.length];

const PROJECT: ProjectInfo = { ...F.PROJECT, name: "octopush-enterprise-monorepo-with-a-very-long-name" };

const WORKSPACES: Workspace[] = [
  F.WORKSPACES[0],
  ...Array.from({ length: 24 }, (_, i): Workspace => ({
    ...F.WORKSPACES[1],
    id: `ws-${i}`,
    name: i === 0 ? F.WORKSPACES[1].name : `${pick(i)}-${i}`,
    branch: `feature/JIRA-${1000 + i}-${pick(i).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    task: `${pick(i + 1)} — and make sure the follow-up tasks are tracked too`,
  })),
];
const ACTIVE = WORKSPACES[1];

const SUMMARIES: WorkspaceGitSummary[] = WORKSPACES.map((w, i) => ({
  workspaceId: w.id, dirty: i % 2 === 1, ahead: i * 37, behind: i % 3 === 0 ? 1204 : 0,
}));

const PIPELINES: PipelineWithStages[] = Array.from({ length: 12 }, (_, i) => {
  const base = F.PIPELINES[0];
  return {
    pipeline: { ...base.pipeline, id: i === 0 ? base.pipeline.id : `pl-${i}`, name: i === 0 ? base.pipeline.name : pick(i - 1), isBuiltin: i % 3 === 0 },
    stages: i % 4 === 1 ? base.stages.slice(0, 1) : base.stages,
  };
});

const RUNS: Run[] = Array.from({ length: 18 }, (_, i) => ({
  ...F.RUN,
  id: i === 0 ? F.RUN.id : `run-${i}`,
  workspaceId: ACTIVE.id,
  task: i === 0 ? F.RUN.task : `${pick(i)}: ${"fix the flaky integration tests and update the docs ".repeat(1 + (i % 3))}`.trim(),
  status: (["completed", "failed", "running", "aborted", "paused"] as const)[i % 5],
  costUsd: i === 3 ? 12_843.27 : F.RUN.costUsd,
  baselineUsd: i === 3 ? 98_211.9 : F.RUN.baselineUsd,
}));

const THREADS: ChatThread[] = Array.from({ length: 15 }, (_, i) => ({
  ...F.THREAD,
  id: i === 0 ? F.THREAD.id : `th-${i}`,
  workspaceId: ACTIVE.id,
  title: i === 0 ? F.THREAD.title : `${pick(i)} — ${"why does the build break on CI but not locally ".repeat(1 + (i % 2))}`.trim(),
}));

const MODELS: ModelWithProvider[] = [
  ...F.MODELS,
  { provider: "openrouter-with-a-long-provider-name", model: { ...F.MODELS[0].model, id: "anthropic/claude-opus-4-6-20260101-extended-thinking-preview", displayName: "Claude Opus 4.6 Extended Thinking (Preview, 2026-01-01)" } },
];

const TOKEN_REPORT: TokenReport = {
  totalInput: 9_876_543_210, totalOutput: 1_234_567_890, totalCached: 4_321_000_000, totalCostUsd: 123_456.78,
  costBySession: [], costByModel: [], hourlyTrend: [], budgetRemaining: null, projectedDailyCost: 4_115.22,
};

export const stress: Scenario = {
  name: "stress",
  description: "Default user with real-world data: very long names, many items, big numbers (visual audit).",
  localStorage: {
    lastOpenedProjectPath: PROJECT.path,
    lastActiveWorkspacePerProject: JSON.stringify({ [PROJECT.id]: ACTIVE.id }),
  },
  commands: {
    ...defaultScenario.commands,
    list_recent_projects: [PROJECT],
    open_project: PROJECT,
    list_workspaces: WORKSPACES,
    workspaces_git_summary: SUMMARIES,
    list_pipelines: PIPELINES,
    get_pipeline: (a) => PIPELINES.find((p) => p.pipeline.id === a.pipelineId || p.pipeline.id === a.id) ?? PIPELINES[0],
    list_runs: (a) => (a.workspaceId === ACTIVE.id ? RUNS : []),
    // Consistent everywhere: every run has its stages, and the live ones are
    // what Mission Control and the top bar see (a mismatch here reads as an
    // app bug to the design review).
    get_run: (a) => {
      const run = RUNS.find((r) => r.id === a.runId) ?? null;
      if (!run) return { run: null, stages: [] };
      const live = run.status === "running" || run.status === "paused";
      return {
        run,
        stages: F.RUN_STAGES.map((s, i, all) => ({
          ...s, id: `${run.id}-${s.id}`, runId: run.id,
          status: live && i === all.length - 1 ? (run.status === "paused" ? "awaiting_checkpoint" : "running") : run.status === "failed" && i === all.length - 1 ? "failed" : "done",
          finishedAt: live && i === all.length - 1 ? null : s.finishedAt,
        })),
      };
    },
    list_active_runs: RUNS.filter((r) => r.status === "running" || r.status === "paused"),
    list_chat_threads: (a) => (a.workspaceId === ACTIVE.id ? THREADS : []),
    list_chat_messages: (a) => (a.threadId === F.THREAD.id ? F.MESSAGES : []),
    list_models: MODELS,
    get_token_report: TOKEN_REPORT,
    direct_run_usage: { used: 1_284, limit: null, remaining: null },
    get_last_commit: { shortSha: "52c3993", subject: "sync: gate uploads on the history pref ".repeat(4).trim(), body: "" },
  },
};
