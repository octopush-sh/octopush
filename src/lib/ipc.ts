// Thin typed wrappers around Tauri's `invoke` for the Octopush core.

// ─── Direct mode (orchestration) — types ──────────────────────────────────

export type AgentSubstrate = "api" | "cli";
/** Per-stage reasoning effort — the cost/quality lever. `null`/absent = off
 *  (no thinking). The model-capability mapping (effort models vs the Haiku /
 *  Sonnet-4.5 thinking-budget path) is handled backend-side. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
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
  /** Per-stage reasoning effort; null/absent = off (no thinking). */
  effort?: Effort | null;
  /** Escalation policy — the stronger model to retry with if this stage fails.
   *  null/absent = no model swap on the retry. Either escalate field set = the
   *  stage has an escalation policy. */
  escalateModel?: string | null;
  /** Escalation policy — the effort to bump to on the failed-retry (API only).
   *  null/absent = keep the base effort on the retry. */
  escalateEffort?: Effort | null;
  substrate: AgentSubstrate;
  checkpoint: boolean;
  loopTargetPosition: number | null;
  loopMaxIterations: number;
  loopMode: "gated" | "auto" | null;
  /** Per-stage tool-turn budget (1..=100; default 25). */
  maxIterations: number;
  /** Canvas coordinates (builder layout). Null for legacy linear pipelines. */
  posX: number | null;
  posY: number | null;
  /** Upstream stage positions (flow-edge dependencies). Empty = linear chain. */
  parents: number[];
  /** Tool allowlist; null = the archetype's default tool set. */
  tools: string[] | null;
  /** Free display label; null = the archetype's label. */
  customName: string | null;
  /** Free-form additions appended to the archetype's system prompt. */
  instructions: string | null;
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

/** A scheduled routine (Pro): a saved pipeline that fires on a schedule. */
export interface Routine {
  id: string;
  name: string;
  projectId: string;
  pipelineId: string;
  task: string;
  referenceModel: string | null;
  stageOverrides: string | null;
  budgetUsd: number | null;
  scheduleKind: "interval" | "daily";
  /** Interval: whole seconds. Daily: "HH:MM" (24-hour, machine-local). */
  scheduleSpec: string;
  workspaceMode: "fixed" | "fresh";
  fixedWorkspaceId: string | null;
  baseBranch: string | null;
  branchPrefix: string | null;
  enabled: boolean;
  lastFiredAt: string | null;
  /** Next fire, RFC3339 UTC. Null = never (invalid spec). */
  nextDueAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  /** Optional pre-fire shell command (exit 0 ⇒ fire). Null = always fire. */
  fireCondition?: string | null;
  /** When the fire condition/fire was last evaluated (RFC3339 UTC). */
  lastCheckedAt?: string | null;
  /** The last evaluation's outcome ("dispatched" / "condition not met" / …). */
  lastOutcome?: string | null;
}

/** The mutable fields sent on create/update (camelCase → serde). */
export interface RoutineInput {
  name: string;
  projectId: string;
  pipelineId: string;
  task: string;
  referenceModel?: string | null;
  stageOverrides?: string | null;
  budgetUsd?: number | null;
  scheduleKind: "interval" | "daily";
  scheduleSpec: string;
  workspaceMode: "fixed" | "fresh";
  fixedWorkspaceId?: string | null;
  baseBranch?: string | null;
  branchPrefix?: string | null;
  /** Optional pre-fire shell command; trimmed, empty → omitted (always fire). */
  fireCondition?: string | null;
}

/** The outcome of a routine fire (from `runRoutineNow`): dispatched, or a skip
 *  with a human reason ("condition not met", "condition error: …"). */
