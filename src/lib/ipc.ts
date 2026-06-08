// Thin typed wrappers around Tauri's `invoke` for the Octopus core.

// ─── Direct mode (orchestration) — types ──────────────────────────────────

export type AgentSubstrate = "api" | "cli";
export type RunStatus =
  | "draft" | "running" | "paused" | "completed" | "aborted" | "failed";
export type RunStageStatus =
  | "pending" | "running" | "awaiting_checkpoint" | "done" | "failed";

export interface PipelineStage {
  id: string;
  pipelineId: string;
  position: number;
  role: string;
  agentModel: string;
  substrate: AgentSubstrate;
  checkpoint: boolean;
}
export interface Pipeline {
  id: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  createdAt: string;
}
export interface PipelineWithStages {
  pipeline: Pipeline;
  stages: PipelineStage[];
}
export interface Run {
  id: string;
  workspaceId: string;
  pipelineId: string;
  task: string;
  status: RunStatus;
  costUsd: number;
  baselineUsd: number;
  referenceModel: string | null;
  linkedIssueKey: string | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface RunStage {
  id: string;
  runId: string;
  position: number;
  role: string;
  agentModel: string;
  substrate: AgentSubstrate;
  checkpoint: boolean;
  status: RunStageStatus;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  artifact: string | null;
  feedback: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface RunDetail {
  run: Run | null;
  stages: RunStage[];
}
export type CheckpointActionName = "approve" | "reject" | "edit" | "abort";

import { invoke } from "@tauri-apps/api/core";
import type {
  AdapterInfo,
  AppSettings,
  Budget,
  BudgetPeriod,
  BudgetScope,
  BudgetStatus,
  BranchPr,
  EditorChoice,
  ChatMessage,
  CreateSessionArgs,
  DirectoryEntry,
  FileEdit,
  GitStatus,
  Issue,
  IssueTrackerConfig,
  ModelSuggestion,
  ModelWithProvider,
  Pr,
  PerfStats,
  ProjectInfo,
  ProviderConfig,
  PtySession,
  RefreshPricingResult,
  Session,
  SessionRecap,
  SearchHit,
  SessionTemplate,
  SpendSnapshot,
  TaskType,
  TerminalRecord,
  TestRunResult,
  ThemeConfig,
  TintName,
  TokenEvent,
  TokenReport,
  UsageBreakdown,
  Workspace,
  WorkspaceCacheSizes,
  WorkspaceGitSummary,
} from "./types";

export const ipc = {
  // ─── Sessions ─────────────────────────────────────────────────
  createSession: (args: CreateSessionArgs) =>
    invoke<Session>("create_session", { args }),

  listSessions: () => invoke<Session[]>("list_sessions"),

  writeToSession: (sessionId: string, data: Uint8Array) =>
    invoke<void>("write_to_session", {
      sessionId,
      data: Array.from(data),
    }),

  writeTextToSession: (sessionId: string, text: string) =>
    invoke<void>("write_text_to_session", { sessionId, text }),

  resizeSession: (sessionId: string, rows: number, cols: number) =>
    invoke<void>("resize_session", { sessionId, rows, cols }),

  killSession: (sessionId: string) =>
    invoke<void>("kill_session", { sessionId }),

  deleteSession: (sessionId: string) =>
    invoke<void>("delete_session", { sessionId }),

  // ─── Tokens ───────────────────────────────────────────────────
  getTokenReport: (sessionId?: string) =>
    invoke<TokenReport>("get_token_report", { sessionId: sessionId ?? null }),

  recordTokenEvent: (event: TokenEvent) =>
    invoke<void>("record_token_event", { event }),

  getBudgetStatus: (sessionId: string) =>
    invoke<BudgetStatus>("get_budget_status", { sessionId }),

  setTokenBudget: (sessionId: string, budget: number | null) =>
    invoke<void>("set_token_budget", { sessionId, budget }),

  // ─── Templates ────────────────────────────────────────────────
  listTemplates: () => invoke<SessionTemplate[]>("list_templates"),

  saveTemplate: (template: SessionTemplate) =>
    invoke<void>("save_template", { template }),

  deleteTemplate: (name: string) =>
    invoke<void>("delete_template", { name }),

  // ─── Providers / Agents ───────────────────────────────────────
  listProviders: () => invoke<ProviderConfig[]>("list_providers"),

  saveProviders: (providers: ProviderConfig[]) =>
    invoke<void>("save_providers", { providers }),

  getDefaultProviders: () =>
    invoke<ProviderConfig[]>("get_default_providers"),

  listModels: () => invoke<ModelWithProvider[]>("list_models"),

  suggestModel: (taskType: TaskType) =>
    invoke<ModelSuggestion>("suggest_model", { taskType }),

  listAdapters: () => invoke<AdapterInfo[]>("list_adapters"),

  switchAgent: (sessionId: string, newModel: string) =>
    invoke<{ session: Session; appliedToPty: boolean; message: string }>(
      "switch_agent",
      { sessionId, newModel },
    ),

  // ─── Recap / Export ────────────────────────────────────────────
  getSessionRecap: (sessionId: string) =>
    invoke<SessionRecap>("get_session_recap", { sessionId }),

  exportSessionJson: (sessionId: string) =>
    invoke<string>("export_session_json", { sessionId }),

  exportSessionCsv: (sessionId: string) =>
    invoke<string>("export_session_csv", { sessionId }),

  // ─── Theme ────────────────────────────────────────────────────
  getTheme: () => invoke<ThemeConfig>("get_theme"),
  setTheme: (theme: ThemeConfig) => invoke<void>("set_theme", { theme }),
  listThemes: () => invoke<ThemeConfig[]>("list_themes"),

  // ─── Projects ───────────────────────────────────────────────────
  openProject: (path: string) => invoke<ProjectInfo>("open_project", { path }),
  listRecentProjects: () => invoke<ProjectInfo[]>("list_recent_projects"),
  createProject: (path: string, name: string) => invoke<ProjectInfo>("create_project", { path, name }),
  cloneProject: (args: {
    path: string;
    url: string;
    nameOverride?: string;
    credentials?: { username: string; token: string };
  }) =>
    invoke<ProjectInfo>("clone_project", {
      path: args.path,
      url: args.url,
      nameOverride: args.nameOverride ?? null,
      credentials: args.credentials ?? null,
    }),
  updateProjectCustomization: (projectId: string, name: string | null, tint: string | null) =>
    invoke<void>("update_project_customization", { projectId, name, tint }),
  closeProject: (projectId: string) =>
    invoke<void>("close_project", { projectId }),
  deleteProject: (projectId: string) =>
    invoke<void>("delete_project", { projectId }),
  reopenProject: (projectId: string) =>
    invoke<void>("reopen_project", { projectId }),
  listClosedProjects: () => invoke<ProjectInfo[]>("list_closed_projects"),
  setProjectPinned: (projectId: string, pinned: boolean) =>
    invoke<void>("set_project_pinned", { projectId, pinned }),
  setProjectOrder: (ids: string[]) => invoke<void>("set_project_order", { ids }),

  // ─── Workspaces ─────────────────────────────────────────────────
  createWorkspace: (projectId: string, projectPath: string, name: string, task: string,
                    branch: string, fromBranch: string, setupScript: string) =>
    invoke<Workspace>("create_workspace", { projectId, projectPath, name, task, branch, fromBranch, setupScript }),
  listWorkspaces: (projectId: string) => invoke<Workspace[]>("list_workspaces", { projectId }),

  workspacesGitSummary: (projectId: string) =>
    invoke<WorkspaceGitSummary[]>("workspaces_git_summary", { projectId }),
  deleteWorkspace: (workspaceId: string, projectPath: string, branch: string, worktreePath: string | null) =>
    invoke<void>("delete_workspace", { workspaceId, projectPath, branch, worktreePath }),
  archiveWorkspace: (workspaceId: string, projectPath: string, branch: string, worktreePath: string | null) =>
    invoke<void>("archive_workspace", { workspaceId, projectPath, branch, worktreePath }),
  renameWorkspace: (workspaceId: string, name: string) =>
    invoke<void>("rename_workspace", { workspaceId, name }),
  listArchivedWorkspaces: (projectId: string) =>
    invoke<Workspace[]>("list_archived_workspaces", { projectId }),
  restoreWorkspace: (workspaceId: string, projectPath: string, branch: string, worktreePath: string | null) =>
    invoke<void>("restore_workspace", { workspaceId, projectPath, branch, worktreePath }),
  updateWorkspaceCustomization: (
    workspaceId: string,
    glyph: string | null,
    tint: TintName | null,
  ) =>
    invoke<void>("update_workspace_customization", { workspaceId, glyph, tint }),

  // ─── Chat ───────────────────────────────────────────────────────
  sendChatMessage: (request: {
    workspaceId: string;
    workspacePath: string;
    model: string;
    userMessage: string;
    system?: string;
    maxTokens: number;
  }) => invoke<void>("send_chat_message", { request }),
  listChatMessages: (workspaceId: string) => invoke<ChatMessage[]>("list_chat_messages", { workspaceId }),

  // ─── Git ────────────────────────────────────────────────────────
  getGitStatus: (path: string) => invoke<GitStatus>("get_git_status", { path }),
  getGitDiff: (path: string) => invoke<string>("get_git_diff", { path }),

  // ─── File operations ───────────────────────────────────────────
  openFileInSystem: (path: string) => invoke<void>("open_file_in_system", { path }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),
  detectEditors: () => invoke<EditorChoice[]>("detect_editors"),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),

  // ─── Directory listing ─────────────────────────────────────────
  readDirectory: (path: string) => invoke<DirectoryEntry[]>("read_directory", { path }),

  // ─── Budgets ──────────────────────────────────────────────────
  listBudgets: () => invoke<Budget[]>("list_budgets"),

  setBudget: (scopeType: BudgetScope, scopeId: string, period: BudgetPeriod, limitUsd: number) =>
    invoke<void>("set_budget", { scopeType, scopeId, period, limitUsd }),

  clearBudget: (scopeType: BudgetScope, scopeId: string, period: BudgetPeriod) =>
    invoke<void>("clear_budget", { scopeType, scopeId, period }),

  currentSpend: (scopeType: BudgetScope, scopeId: string, period: BudgetPeriod) =>
    invoke<SpendSnapshot>("current_spend", { scopeType, scopeId, period }),

  exportTokenEventsCsv: (startIso: string, endIso: string) =>
    invoke<string>("export_token_events_csv", { startIso, endIso }),

  getUsageBreakdown: (startIso: string, endIso: string) =>
    invoke<UsageBreakdown>("get_usage_breakdown", { startIso, endIso }),

  refreshPricing: () =>
    invoke<RefreshPricingResult>("refresh_pricing"),

  // ─── Settings ─────────────────────────────────────────────────
  getSettings: () =>
    invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) =>
    invoke<void>("save_settings", { settings }),
  saveGitCredentials: (host: string, username: string, token: string) =>
    invoke<void>("save_git_credentials", { host, username, token }),