export interface FireOutcomeView {
  outcome: "dispatched" | "skipped";
  reason?: string;
}
/** A builder-authored stage (position = array index, after topological sort). */
export interface StageDraft {
  role: string;
  agentModel: string;
  /** Per-stage reasoning effort; null/absent = off (no thinking). */
  effort?: Effort | null;
  /** Escalation policy — the stronger model to retry with if this stage fails.
   *  null/absent = no model swap on the retry. */
  escalateModel?: string | null;
  /** Escalation policy — the effort to bump to on the failed-retry (API only). */
  escalateEffort?: Effort | null;
  substrate: AgentSubstrate;
  checkpoint: boolean;
  loopTargetPosition: number | null;
  loopMaxIterations: number;
  loopMode: "gated" | "auto" | null;
  /** Per-stage tool-turn budget (1..=100). */
  maxIterations: number;
  /** Canvas coordinates, round-tripped so the graph reopens as it was drawn. */
  posX: number | null;
  posY: number | null;
  /** Upstream stage positions (flow-edge deps), each < this stage's position. */
  parents: number[];
  /** Tool allowlist; null = the archetype's default tool set. */
  tools: string[] | null;
  /** Free display label; null/empty = the archetype's label. */
  customName: string | null;
  /** Free-form additions appended to the archetype's system prompt. */
  instructions: string | null;
}
export interface PipelineDraft {
  pipelineId: string | null; // null = create; a builtin id = fork; a custom id = update
  name: string;
  description: string;
  stages: StageDraft[];
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
  /** Optional spend cap — the run pauses before any stage that would start
   *  at/over it. Null = no budget. */
  budgetUsd: number | null;
  /** True when the run executes in a detached segment worker (Pro) — the
   *  crew keeps working even if the app quits. */
  detached: boolean;
}
/** One question a blocked stage asks the director via `ask_director` — paired
 *  with the agent's own best guess so the director can accept it in one click.
 *  Mirrors the Rust `BlockedQuestion`. */
export interface BlockedQuestion {
  question: string;
  whyBlocked: string;
  recommendedDefault: string;
}

/** The structured payload of an `ask_director` call: a one-line summary plus
 *  the specific decisions the stage needs. Surfaced to the answer form while a
 *  stage is parked awaiting the director. Mirrors the Rust `BlockedAsk`. */
export interface BlockedAsk {
  summary: string;
  questions: BlockedQuestion[];
}

export interface RunStage {
  id: string;
  runId: string;
  position: number;
  role: string;
  agentModel: string;
  /** Per-stage reasoning effort; null/absent = off (no thinking). */
  effort?: Effort | null;
  /** Escalation policy copied from the template — the stronger model this
   *  stage retried with when it escalated. null/absent = no model swap. */
  escalateModel?: string | null;
  /** Sticky run-state: true once this stage escalated (its one retry at the
   *  strong tier after a failure). Drives the escalated badge. */
  escalated: boolean;
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
  loopTargetPosition: number | null;
  loopMaxIterations: number;
  loopMode: "gated" | "auto" | null;
  loopIterations: number;
  /** Worktree diff captured when the stage finished; null for legacy runs. */
  diffSnapshot: string | null;
  /** Per-stage tool-turn budget (copied from the template; default 25). */
  maxIterations: number;
  /** Upstream stage positions (flow-edge deps), copied from the template. */
  parents: number[];
  /** Tool allowlist copied from the template; null = archetype default. */
  tools: string[] | null;
  /** Free display label copied from the template; null = archetype label. */
  customName: string | null;
  /** Free-form prompt additions copied from the template. */
  instructions: string | null;
  /** CLI session id from the stage's last run; enables --resume. Null for API stages and legacy rows. */
  sessionId: string | null;
  /** Git commit SHA captured before the stage ran (enables Discard). Null when capture failed or non-repo. */
  baselineCommit: string | null;
  /** Escape valve: the stage's `ask_director` questions while it is parked
   *  awaiting the director; null/absent otherwise. Its presence marks an
   *  awaiting_checkpoint stage as a question-block (answer form) rather than a
   *  normal gate (Approve/Reject). */
  blockedQuestions?: BlockedAsk | null;
}
export interface RunDetail {
  run: Run | null;
  stages: RunStage[];
}

/** A hot-edit to a pending, not-yet-started run stage. Every field is
 *  optional — `undefined` leaves it unchanged. `instructions: null` clears
 *  the field (mirrors Rust `update_run_stage`'s `None` = "leave unchanged"). */
export interface RunStagePatch {
  checkpoint?: boolean;
  instructions?: string | null;
  agentModel?: string;
  maxIterations?: number;
  loopMode?: "gated" | "auto";
}

/** The one wire encoding of a RunStagePatch, shared by `updateRunStage` and
 *  `rerunFromStage` so the two paths can never drift: `undefined` → `null`
 *  (Rust `None`, "leave unchanged"); `instructions: null` → `""` (Rust
 *  `Some("")`, which trims to a cleared field). */
function stagePatchArgs(patch?: RunStagePatch) {
  return {
    checkpoint: patch?.checkpoint ?? null,
    instructions: patch?.instructions === undefined ? null : (patch.instructions ?? ""),
    agentModel: patch?.agentModel ?? null,
    maxIterations: patch?.maxIterations ?? null,
    loopMode: patch?.loopMode ?? null,
  };
}
export type CheckpointActionName = "approve" | "reject" | "edit" | "abort" | "send_back" | "resume" | "discard";

/** An archived stage attempt — a snapshot taken just before a loop-back /
 *  reject reset wiped the live stage row (matches Rust `StageIterationRow`). */
export interface StageIteration {
  id: string;
  runId: string;
  stageId: string;
  iteration: number;
  role: string;
  agentModel: string;
  status: string;
  /** Artifact JSON string (same shape as RunStage.artifact), or null. */
  artifact: string | null;
  error: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** The feedback that sent this attempt back (recorded on the review row). */
  closingFeedback: string | null;
  createdAt: string;
  /** The worktree diff as THIS attempt saw it; null for pre-snapshot archives. */
  diffSnapshot: string | null;
}

/** One live-activity entry streamed on `run://log` (see RUN_EVENTS.log). */
export type LiveEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; hint: string }
  | { kind: "tool_result"; ok: boolean; detail: string }
  | { kind: "notice"; text: string };

export type FileReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number; mtime: number }
  | { kind: "unsupportedEncoding"; size: number; mtime: number }
  | { kind: "tooLarge"; size: number };

/** Cheap stat for external-change detection. `null` = file no longer exists. */
export interface FileMeta {
  mtimeMs: number;
  size: number;
}

export type PullKind = "ok" | "diverged" | "conflict" | "error";
export interface PullOutcome { kind: PullKind; output: string }

export type ContinueKind = "ok" | "moreConflicts" | "error";
export interface ContinueOutcome { kind: ContinueKind; output: string }

export interface LastCommit { shortSha: string; subject: string; body: string }

/** One line of per-line blame (G7 slice III). Lines are 1-based and refer
 *  to the committed (HEAD) version of the file. */
export interface BlameLine {
  line: number;
  shaShort: string;
  authorName: string;
  timestampMs: number;
  summary: string;
}

/** One row of the commit history browser (G7 slice III). */
export interface CommitInfo {
  sha: string;
  shaShort: string;
  summary: string;
  authorName: string;
  /** Author time, ms since epoch — format relatively in the UI. */
  timestampMs: number;
}

/** One stash entry (G7 slice IV). Index 0 is the most recent (`stash@{0}`). */
export interface StashInfo {
  index: number;
  /** Full message as git records it ("On main: …" / "WIP on main: …"). */
  message: string;
  timestampMs: number;
}