  // ─── Terminals ────────────────────────────────────────────────
  listTerminals: (workspaceId: string) =>
    invoke<TerminalRecord[]>("list_terminals", { workspaceId }),
  createTerminal: (workspaceId: string, label: string) =>
    invoke<TerminalRecord>("create_terminal", { workspaceId, label }),
  renameTerminal: (id: string, label: string) =>
    invoke<void>("rename_terminal", { id, label }),
  deleteTerminal: (id: string) =>
    invoke<void>("delete_terminal", { id }),

  // ─── File edits (Review canvas) ───────────────────────────────
  listFileEdits: (workspaceId: string) =>
    invoke<FileEdit[]>("list_file_edits", { workspaceId }),

  getMessage: (messageId: number) =>
    invoke<ChatMessage>("get_message", { messageId }),

  // ─── Hunk operations ──────────────────────────────────────────
  revertHunk: (workspacePath: string, hunkText: string) =>
    invoke<void>("revert_hunk", { workspacePath, hunkText }),

  stageHunk: (workspacePath: string, hunkText: string) =>
    invoke<void>("stage_hunk", { workspacePath, hunkText }),

  stageAllChanges: (workspacePath: string) =>
    invoke<void>("stage_all_changes", { workspacePath }),

  // ─── Stage / commit / push flow ───────────────────────────────
  stageFile: (workspacePath: string, filePath: string) =>
    invoke<void>("stage_file", { workspacePath, filePath }),

  unstageFile: (workspacePath: string, filePath: string) =>
    invoke<void>("unstage_file", { workspacePath, filePath }),

  unstageAllChanges: (workspacePath: string) =>
    invoke<void>("unstage_all_changes", { workspacePath }),

  /** Returns the new short SHA on success. */
  commitChanges: (workspacePath: string, message: string) =>
    invoke<string>("commit_changes", { workspacePath, message }),

  /** Returns the trimmed git-push output (combined stdout+stderr). */
  pushBranch: (workspacePath: string) =>
    invoke<string>("push_branch", { workspacePath }),

  /** Workspace-wide file listing (respects .gitignore). Returns paths
   *  relative to the workspace root. Capped at 20k entries. */
  listWorkspaceFiles: (workspacePath: string) =>
    invoke<string[]>("list_workspace_files", { workspacePath }),

  /** Workspace-wide text search. Literal substring match (not regex);
   *  case-insensitive when `caseSensitive` is false. Capped at 500 hits. */
  searchWorkspaceText: (
    workspacePath: string,
    query: string,
    caseSensitive = false,
  ) =>
    invoke<SearchHit[]>("search_workspace_text", {
      workspacePath,
      query,
      caseSensitive,
    }),

  /** Look up a pull request on GitHub for the current branch (any state).
   *  Resolves to `null` when there's no PR, no GitHub remote, or any
   *  network error — UI is expected to hide the chip silently. */
  findPrForBranch: (workspacePath: string) =>
    invoke<Pr | null>("find_pr_for_branch", { workspacePath }),