import { invoke } from "@tauri-apps/api/core";
import type {
  AdapterInfo,
  AppSettings,
  Budget,
  BudgetPeriod,
  BudgetScope,
  BudgetStatus,
  BranchList,
  BranchPr,
  EditorChoice,
  ChatMessage,
  ChatThread,
  SkillMeta,
  Attachment,
  McpToolInfo,
  McpServerConfig,
  CreateSessionArgs,
  DirectoryEntry,
  FileEdit,
  GitStatus,
  Issue,
  IssueTrackerConfig,
  Mission,
  ModelSuggestion,
  ModelWithProvider,
  GhIssue,
  Pr,
  PrInfo,
  ShipReadiness,
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

// ─── Entitlement (premium scaffolding — P0) ───────────────────────
export type Plan = "free" | "pro" | "team" | "enterprise";
export interface Entitlement {
  plan: Plan;
  features: string[];
  /** Monthly Direct-run cap; null = unlimited (the P0 state). */
  directRunsPerMonth: number | null;
}
export interface DirectRunUsage {
  used: number;
  limit: number | null;
  remaining: number | null;
}

// ─── Accounts (P1) ────────────────────────────────────────────────
export interface AuthStatus {
  signedIn: boolean;
  email: string | null;
  name: string | null;
}

// ─── Cross-machine run history (Pro-real Part B / B1) ──────────────
// NOTE: this mirrors the Rust `SyncRun` blob, which is intentionally
// `snake_case` (it's a portable wire+storage format shared with the sync
// server, which keys on `run_id`/`machine_id`) — unlike the camelCase IPC
// types elsewhere. It is rendered as INERT TEXT only (never as HTML).
export interface SyncedRunStage {
  role: string;
  model: string | null;
  status: string;
  cost_usd: number;
}
export interface SyncedRunStageDetail {
  position: number;
  role: string;
  model: string | null;
  status: string;
  cost_usd: number;
  error: string | null;
  artifact: string | null;
  /** LiveEntry-shaped values + {kind:"reset"} markers, passed through verbatim.
   *  Rendered as INERT TEXT only; unknown kinds are skipped. */
  journal: unknown[];
  diff: string | null;
}
export interface SyncedRunDetail {
  run_id: string;
  stages: SyncedRunStageDetail[];
}
export interface SyncedRun {
  run_id: string;
  machine_id: string;
  machine_name: string | null;
  workspace_name: string | null;
  task: string;
  status: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  finished_at: string | null;
  stages: SyncedRunStage[];
}

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

  // ─── Missions ───────────────────────────────────────────────────
  listMissions: (projectId: string) => invoke<Mission[]>("list_missions", { projectId }),
  getMission: (missionId: string) => invoke<Mission | null>("get_mission", { missionId }),
  createMission: (
    projectId: string, intent: string, title: string,
    gitIsolation: string, execIsolation: string,
    workspaceId: string | null, linkedIssueKey: string | null,
  ) =>
    invoke<Mission>("create_mission", {
      projectId, intent, title, gitIsolation, execIsolation, workspaceId, linkedIssueKey,
    }),
  updateMission: (
    missionId: string, title: string | null, status: string | null, linkedIssueKey: string | null,
  ) => invoke<Mission>("update_mission", { missionId, title, status, linkedIssueKey }),
  archiveMission: (missionId: string) => invoke<void>("archive_mission", { missionId }),

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
    threadId: string;
    workspacePath: string;
    model: string;
    userMessage: string;
    system?: string;
    maxTokens: number;
    skill?: string;
    attachments?: { mediaType: string; data: string }[];
    /** Re-run without inserting a new user row (history already ends with it). */
    regenerate?: boolean;
  }) => invoke<void>("send_chat_message", { request }),
  listChatMessages: (threadId: string) => invoke<ChatMessage[]>("list_chat_messages", { threadId }),
  /** Delete a message and everything after it (Regenerate / Edit-and-resend). */
  truncateChatAfter: (threadId: string, messageId: number) =>
    invoke<void>("truncate_chat_after", { threadId, messageId }),
  /** Stop the in-flight agentic turn for this thread. */
  cancelChat: (threadId: string) => invoke<void>("cancel_chat", { threadId }),
  /** Resolve an inline approval for a dangerous agent command. */
  respondApproval: (callId: string, decision: "approve" | "always" | "deny") =>
    invoke<void>("respond_approval", { callId, decision }),
  /** Run a `$`-direct command in the thread's TALK shell (no LLM). Persists the
   *  command + output into the conversation; returns cwd/exit for the badge. */
  runShellCommand: (request: {
    workspaceId: string;
    threadId: string;
    workspacePath: string;
    command: string;
  }) =>
    invoke<{
      output: string;
      exitCode: number;
      ok: boolean;
      cwd: string;
      cwdLabel: string;
      live: boolean;
    }>("run_shell_command", { request }),
  /** SIGINT (Ctrl-C) a thread's live `$`-direct process. */
  stopShellCommand: (threadId: string) =>
    invoke<void>("stop_shell_command", { threadId }),
  /** Forward keystrokes to a thread's live process (interactive stdin). */
  sendShellInput: (threadId: string, data: string) =>
    invoke<void>("send_shell_input", { threadId, data }),
  /** Resize a thread's PTY so a full-screen TUI fits the live panel. */
  resizeShell: (threadId: string, rows: number, cols: number) =>
    invoke<void>("resize_shell", { threadId, rows, cols }),
  /** Most-recently-used `$`-direct commands for a workspace (recall palette). */
  listShellHistory: (workspaceId: string, limit?: number) =>
    invoke<string[]>("list_shell_history", { workspaceId, limit }),

  // ─── Chat threads (conversations) ────────────────────────────────
  listChatThreads: (workspaceId: string) =>
    invoke<ChatThread[]>("list_chat_threads", { workspaceId }),
  createChatThread: (workspaceId: string, title?: string) =>
    invoke<ChatThread>("create_chat_thread", { workspaceId, title }),
  renameChatThread: (threadId: string, title: string) =>
    invoke<void>("rename_chat_thread", { threadId, title }),
  setThreadPinned: (threadId: string, pinned: boolean) =>
    invoke<void>("set_thread_pinned", { threadId, pinned }),
  deleteChatThread: (threadId: string) =>
    invoke<void>("delete_chat_thread", { threadId }),

  // ─── Skills ──────────────────────────────────────────────────────
  listSkills: (workspacePath: string) =>
    invoke<SkillMeta[]>("list_skills", { workspacePath }),

  // ─── Attachments ─────────────────────────────────────────────────
  readAttachment: (path: string) => invoke<Attachment>("read_attachment", { path }),

  // ─── MCP ─────────────────────────────────────────────────────────
  listMcpTools: (workspacePath: string) =>
    invoke<McpToolInfo[]>("list_mcp_tools", { workspacePath }),
  listMcpServers: (workspacePath: string) =>
    invoke<string[]>("list_mcp_servers", { workspacePath }),
  getMcpConfig: () => invoke<Record<string, McpServerConfig>>("get_mcp_config"),
  saveMcpConfig: (servers: Record<string, McpServerConfig>) =>
    invoke<void>("save_mcp_config", { servers }),
  testMcpServer: (name: string, config: McpServerConfig) =>
    invoke<McpToolInfo[]>("test_mcp_server", { name, config }),

  // ─── Git ────────────────────────────────────────────────────────
  getGitStatus: (path: string) => invoke<GitStatus>("get_git_status", { path }),
  /** Local + remote-tracking branches. Locals come repo-default first, then
   *  alphabetical; remotes are fully qualified (`origin/dev`). */
  listBranches: (path: string) => invoke<BranchList>("list_branches", { path }),
  getGitDiff: (path: string, ignoreWhitespace?: boolean) =>
    invoke<string>("get_git_diff", { path, ignoreWhitespace }),

  // ─── File operations ───────────────────────────────────────────
  openFileInSystem: (path: string) => invoke<void>("open_file_in_system", { path }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),
  detectEditors: () => invoke<EditorChoice[]>("detect_editors"),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  readFileChecked: (path: string, maxBytes?: number) =>
    invoke<FileReadResult>("read_file_checked", { path, maxBytes }),
  writeFile: (path: string, content: string) =>
    invoke<{ mtime: number }>("write_file", { path, content }),
  fileMeta: (path: string) => invoke<FileMeta | null>("file_meta", { path }),

  // ─── Directory listing ─────────────────────────────────────────
  readDirectory: (path: string, showIgnored?: boolean) =>
    invoke<DirectoryEntry[]>("read_directory", { path, showIgnored }),

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

  applyHunk: (workspacePath: string, hunkText: string) =>
    invoke<void>("apply_hunk", { workspacePath, hunkText }),

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

  getStagedDiff: (path: string) => invoke<string>("get_staged_diff", { path }),
  amendCommit: (workspacePath: string, message: string) =>
    invoke<string>("amend_commit", { workspacePath, message }),
  getLastCommit: (workspacePath: string) =>
    invoke<LastCommit | null>("get_last_commit", { workspacePath }),
  /** Newest-first commit page from HEAD; `skip` offsets for pagination. */
  gitLog: (path: string, limit: number, skip: number) =>
    invoke<CommitInfo[]>("git_log", { path, limit, skip }),
  /** Unified diff of one commit vs its first parent (root: vs empty tree). */
  commitDiff: (path: string, sha: string) =>
    invoke<string>("commit_diff", { path, sha }),
  /** Per-line blame of a workdir-relative file against HEAD. */
  blameFile: (path: string, file: string) =>
    invoke<BlameLine[]>("blame_file", { path, file }),
  discardFile: (workspacePath: string, filePath: string) =>
    invoke<void>("discard_file", { workspacePath, filePath }),

  // ─── File operations (G6 slice II) ────────────────────────────
  /** Rename/move an entry. Both paths are containment-checked; `to` must not exist. */
  fsRename: (workspacePath: string, from: string, to: string) =>
    invoke<void>("fs_rename", { workspacePath, from, to }),
  /** Create an empty file `name` inside `parent` (relative to the workspace). */
  fsCreateFile: (workspacePath: string, parent: string, name: string) =>
    invoke<void>("fs_create_file", { workspacePath, parent, name }),
  /** Create a directory `name` inside `parent` (relative to the workspace). */
  fsCreateDir: (workspacePath: string, parent: string, name: string) =>
    invoke<void>("fs_create_dir", { workspacePath, parent, name }),
  /** Permanently delete a file or directory (recursive). Confirm in the UI first. */
  fsDelete: (workspacePath: string, target: string) =>
    invoke<void>("fs_delete", { workspacePath, target }),

  // ─── Conflict resolution ──────────────────────────────────────
  /** Take one side of a conflicted file wholesale (checkout --ours/--theirs + add). */
  resolveConflictTake: (workspacePath: string, file: string, side: "ours" | "theirs") =>
    invoke<void>("resolve_conflict_take", { workspacePath, file, side }),

  /** Mark a hand-merged conflicted file as resolved (git add). */
  markConflictResolved: (workspacePath: string, file: string) =>
    invoke<void>("mark_conflict_resolved", { workspacePath, file }),

  /** Continue the in-progress merge/rebase. moreConflicts = a later step conflicted. */
  continueOperation: (workspacePath: string) =>
    invoke<ContinueOutcome>("continue_operation", { workspacePath }),

  /** Abort the in-progress merge/rebase; returns the trimmed git output. */
  abortOperation: (workspacePath: string) =>
    invoke<string>("abort_operation", { workspacePath }),

  fetchChanges: (workspacePath: string) => invoke<string>("fetch_changes", { workspacePath }),

  pull: (workspacePath: string, strategy: "ffOnly" | "rebase" | "merge") =>
    invoke<PullOutcome>("pull", { workspacePath, strategy }),

  // ─── Branch & stash (G7 slice IV) ─────────────────────────────
  /** Switch to an existing local branch. Worktree-aware errors are friendly. */
  switchBranch: (workspacePath: string, name: string) =>
    invoke<string>("switch_branch", { workspacePath, name }),

  /** Create `name` off `base` and switch to it. */
  createAndSwitchBranch: (workspacePath: string, name: string, base: string) =>
    invoke<string>("create_and_switch_branch", { workspacePath, name, base }),

  /** Stash the working tree, untracked included. Empty message → git default. */
  stashPush: (workspacePath: string, message: string) =>
    invoke<void>("stash_push", { workspacePath, message }),

  /** The stash stack, most recent first. */
  stashList: (workspacePath: string) =>
    invoke<StashInfo[]>("stash_list", { workspacePath }),

  /** Apply + drop one stash entry (by stack index). */
  stashPop: (workspacePath: string, index: number) =>
    invoke<void>("stash_pop", { workspacePath, index }),

  /** Discard one stash entry without applying it. */
  stashDrop: (workspacePath: string, index: number) =>
    invoke<void>("stash_drop", { workspacePath, index }),

  // ─── Advanced git ops (G7 slice V) ────────────────────────────
  /** `git reset --<mode> <target>`; target defaults to HEAD. Confirm in the UI. */
  resetHead: (workspacePath: string, mode: "soft" | "mixed" | "hard", target?: string) =>
    invoke<string>("reset_head", { workspacePath, mode, target }),

  /** `git clean -fd` — returns the removed paths. Confirm in the UI first. */
  cleanUntracked: (workspacePath: string) =>
    invoke<string[]>("clean_untracked", { workspacePath }),

  /** Cherry-pick one commit onto HEAD. `conflict` is a tagged outcome —
   *  the conflict section takes over (continue/abort work for cherry-pick). */
  cherryPick: (workspacePath: string, sha: string) =>
    invoke<PullOutcome>("cherry_pick", { workspacePath, sha }),

  /** Create a lightweight tag at `sha` (HEAD when omitted). */
  createTag: (workspacePath: string, name: string, sha?: string) =>
    invoke<void>("create_tag", { workspacePath, name, sha }),

  /** All tag names, alphabetical. */
  listTags: (workspacePath: string) => invoke<string[]>("list_tags", { workspacePath }),

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

  /** Open pull requests for the project, for "start a workspace from a PR".
   *  Rejects with a friendly message when the GitHub CLI is missing or not
   *  authenticated — the UI maps any failure to a quiet empty state. */
  listPrs: (path: string) => invoke<PrInfo[]>("list_prs", { path }),
  /** Open GitHub issues for the project (the "Ship it" picker's source). */
  listGithubIssues: (path: string) => invoke<GhIssue[]>("list_github_issues", { path }),
  /** Preflight for "Ship it": github.com origin + authenticated gh. */
  githubShipReadiness: (path: string) =>
    invoke<ShipReadiness>("github_ship_readiness", { path }),

  /** Fetch a PR's head ref as a local branch (no-op if it already exists),
   *  so it can serve as the base of a new workspace. */
  ensurePrBranch: (path: string, number: number, headRefName: string) =>
    invoke<void>("ensure_pr_branch", { path, number, headRefName }),

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

  savePipeline: (draft: PipelineDraft) =>
    invoke<string>("save_pipeline", {
      pipelineId: draft.pipelineId,
      name: draft.name,
      description: draft.description,
      stages: draft.stages,
    }),

  deletePipeline: (pipelineId: string) =>
    invoke<void>("delete_pipeline", { pipelineId }),

  // ─── Routines (scheduled crews — Pro) ─────────────────────────────
  listRoutines: () => invoke<Routine[]>("list_routines"),
  createRoutine: (input: RoutineInput) => invoke<string>("create_routine", { input }),
  updateRoutine: (routineId: string, input: RoutineInput) =>
    invoke<void>("update_routine", { routineId, input }),
  deleteRoutine: (routineId: string) => invoke<void>("delete_routine", { routineId }),
  setRoutineEnabled: (routineId: string, enabled: boolean) =>
    invoke<void>("set_routine_enabled", { routineId, enabled }),
  runRoutineNow: (routineId: string) =>
    invoke<FireOutcomeView>("run_routine_now", { routineId }),

  createRun: (
    workspaceId: string,
    pipelineId: string,
    task: string,
    referenceModel?: string,
    linkedIssueKey?: string,
    stageOverrides?: [number, string][],
  ) =>
    invoke<string>("create_run", {
      workspaceId,
      pipelineId,
      task,
      referenceModel: referenceModel ?? null,
      linkedIssueKey: linkedIssueKey ?? null,
      stageOverrides: stageOverrides ?? null,
    }),

  startRun: (runId: string, budgetUsd?: number | null) =>
    invoke<void>("start_run", { runId, budgetUsd: budgetUsd ?? null }),

  getRun: (runId: string) =>
    invoke<RunDetail>("get_run", { runId }),

  listRuns: (workspaceId: string) =>
    invoke<Run[]>("list_runs", { workspaceId }),

  listActiveRuns: () => invoke<Run[]>("list_active_runs"),

  resolveCheckpoint: (
    runId: string,
    action: CheckpointActionName,
    feedback?: string,
    modelOverride?: string,
    maxTurnsOverride?: number,
  ) =>
    invoke<void>("resolve_checkpoint", {
      runId,
      action,
      feedback: feedback ?? null,
      modelOverride: modelOverride ?? null,
      maxTurnsOverride: maxTurnsOverride ?? null,
    }),

  /** Answer a stage that parked itself via the `ask_director` escape valve.
   *  `answers` is positional — one per question the stage asked; a missing or
   *  empty entry falls back to that question's recommended default. The
   *  decisions become the stage's re-run feedback and the stage re-runs. */
  answerBlocker: (runId: string, stageId: string, answers: string[]) =>
    invoke<void>("answer_blocker", { runId, stageId, answers }),

  abortRun: (runId: string) =>
    invoke<void>("abort_run", { runId }),

  /** Stop the run's in-flight stage (real cancellation). The stage lands in
   *  the normal failed/decision-strip recovery flow; the run itself survives. */
  stopStage: (runId: string) =>
    invoke<void>("stop_stage", { runId }),

  /** Ask a running run to pause at its next stage boundary; the next stage is
   *  parked awaiting the director, and approving it resumes the run. */
  requestRunPause: (runId: string) =>
    invoke<void>("request_run_pause", { runId }),

  /** Hot-edit a pending, not-yet-started run stage. Any field left
   *  `undefined` in `patch` is unchanged. `instructions: null` clears the
   *  field (distinct from leaving it `undefined`, which leaves it as-is). */
  updateRunStage: (runId: string, stageId: string, patch: RunStagePatch) =>
    invoke<void>("update_run_stage", { runId, stageId, ...stagePatchArgs(patch) }),

  /** Re-run a finished (done/failed) stage and everything downstream of it,
   *  in place — no restart, no reload. Rejects if the stage hasn't finished
   *  or the run is currently driving. An optional `patch` rides along — the
   *  director's "re-run after changes": validated before anything resets,
   *  applied before the drive resumes. */
  rerunFromStage: (runId: string, stageId: string, patch?: RunStagePatch) =>
    invoke<void>("rerun_from_stage", { runId, stageId, ...stagePatchArgs(patch) }),

  /** The persisted live journal for a stage, oldest first. Entries are
   *  LiveEntry-shaped JSON plus `{kind:"reset"}` marker objects that split
   *  the log into per-attempt segments. */
  getStageLog: (stageId: string) =>
    invoke<unknown[]>("get_stage_log", { stageId }),

  /** Archived attempts for a stage, oldest first (iteration ascending). */
  listStageIterations: (stageId: string) =>
    invoke<StageIteration[]>("list_stage_iterations", { stageId }),

  estimateRunCost: (pipelineId: string, stageOverrides?: [number, string][]) =>
    invoke<{ estimateUsd: number; baselineUsd: number }>("estimate_run_cost", {
      pipelineId,
      stageOverrides: stageOverrides ?? null,
    }),

  // ─── Entitlement (premium scaffolding) ────────────────────────
  getEntitlement: () => invoke<Entitlement>("get_entitlement"),
  directRunUsage: () => invoke<DirectRunUsage>("direct_run_usage"),
  /** Durable "has ever started a Direct run" — the first-run invite signal. */
  hasEverStartedRun: () => invoke<boolean>("has_ever_started_run"),

  // ─── Cross-machine run history (Pro-real Part B / B1) ──────────
  /** The local read-only history mirror (instant, no network). */
  historyList: () => invoke<SyncedRun[]>("history_list"),
  /** Pull the user's run history from the cloud, replace the mirror, return it.
   *  Pro-gated (throws `UpgradeRequired` for Free). */
  historySyncPull: () => invoke<SyncedRun[]>("history_sync_pull"),
  /** One synced run's full story (journals · artifacts · diffs), fetched on
   *  demand (B2). Null when the server has no detail for that run. Pro-gated. */
  historyRunDetail: (runId: string) =>
    invoke<SyncedRunDetail | null>("history_run_detail", { runId }),

  // ─── Library sync (Pro): custom pipelines + roles follow the user ──
  /** Push the whole custom library (launch heal; idempotent LWW upserts). */
  librarySyncPushAll: () => invoke<number>("library_sync_push_all"),
  /** Pull + merge the library per-item LWW (roles first). Pro-gated. */
  librarySyncPull: () => invoke<number>("library_sync_pull"),
  /** One-shot backfill of this machine's terminal runs to the cloud (Pro-only,
   *  no-op otherwise). Returns the count attempted. */
  historySyncPushAll: () => invoke<number>("history_sync_push_all"),

  // ─── Accounts (P1) ────────────────────────────────────────────
  authStatus: () => invoke<AuthStatus>("auth_status"),
  authBeginSignIn: () => invoke<AuthStatus>("auth_begin_sign_in"),
  authCancelSignIn: () => invoke<void>("auth_cancel_sign_in"),
  authRefresh: () => invoke<AuthStatus>("auth_refresh"),
  authSyncPlan: () => invoke<string | null>("auth_sync_plan"),
  authSignOut: () => invoke<void>("auth_sign_out"),
  authAccountPortalUrl: () => invoke<string>("auth_account_portal_url"),
  billingCheckoutUrl: () => invoke<string>("billing_checkout_url"),

  // ─── Roles ────────────────────────────────────────────────────
  listRoles: () => invoke<Role[]>("list_roles"),

  saveRole: (role: Role) => invoke<Role>("save_role", { role }),

  deleteRole: (key: string) => invoke<void>("delete_role", { key }),

  // ─── AI primitive (G5) ────────────────────────────────────────
  aiComplete: (
    model: string,
    system: string,
    prompt: string,
    opts?: {
      maxTokens?: number;
      /** Attributes the spend to this workspace in Usage dashboards. */
      workspaceId?: string;
      /** Forces a schema'd tool call — the returned `text` is then
       *  guaranteed-shape JSON matching this schema. */
      jsonSchema?: unknown;
    },
  ) =>
    invoke<{ text: string; inputTokens: number; outputTokens: number; costUsd: number }>(
      "ai_complete",
      {
        model,
        system,
        prompt,
        maxTokens: opts?.maxTokens ?? null,
        workspaceId: opts?.workspaceId ?? null,
        jsonSchema: opts?.jsonSchema ?? null,
      },
    ),

  // ─── MCP server (Connect to Claude Code) ──────────────────────────
  mcpConnectionStatus: () =>
    invoke<McpStatus>("mcp_connection_status"),
  connectClaudeCode: () =>
    invoke<McpConnectResult>("connect_claude_code"),
};