  openPrsForProject: (projectPath: string) =>
    invoke<BranchPr[]>("open_prs_for_project", { projectPath }),

  // ─── Test runner ──────────────────────────────────────────────
  runTestCommand: (workspacePath: string, command: string) =>
    invoke<TestRunResult>("run_test_command", { workspacePath, command }),

  setWorkspaceTestCommand: (workspaceId: string, command: string) =>
    invoke<void>("set_workspace_test_command", { workspaceId, command }),

  detectDefaultTestCommand: (workspacePath: string) =>
    invoke<string | null>("detect_default_test_command", { workspacePath }),

  // ─── PTY daemon ───────────────────────────────────────────────
  /** List all PTY sessions currently alive in the daemon. */
  listPtySessions: () =>
    invoke<PtySession[]>("list_pty_sessions"),

  /**
   * Spawn a PTY for `id`, or reattach if the daemon already has a running
   * session for that id (e.g. after an Octopush restart).
   */
  spawnOrAttachTerminal: (id: string, cwd: string, label: string) =>
    invoke<{ mode: "Spawned"; pid: number } | { mode: "Reattached" }>(
      "spawn_or_attach_terminal",
      { id, cwd, label },
    ),

  // ─── Performance ──────────────────────────────────────────────
  getPerfStats: () => invoke<PerfStats>("get_perf_stats"),

  getWorkspaceCacheSizes: (workspacePath: string) =>
    invoke<WorkspaceCacheSizes>("get_workspace_cache_sizes", { workspacePath }),

  // ─── Issue Tracker ────────────────────────────────────────────
  listMyIssues: () => invoke<Issue[]>("list_my_issues"),
  getIssue: (key: string) => invoke<Issue>("get_issue", { key }),
  listIssuesInEpic: (epicKey: string) =>
    invoke<Issue[]>("list_issues_in_epic", { epicKey }),
  getIssueTrackerConfig: () =>
    invoke<IssueTrackerConfig | null>("get_issue_tracker_config"),
  saveIssueTrackerConfig: (config: IssueTrackerConfig) =>
    invoke<void>("save_issue_tracker_config", { config }),
  updateWorkspaceLink: (workspaceId: string, linkedIssueKey: string | null) =>
    invoke<void>("update_workspace_link", { workspaceId, linkedIssueKey }),
  updateProjectJiraKey: (projectId: string, jiraProjectKey: string | null) =>
    invoke<void>("update_project_jira_key", { projectId, jiraProjectKey }),

  // ─── Direct mode (orchestration) ──────────────────────────────────
  listPipelines: () =>
    invoke<PipelineWithStages[]>("list_pipelines"),

  createRun: (
    workspaceId: string,
    pipelineId: string,
    task: string,
    referenceModel?: string,
    linkedIssueKey?: string,
  ) =>
    invoke<string>("create_run", {
      workspaceId,
      pipelineId,
      task,
      referenceModel: referenceModel ?? null,
      linkedIssueKey: linkedIssueKey ?? null,
    }),

  startRun: (runId: string) =>
    invoke<void>("start_run", { runId }),

  getRun: (runId: string) =>
    invoke<RunDetail>("get_run", { runId }),

  listRuns: (workspaceId: string) =>
    invoke<Run[]>("list_runs", { workspaceId }),

  resolveCheckpoint: (
    runId: string,
    action: CheckpointActionName,
    feedback?: string,
    modelOverride?: string,
  ) =>
    invoke<void>("resolve_checkpoint", {
      runId,
      action,
      feedback: feedback ?? null,
      modelOverride: modelOverride ?? null,
    }),

  abortRun: (runId: string) =>
    invoke<void>("abort_run", { runId }),

  estimateRunCost: (pipelineId: string) =>
    invoke<{ estimateUsd: number; baselineUsd: number }>("estimate_run_cost", {
      pipelineId,
    }),
};

/** Tauri event names emitted by the orchestrator. */
export const RUN_EVENTS = {
  stageUpdate: "run://stage-update",
  cost: "run://cost",
  checkpoint: "run://checkpoint",
  log: "run://log",
} as const;