/** A DIRECT-mode role definition (mirrors Rust `RoleDef`). */
export interface Role {
  key: string;
  label: string;
  description: string;
  promptBody: string;
  artifactKind: "plan" | "review" | "tests" | "diff" | "note";
  environment: "worktree" | "action";
  canLoop: boolean;
  defaultTools: string[];
  defaultSubstrate: "api" | "cli";
  defaultCheckpoint: boolean;
  tokenEstIn: number;
  tokenEstOut: number;
  isBuiltin: boolean;
}

/** State of the bundled octopush-mcp server + its Claude Code registration. */
export interface McpStatus {
  binaryPath: string | null;
  binaryFound: boolean;
  claudeFound: boolean;
  registered: boolean;
  manualCommand: string;
}

/** Result of a one-click "Connect to Claude Code". */
export interface McpConnectResult {
  ok: boolean;
  registered: boolean;
  message: string;
  manualCommand: string;
  binaryPath: string | null;
}

/** Tauri event names emitted by the orchestrator. */
export const RUN_EVENTS = {
  stageUpdate: "run://stage-update",
  cost: "run://cost",
  checkpoint: "run://checkpoint",
  error: "run://error",
  /** Live per-stage activity, streamed by both substrates. Payload:
   *  `{ runId, stageId, entry: LiveEntry }` or `{ runId, stageId, reset: true }`. */
  log: "run://log",
} as const;
