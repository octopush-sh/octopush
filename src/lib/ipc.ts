// Thin typed wrappers around Tauri's `invoke` for the Octopush core.
import type { SecretHold, SecretPreview } from "./secretGuard";
import type { RewindOutcome, RewindPreview, TalkCheckpoints } from "./talkRewind";

// ─── Updater — types ───────────────────────────────────────────────────────

export type UpdateChannel = "stable" | "beta";

/** An available update, as `updater_check` reports it. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Manifest `pub_date` (RFC 3339), when present. */
  date: string | null;
  /** Manifest `notes` (Markdown), when present. */
  body: string | null;
  channel: UpdateChannel;
}

export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

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
  /** Per-stage reasoning effort; null/absent = off (no thinking) on the API,
   *  the CLI's own default (Claude Code or Codex) on a CLI stage. */
  effort?: Effort | null;
  /** Escalation policy — the stronger model to retry with if this stage fails.
   *  null/absent = no model swap on the retry. Either escalate field set = the
   *  stage has an escalation policy. */
  escalateModel?: string | null;
  /** Escalation policy — the effort to bump to on the failed-retry (API, or a
   *  CLI stage as Claude Code's `--effort` or Codex's `model_reasoning_effort`). null/absent =
   *  keep the base effort on the retry. */
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
  scheduleKind: "interval" | "daily" | "recurring";
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
  scheduleKind: "interval" | "daily" | "recurring";
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
  /** The skip's machine token (`SkipReason::token`), present only for a skip. */
  skip?:
    | "busy"
    | "condition_not_met"
    | "condition_error"
    | "workspace_unavailable"
    | "launch_refused"
    | "setup_failed"
    | "plan_limit";
}

/** The phase a routine fire is in (`routine://phase`, `routines::PHASE_*`). */
export type RoutinePhase = "condition" | "workspace" | "setup" | "launching";

export interface RoutinePhaseEvent {
  routineId: string;
  phase: RoutinePhase;
}
/** A builder-authored stage (position = array index, after topological sort). */
export interface StageDraft {
  role: string;
  agentModel: string;
  /** Per-stage reasoning effort; null/absent = off (no thinking) on the API,
   *  the CLI's own default (Claude Code or Codex) on a CLI stage. */
  effort?: Effort | null;
  /** Escalation policy — the stronger model to retry with if this stage fails.
   *  null/absent = no model swap on the retry. */
  escalateModel?: string | null;
  /** Escalation policy — the effort to bump to on the failed-retry (API, or a
   *  CLI stage as Claude Code's `--effort` or Codex's `model_reasoning_effort`). */
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
/** One stage of a crew import's review sheet (mirrors Rust `crew::CrewStagePreview`). */
export interface CrewStagePreview {
  position: number;
  label: string;
  /** The role key it will use (after any rename). */
  role: string;
  agentModel: string;
  escalateModel: string | null;
  substrate: AgentSubstrate;
  /** The CLI a `cli` stage runs (by the model id); null on API. A CLI stage
   *  gets a full shell: its tool list does not apply. */
  cliDialect: "claude" | "codex" | null;
  checkpoint: boolean;
  /** False = the stage can change the worktree. */
  readOnly: boolean;
  /** The role may commit, push and run release commands. */
  actionRole: boolean;
  /** The tools an API stage gets; empty for a CLI stage. */
  tools: string[];
  instructions: string | null;
  effort: Effort | null;
  escalateEffort: Effort | null;
  /** The earlier stage (0-based position) a review loops back to. */
  loopTargetPosition: number | null;
  loopMode: string | null;
  loopMaxIterations: number;
  unpricedModel: boolean;
  unpricedEscalate: boolean;
  /** Worth reading, not blocking (a tool list on a CLI stage). */
  warnings: string[];
  problem: string | null;
}
export interface CrewRolePreview {
  key: string;
  originalKey: string;
  label: string;
  promptBody: string;
  /** new · renamed (its key was taken here) · existing (identical role reused) */
  fate: "new" | "renamed" | "existing";
}
export interface CrewPreview {
  name: string;
  description: string;
  stages: CrewStagePreview[];
  roles: CrewRolePreview[];
  /** Problems not tied to one stage. */
  problems: string[];
  ok: boolean;
}
/** A crew file committed in the repo (`.octopush/crews/*.octocrew.json`):
 *  names and counts only; `readRepoCrew` reads its text on Fork. */
export interface RepoCrew {
  file: string;
  name: string;
  description: string;
  stageCount: number;
  problem: string | null;
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
  /** Set while a Claude plan limit parks the run (#731). Mirrors the Rust
   *  `PlanWait`; times are epoch seconds. */
  planWait?: PlanWait | null;
}

/** A run parked at a Claude plan limit. */
export interface PlanWait {
  /** The plan window that stopped the stage (`five_hour`, `seven_day`, …). */
  window: string;
  /** When that window resets (epoch seconds). */
  resetsAt: number;
  /** When the automatic resume is due (epoch seconds); null = the director resumes. */
  resumeAt: number | null;
  /** Automatic resumes since the director last acted or a stage finished. */
  resumeCount: number;
  /** Another stage also waits for the director (a real halt, a gate, a
   *  question): the run needs you even with a resume scheduled. */
  otherHold: boolean;
  /** Reports in a row whose reset was already past (#1109): 1 resumes once,
   *  uncounted; more waits for the director. Absent from older builds. */
  staleCount?: number;
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

/** The surface an `ask_director` answer came from, named in the run journal
 *  ("…accepted the recommended defaults (from Mission Control)"). */
export type AnswerSource = "mission_control";

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
  /** True when the stage's model has no price (set by `get_run`): its spend
   *  reads "unpriced", is invisible to the run budget and never counts as
   *  saved. */
  unpricedModel?: boolean;
  /** True when an attempt of this stage stopped before its CLI reported
   *  usage (a Codex stage stopped before `turn.completed`; set by `get_run`):
   *  its cost reads "usage not reported", never $0.00, and like an unpriced
   *  stage it is invisible to the run budget. */
  usageUnreported?: boolean;
  /** The model the stage's last attempt actually ran on, when Claude Code's
   *  `system/init` named another than `agentModel` (set by `get_run`; #791).
   *  null/absent = it ran on the model it asked for. */
  ranModel?: string | null;
  /** How many tool calls Claude Code refused in the stage's last attempt
   *  (its result event's `permission_denials`; set by `get_run`; #893).
   *  0/absent = none. Each is in the stage's journal as "refused · …". */
  refusedCalls?: number;
  /** The context size of the stage's latest top-level assistant message —
   *  input + cache read + cache write, Talk's `contextTokens` (set by
   *  `get_run` and `run://context`; #895). Claude CLI stages only; null/absent
   *  before the first message and for Codex/API stages. A finished stage
   *  keeps its final value; a restart clears it. */
  contextTokens?: number | null;
  /** The context window of the model that answered that message, from the
   *  provider catalog; null/absent when the catalog doesn't list it (the
   *  meter is then hidden, never drawn against a guess). */
  contextWindow?: number | null;
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
  /** Secret guard (#730): set when an Action stage (commit / push / PR /
   *  merge / release) was held because the worktree holds a possible secret.
   *  `acknowledged` once the director approved proceeding past exactly these
   *  findings. Findings carry file, line and kind only — never the value. */
  secretHold?: SecretHold | null;
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
/** `drop_call`: resume a stage whose deferred tool is gone, dropping that call
 *  (Claude gets an error as its result and carries on). */
export type CheckpointActionName = "approve" | "reject" | "edit" | "abort" | "send_back" | "resume" | "drop_call" | "discard";

/** What a checkpoint decision carries besides its stage and action. */
export interface CheckpointOptions {
  feedback?: string;
  modelOverride?: string;
  maxTurnsOverride?: number;
}

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

/** Hierarchy tags a Claude Code (CLI-substrate) journal carries: an entry
 *  produced inside a native sub-agent names its spawner (`parent` = the
 *  `Agent`/`Task` tool_use id); the spawning tool entry carries `agentId`. */
export interface LiveEntryHierarchy {
  parent?: string;
  agentId?: string;
}

/** One live-activity entry streamed on `run://log` (see RUN_EVENTS.log). */
export type LiveEntry = LiveEntryHierarchy &
  (
    | { kind: "text"; text: string }
    | { kind: "tool"; tool: string; hint: string }
    | { kind: "tool_result"; ok: boolean; detail: string }
    | { kind: "notice"; text: string }
  );

export type FileReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number; mtime: number }
  | { kind: "unsupportedEncoding"; size: number; mtime: number }
  | { kind: "tooLarge"; size: number };

/** `read_file_lines` (#1046): the lines kept (`start > end` when the file
 *  ends before `start`), the file's line count once the read reached its end. */
export type LineRangeResult =
  | { kind: "text"; content: string; start: number; end: number; total: number | null; cut: boolean }
  | { kind: "binary" }
  | { kind: "unsupportedEncoding" };

/** Cheap stat for external-change detection. `null` = file no longer exists. */
export interface FileMeta {
  mtimeMs: number;
  size: number;
}

/** A workspace whose worktree contains a given file (Open With routing). */
export interface WorkspaceMatch {
  projectId: string;
  projectPath: string;
  workspaceId: string;
  workspaceName: string;
  root: string;
}

/** Payload of `octo://open-in-workspace` (Quick View → main window). */
export interface OpenInWorkspacePayload {
  projectId: string;
  projectPath: string;
  workspaceId: string;
  /** Relative to the workspace root, `/`-separated. */
  relativePath: string;
}

/** Payload of `octo://open-run`: a crew chosen in the menu bar Octo's menu
 *  (#718). Rust has already shown the window. */
export interface OpenRunPayload {
  runId: string;
  workspaceId: string;
  projectId: string;
  projectPath: string;
}

/** Payload of `octo://open-talk`: a Talk conversation whose approval card
 *  waits, chosen in the menu bar Octo's menu. Rust has already shown the window. */
export interface OpenTalkPayload {
  threadId: string;
  workspaceId: string;
  projectId: string;
  projectPath: string;
}

export type PullKind = "ok" | "diverged" | "conflict" | "error";
export interface PullOutcome { kind: PullKind; output: string }

export type ContinueKind = "ok" | "moreConflicts" | "error";
export interface ContinueOutcome { kind: ContinueKind; output: string }

export interface LastCommit { shortSha: string; subject: string; body: string }

/** `git_ops::CommittedDiff`: what a workspace committed since its base —
 *  the merge base → HEAD tree diff Review shows as "Since base" (#851). */
export interface CommittedDiff {
  base: string | null;
  /** Short SHA of the merge base, when one resolved. */
  mergeBase: string | null;
  /** Short SHA of HEAD, when there is one: an amend that keeps the count and
   *  merge base still moves it. */
  head: string | null;
  /** Commits on HEAD since the merge base. */
  commits: number;
  /** Unified diff; "" when there are no commits ahead. */
  diff: string;
}

/** `git_ops::DiffSize`: files and lines from the merge base with `base` to
 *  the working tree (commits, edits and untracked files). `base` is null when
 *  the workspace has none that resolves: the size is then the uncommitted
 *  changes against HEAD. */
export interface DiffSize {
  files: number;
  added: number;
  removed: number;
  base: string | null;
  /** Untracked entries counted as files but not line-counted (a large
   *  untracked directory, or past the read budget). */
  untrackedSkipped: number;
}

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

import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import type {
  AdapterInfo,
  AppSettings,
  NotifyElsewhere,
  NotifyElsewherePreview,
  SyncPrefs,
  SyncKind,
  SyncStatus,
  Budget,
  BudgetPeriod,
  BudgetScope,
  BudgetStatus,
  BranchList,
  BranchPr,
  MergedArchive,
  MergedWorkspace,
  EditorChoice,
  ChatMessage,
  ChatThread,
  SkillMeta,
  Attachment,
  McpToolInfo,
  McpServerConfig,
  McpServerStatus,
  CreateSessionArgs,
  DirectoryEntry,
  FileEdit,
  GitStatus,
  Issue,
  IssueTrackerConfig,
  Mission,
  UpdatedMission,
  LogbookMissionRow,
  ModelSuggestion,
  ModelWithProvider,
  GhIssue,
  Group,
  GroupScope,
  Pr,
  PrInfo,
  ShipReadiness,
  PrDraftContext,
  PerfStats,
  ProjectInfo,
  ProviderConfig,
  PtySession,
  RefreshPricingResult,
  ThreadCost,
  SessionUsage,
  RequestContext,
  PtySettledEvent,
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
  UsageReport,
  GatewayReconciliation,
  Workspace,
  CreatedWorkspace,
  ShareOptions,
  ShareSpec,
  WorkspaceCacheSizes,
  WorkspaceGitSummary,
  ProjectCollisions,
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
  /** Only on the summary stage that stands in for stages cut to fit the sync
   *  size limit: one of them was unpriced on the Mac that ran it (#978).
   *  Absent (false) on every other stage and on older payloads. */
  includes_unpriced?: boolean;
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
  /** `null` when the user has never chosen a theme — themeStore then seeds
   *  from `prefers-color-scheme` and keeps following the OS. */
  getTheme: () => invoke<ThemeConfig | null>("get_theme"),
  setTheme: (theme: ThemeConfig) => invoke<void>("set_theme", { theme }),
  listThemes: () => invoke<ThemeConfig[]>("list_themes"),

  // ─── Projects ───────────────────────────────────────────────────
  openProject: (path: string) => invoke<ProjectInfo>("open_project", { path }),
  listRecentProjects: () => invoke<ProjectInfo[]>("list_recent_projects"),
  createProject: (path: string, name: string, task?: string | null) =>
    invoke<ProjectInfo>("create_project", { path, name, task: task ?? null }),
  ensureSketchbook: () => invoke<ProjectInfo>("ensure_sketchbook"),
  /** The canonical Sketchbook path (read-only; does NOT provision it). Compared
   *  exactly against a project's path to detect the Sketchbook. */
  sketchbookPath: () => invoke<string>("sketchbook_path"),
  /** Post-build rename (G6): ATOMICALLY claim the one-shot rename for a
   *  workspace's project. Returns the prompt once (then marks it offered), else
   *  null (not a genesis project / already offered / unknown workspace). */
  claimGenesisRename: (workspaceId: string) =>
    invoke<{ projectId: string; prompt: string } | null>("claim_genesis_rename", { workspaceId }),
  cloneProject: (args: {
    path: string;
    url: string;
    nameOverride?: string;
    credentials?: { username: string; token: string; remember: boolean };
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

  // ─── Rail groups ────────────────────────────────────────────────
  /** Every group, both scopes: project groups, then each project's workspace
   *  groups, each run in `sortOrder`. */
  listGroups: () => invoke<Group[]>("list_groups"),
  /** Create a group and move `memberIds` into it in one step. It takes the
   *  place of its first member in rail order, or goes last when it has none.
   *  `projectId` is required for a `workspace` group and refused for a
   *  `project` group. */
  createGroup: (args: {
    scope: GroupScope;
    projectId?: string | null;
    name: string;
    tint?: TintName | null;
    memberIds?: string[];
  }) =>
    invoke<Group>("create_group", {
      scope: args.scope,
      projectId: args.projectId ?? null,
      name: args.name,
      tint: args.tint ?? null,
      memberIds: args.memberIds ?? [],
    }),
  /** The backend trims the name and refuses an empty one. */
  renameGroup: (groupId: string, name: string) =>
    invoke<void>("rename_group", { groupId, name }),
  setGroupTint: (groupId: string, tint: TintName | null) =>
    invoke<void>("set_group_tint", { groupId, tint }),
  /** Persist the order of sibling groups (same scope, same project): each id
   *  gets its index as `sortOrder`, like `setProjectOrder`. */
  setGroupOrder: (ids: string[]) => invoke<void>("set_group_order", { ids }),
  /** Delete a group. Its members stay, ungrouped. */
  deleteGroup: (groupId: string) => invoke<void>("delete_group", { groupId }),
  /** Move a project or workspace into a group, or out of any group (`null`).
   *  Refused for a group of the other scope, and for a workspace group of
   *  another project. */
  setItemGroup: (kind: GroupScope, itemId: string, groupId: string | null) =>
    invoke<void>("set_item_group", { kind, itemId, groupId }),
  /** Move several items of one kind the same way, in one transaction: one
   *  refusal leaves them all where they were. */
  setItemsGroup: (kind: GroupScope, itemIds: string[], groupId: string | null) =>
    invoke<void>("set_items_group", { kind, itemIds, groupId }),

  // ─── Workspaces ─────────────────────────────────────────────────
  createWorkspace: (projectId: string, projectPath: string, name: string, task: string,
                    branch: string, fromBranch: string, setupScript: string,
                    intent: string | null, gitIsolation: string | null,
                    execIsolation: string | null) =>
    invoke<CreatedWorkspace>("create_workspace", { projectId, projectPath, name, task, branch, fromBranch, setupScript, intent, gitIsolation, execIsolation }),
  /** Remember the project's setup-script template (read by Routines). */
  setProjectSetupScript: (projectId: string, script: string) =>
    invoke<void>("set_project_setup_script", { projectId, script }),
  /** The setup script the repo declares in `.conductor/settings.toml` (with
   *  `settings.local.toml` on top), or null — also null once the project has a
   *  saved setup template. The backend reads the project's own path from the
   *  DB. Reading it never runs it. */
  conductorSetupScript: (projectId: string) =>
    invoke<string | null>("conductor_setup_script", { projectId }),
  /** The project's "Share with new missions" list, and what its main checkout
   *  could share. The backend reads the project's own path from the DB. */
  shareWithMissions: (projectId: string) =>
    invoke<ShareOptions>("share_with_missions", { projectId }),
  /** Remember what the project shares with new missions (sanitized server-side). */
  setShareWithMissions: (projectId: string, spec: ShareSpec) =>
    invoke<void>("set_share_with_missions", { projectId, spec }),
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
    execIsolation: string | null = null,
  ) => invoke<UpdatedMission>("update_mission", { missionId, title, status, linkedIssueKey, execIsolation }),
  archiveMission: (missionId: string) => invoke<void>("archive_mission", { missionId }),

  // ─── Logbook ────────────────────────────────────────────────────
  /** Per-mission scope is free; project/global (the Logbook Room) is Pro. */
  logbookSummary: (scopeType: string, scopeId: string | null, from: string, to: string) =>
    invoke<LogbookMissionRow[]>("logbook_summary", { scopeType, scopeId, from, to }),

  workspacesGitSummary: (projectId: string) =>
    invoke<WorkspaceGitSummary[]>("workspaces_git_summary", { projectId }),
  /** Collision radar (#732): live workspaces of a project changing the same
   *  files. Read-only; the backend reuses a report for a few seconds unless
   *  `force` (or a workspace's HEAD moved). */
  projectCollisions: (projectId: string, force = false) =>
    invoke<ProjectCollisions>("project_collisions", { projectId, force }),
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
    attachments?: { mediaType: string; data: string }[];
    /** Re-run without inserting a new user row (history already ends with it). */
    regenerate?: boolean;
    /** Skip the backend budget gate for this turn (conscious per-turn override). */
    overrideBudget?: boolean;
    /** Where the `@` context blocks sit in `userMessage` (`SentContextBlock[]` as JSON). */
    contextBlocks?: string;
  }) => invoke<void>("send_chat_message", { request }),
  listChatMessages: (threadId: string) => invoke<ChatMessage[]>("list_chat_messages", { threadId }),
  /** What the thread has cost so far, from the ledger (Companion). */
  getThreadCost: (threadId: string) => invoke<ThreadCost>("get_thread_cost", { threadId }),
  /** What the Claude Code session in a Run terminal has used (context size,
   *  spend, cache share, model). Null for a terminal with no known Claude
   *  Code session or no ledger row yet. Read-only. */
  getSessionUsage: (terminalId: string) =>
    invoke<SessionUsage | null>("get_session_usage", { terminalId }),
  /** What every request of a project carries: the measured fixed context,
   *  its price at the project's usual model and cache rate, and the files
   *  that make it up as ranked estimates. Read-only. */
  getRequestContext: (projectId: string) =>
    invoke<RequestContext>("get_request_context", { projectId }),
  /** Give a finished sub-agent more turns, optionally with a message from the
   *  user. Resolves when the continuation ends; the report row is rewritten
   *  via `chat://message-updated`. */
  /** `extraTurns` null = no turn limit on the continuation. */
  continueSubagent: (callId: string, instruction: string | null, extraTurns: number | null) =>
    invoke<void>("continue_subagent", { callId, instruction, extraTurns }),
  /** Delete a message and everything after it (Regenerate / Edit-and-resend). */
  truncateChatAfter: (threadId: string, messageId: number) =>
    invoke<void>("truncate_chat_after", { threadId, messageId }),
  /** Stop the in-flight agentic turn for this thread. */
  cancelChat: (threadId: string) => invoke<void>("cancel_chat", { threadId }),
  /** The workspace's conversations with a director turn running now. */
  listRunningThreads: (workspaceId: string) => invoke<string[]>("list_running_threads", { workspaceId }),
  /** Answer a turn-limit card: extra turns for the paused writing sub-agent,
   *  or null to accept its partial report. */
  respondSubagentCap: (callId: string, extraTurns: number | null) =>
    invoke<void>("respond_subagent_cap", { callId, extraTurns }),
  /** Turn-limit cards still waiting on a thread (rehydrate after a reload). */
  pendingSubagentCaps: (threadId: string) =>
    invoke<Array<{ workspaceId: string; threadId: string; callId: string; description: string; subagentType: string | null; turnsUsed: number }>>(
      "pending_subagent_caps",
      { threadId },
    ),
  /** The approval cards still waiting on a thread, oldest first (a reloaded
   *  webview shows them again: a card waits until it is answered). */
  pendingApprovals: (threadId: string) =>
    invoke<Array<{ workspaceId: string; threadId: string; callId: string; command: string; reason: string; secret?: boolean; coversUncommitted?: boolean }>>(
      "pending_approvals",
      { threadId },
    ),
  /** Resolve an inline approval for a dangerous agent command. */
  respondApproval: (callId: string, decision: "approve" | "always" | "deny") =>
    invoke<void>("respond_approval", { callId, decision }),
  /** Run a `$`-direct command in the thread's TALK shell (no LLM). Persists the
   *  command + output into the conversation; returns cwd/exit for the badge.
   *  Secret guard (#819): a command that commits, pushes or opens a PR
   *  rejects with `SecretsFound` (see `lib/secretGuard`) before it runs;
   *  `allowFindings` echoes the confirm's fingerprint for this one run. */
  runShellCommand: (request: {
    workspaceId: string;
    threadId: string;
    workspacePath: string;
    command: string;
    allowFindings?: string;
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

  // ─── Talk checkpoints: rewind files, fork from a turn (#958) ──────
  // The backend resolves the thread's worktree itself; no path is passed.
  /** The turns of a thread that can be rewound, the ones without a checkpoint, and whether an undo is on offer. */
  listTalkCheckpoints: (threadId: string) =>
    invoke<TalkCheckpoints>("list_talk_checkpoints", { threadId }),
  /** What rewinding to a turn would change (nothing is written). */
  previewTalkRewind: (threadId: string, messageId: number) =>
    invoke<RewindPreview>("preview_talk_rewind", { threadId, messageId }),
  /** Rewind to a turn; `expected` is the confirmed preview's `current`. */
  rewindTalkFiles: (threadId: string, messageId: number, expected: string) =>
    invoke<RewindOutcome>("rewind_talk_files", { threadId, messageId, expected }),
  undoTalkRewind: (threadId: string) =>
    invoke<RewindOutcome>("undo_talk_rewind", { threadId }),
  /** A new thread with the history before a user turn; the turn becomes its draft. */
  forkChatThread: (threadId: string, messageId: number) =>
    invoke<{ thread: ChatThread; draft: string }>("fork_chat_thread", { threadId, messageId }),

  // ─── Skills ──────────────────────────────────────────────────────
  listSkills: (workspacePath: string) =>
    invoke<SkillMeta[]>("list_skills", { workspacePath }),
  /** The workspace's `.claude/agents/*.md` definitions — the `subagent_type`s
   *  Talk's `Agent` tool can run under (project ∪ user, project shadows). */
  listSubagentTypes: (workspacePath: string) =>
    invoke<SubagentTypeMeta[]>("list_subagent_types", { workspacePath }),

  // ─── Attachments ─────────────────────────────────────────────────
  readAttachment: (path: string) => invoke<Attachment>("read_attachment", { path }),

  // ─── MCP ─────────────────────────────────────────────────────────
  listMcpTools: (workspacePath: string) =>
    invoke<McpToolInfo[]>("list_mcp_tools", { workspacePath }),
  /** Every server configured for the worktree (user ∪ project config) with
   *  Talk's live status for it. Spawns nothing. */
  listMcpServerStatus: (workspacePath: string) =>
    invoke<McpServerStatus[]>("list_mcp_server_status", { workspacePath }),
  /** The MCP servers switched off in one Talk conversation (none by default). */
  getThreadMcpDisabled: (threadId: string) => invoke<string[]>("get_thread_mcp_disabled", { threadId }),
  /** Turn one server off (or back on) in a conversation; resolves to its new
   *  off list. The backend reads and writes the list under one lock. */
  setThreadMcpServer: (threadId: string, server: string, off: boolean) =>
    invoke<string[]>("set_thread_mcp_server", { threadId, server, off }),
  /** Settings saved the MCP config, Reconnect restarted a server, or Talk's
   *  discovery started (or failed to start) servers. If either subscription
   *  fails, the other is dropped and the promise rejects. */
  onMcpChanged: async (handler: () => void) => {
    const subs = await Promise.allSettled([
      listen("mcp://config-changed", () => handler()),
      listen("mcp://status-changed", () => handler()),
    ]);
    const offs = subs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = subs.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      offs.forEach((off) => off());
      throw failed.reason;
    }
    return () => offs.forEach((off) => off());
  },
  getMcpConfig: () => invoke<Record<string, McpServerConfig>>("get_mcp_config"),
  /** Save the user-level servers; returns them as saved (remote bridges
   *  rebuilt, no secret value). `secrets` (server → env name → typed value)
   *  go to the login Keychain, never to mcp.json; `renamed` (new name → old)
   *  moves a renamed server's Keychain items and carries the rename over to
   *  the conversations that had the old name switched off. */
  saveMcpConfig: (
    servers: Record<string, McpServerConfig>,
    secrets: Record<string, Record<string, string>> = {},
    renamed: Record<string, string> = {},
  ) => invoke<Record<string, McpServerConfig>>("save_mcp_config", { servers, secrets, renamed }),
  testMcpServer: (name: string, config: McpServerConfig) =>
    invoke<McpToolInfo[]>("test_mcp_server", { name, config }),
  /** Stop Talk's cached connection to the server, then run the same smoke test as Test. */
  reconnectMcpServer: (name: string, config: McpServerConfig) =>
    invoke<McpToolInfo[]>("reconnect_mcp_server", { name, config }),
  /** Delete mcp-remote's saved browser sign-in for a remote server and stop
   *  Talk's connection to it; returns how many files went. */
  clearMcpSignIn: (name: string, config: McpServerConfig) =>
    invoke<number>("clear_mcp_sign_in", { name, config }),

  // ─── Git ────────────────────────────────────────────────────────
  getGitStatus: (path: string) => invoke<GitStatus>("get_git_status", { path }),
  /** Local + remote-tracking branches. Locals come repo-default first, then
   *  alphabetical; remotes are fully qualified (`origin/dev`). */
  listBranches: (path: string) => invoke<BranchList>("list_branches", { path }),
  getGitDiff: (path: string, ignoreWhitespace?: boolean) =>
    invoke<string>("get_git_diff", { path, ignoreWhitespace }),
  /** The workspace's diff size against its base (Mission Control cards);
   *  null when the workspace or its worktree is gone. */
  workspaceDiffSize: (workspaceId: string) =>
    invoke<DiffSize | null>("workspace_diff_size", { workspaceId }),
  /** What the workspace committed since its base (Review's "Since base");
   *  null when the worktree is gone or git timed out. */
  getCommittedDiff: (workspaceId: string, ignoreWhitespace?: boolean) =>
    invoke<CommittedDiff | null>("get_committed_diff", { workspaceId, ignoreWhitespace }),

  // ─── File operations ───────────────────────────────────────────
  openFileInSystem: (path: string) => invoke<void>("open_file_in_system", { path }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),
  detectEditors: () => invoke<EditorChoice[]>("detect_editors"),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  readFileChecked: (path: string, maxBytes?: number) =>
    invoke<FileReadResult>("read_file_checked", { path, maxBytes }),
  /** Lines `start..end` of a file, streamed: stops after `end`, so a range of
   *  a large file never reads all of it. `total` only when the read reached
   *  the file's end; `cut` when the range ran past `maxBytes`. */
  readFileLines: (path: string, start: number, end: number, maxBytes: number) =>
    invoke<LineRangeResult>("read_file_lines", { path, start, end, maxBytes }),
  writeFile: (path: string, content: string) =>
    invoke<{ mtime: number }>("write_file", { path, content }),
  fileMeta: (path: string) => invoke<FileMeta | null>("file_meta", { path }),

  // ─── Open With / Quick View ────────────────────────────────────
  /** The file this Quick View window was opened for (null outside one). */
  quickviewPath: () => invoke<string | null>("quickview_path"),
  /** Open a file in its own Quick View window. */
  openQuickView: (path: string) => invoke<void>("open_quickview_window", { path }),
  /** The workspace whose worktree contains `path`, if any. */
  workspaceForPath: (path: string) =>
    invoke<WorkspaceMatch | null>("workspace_for_path", { path }),
  /** Bring the main window forward and open `path` in its workspace's
   *  editor. Resolves false when no workspace contains the file. */
  openPathInWorkspace: (path: string) =>
    invoke<boolean>("open_path_in_workspace", { path }),
  showMainWindow: () => invoke<void>("show_main_window"),
  /** Label of the window this webview runs in ("main" outside Tauri). */
  currentWindowLabel: (): string => {
    try {
      return getCurrentWindow().label;
    } catch {
      return "main";
    }
  },
  /** Intercept this window's close. The handler returns true to let it close;
   *  false keeps it open (the caller then closes it via `destroyCurrentWindow`). */
  onCloseRequested: (handler: () => boolean) =>
    getCurrentWindow().onCloseRequested((event) => {
      if (!handler()) event.preventDefault();
    }),
  destroyCurrentWindow: () => getCurrentWindow().destroy(),
  /** Tell Rust whether this Quick View holds unsaved edits, so quitting the
   *  app (⌘Q) can stop and ask instead of dropping them. */
  quickviewSetDirty: (dirty: boolean) => invoke<void>("quickview_set_dirty", { dirty }),
  /** Rust asks this window to confirm closing (an app quit hit unsaved edits). */
  onConfirmCloseRequest: (handler: () => void) =>
    listen("octo://confirm-close", () => handler()),
  /** Claude Code's `Stop` hook fired in a Run terminal: its turn is over.
   *  The handler gets the terminal's id. */
  onPtySettled: (handler: (terminalId: string) => void) =>
    listen<PtySettledEvent>("pty://settled", (ev) => handler(ev.payload.sessionId)),
  /** Claude Code's `SessionStart` or `SessionEnd` hook fired in a Run
   *  terminal: the Claude Code session it runs started, changed (`/clear`,
   *  a resume) or ended. The handler gets the terminal's id. */
  onClaudeSessionChanged: (handler: (terminalId: string) => void) =>
    listen<PtySettledEvent>("pty://claude-session", (ev) => handler(ev.payload.sessionId)),
  /** A transcript ingest pass changed the spend ledger (rows added or
   *  Direct-session duplicates removed). */
  onSpendIngested: (handler: () => void) =>
    listen("octo://spend-ingested", () => handler()),
  /** A crew was chosen in the menu bar Octo's menu: open its Direct surface. */
  onOpenRunFromMenuBar: (handler: (target: OpenRunPayload) => void) =>
    listen<OpenRunPayload>("octo://open-run", (ev) => handler(ev.payload)),
  /** A Talk conversation waiting on an approval was chosen in the menu bar
   *  Octo's menu: open it in Talk. */
  onOpenTalkFromMenuBar: (handler: (target: OpenTalkPayload) => void) =>
    listen<OpenTalkPayload>("octo://open-talk", (ev) => handler(ev.payload)),
  /** Theme changes cross windows (the DOM `octo:theme` event does not). */
  broadcastTheme: (theme: ThemeConfig) => emit("octo://theme", theme),
  onThemeBroadcast: (handler: (theme: ThemeConfig) => void) =>
    listen<ThemeConfig>("octo://theme", (ev) => handler(ev.payload)),

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

  /** The Claude plan windows CLI stages last reported (empty until a
   *  subscription-authenticated stage streamed one). */
  getClaudePlan: () => invoke<PlanSnapshot[]>("get_claude_plan"),

  /** When the claude.ai sign-in ends, as CLI stages last reported it (null
   *  until a stage on Claude Code 2.1.318+ said). */
  getClaudeLogin: () => invoke<ClaudeLoginExpiry | null>("get_claude_login"),

  /** The Usage page's report over a range, optionally one surface. Day
   *  buckets follow `utcOffsetMinutes` (the viewer's local offset). */
  getUsageReport: (startIso: string, endIso: string, surface: string | null, utcOffsetMinutes: number) =>
    invoke<UsageReport>("get_usage_report", { startIso, endIso, surface, utcOffsetMinutes }),

  /** The Usage page's gateway reconciliation for a period; `null` when no
   *  provider fronts a gateway (or it could not be reached). */
  getGatewayReconciliation: (startIso: string, endIso: string, utcOffsetMinutes: number) =>
    invoke<GatewayReconciliation | null>("get_gateway_reconciliation", { startIso, endIso, utcOffsetMinutes }),

  refreshPricing: () =>
    invoke<RefreshPricingResult>("refresh_pricing"),
  /** Price the ledger's $0 rows with the catalog as it stands now; returns
   *  how many got a price. */
  repriceSpend: () => invoke<number>("reprice_spend"),

  // ─── Settings ─────────────────────────────────────────────────
  getSettings: () =>
    invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) =>
    invoke<void>("save_settings", { settings }),
  /** The path of `settings.json` when it exists but can't be parsed (the app
   *  then shows defaults and refuses every save), else null. */
  unreadableSettingsPath: () =>
    invoke<string | null>("unreadable_settings_path"),
  // ─── Notify me elsewhere (#964) ────────────────────────────────
  /** The saved switch and webhook URL (off, no URL, by default). */
  getNotifyElsewhere: () => invoke<NotifyElsewhere>("get_notify_elsewhere"),
  /** Save both (the only writer). Rejects an invalid URL (https, or http to
   *  this Mac only) and turning on without one; returns what was stored. */
  setNotifyElsewhere: (enabled: boolean, url: string) =>
    invoke<NotifyElsewhere>("set_notify_elsewhere", { enabled, url }),
  /** "Send a test": the test message to `url` (saved or not), once. Rejects
   *  with the cause, never the URL. */
  notifyElsewhereTest: (url: string) => invoke<void>("notify_elsewhere_test", { url }),
  /** The body's fields for a checkpoint gate, and every `event` value. */
  notifyElsewherePreview: () => invoke<NotifyElsewherePreview>("notify_elsewhere_preview"),
  // ─── Updater (channels + launch alert) ─────────────────────────
  /** The persisted update channel (`stable` by default). */
  getUpdateChannel: () => invoke<UpdateChannel>("get_update_channel"),
  /** Persist the update channel; returns the stored value. */
  setUpdateChannel: (channel: UpdateChannel) =>
    invoke<UpdateChannel>("set_update_channel", { channel }),
  /** The version the user skipped in the launch alert, if any. */
  getSkippedUpdateVersion: () => invoke<string | null>("get_skipped_update_version"),
  /** Persist (or clear, with null) the skipped version. */
  setSkippedUpdateVersion: (version: string | null) =>
    invoke<void>("set_skipped_update_version", { version }),
  /** Check the current channel's manifest; null when up to date. */
  updaterCheck: () => invoke<UpdateInfo | null>("updater_check"),
  /** Download + install the update found by the last check, with progress. */
  updaterInstall: (onEvent: (event: UpdateDownloadEvent) => void) => {
    const channel = new Channel<UpdateDownloadEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("updater_install", { onEvent: channel });
  },

  saveGitCredentials: (host: string, username: string, token: string) =>
    invoke<void>("save_git_credentials", { host, username, token }),

  // ─── Terminals ────────────────────────────────────────────────
  listTerminals: (workspaceId: string) =>
    invoke<TerminalRecord[]>("list_terminals", { workspaceId }),
  createTerminal: (workspaceId: string, label: string) =>
    invoke<TerminalRecord>("create_terminal", { workspaceId, label }),
  renameTerminal: (id: string, label: string) =>
    invoke<void>("rename_terminal", { id, label }),
  /** Persist the session line's order: `ids[i]` takes position `i`. */
  reorderTerminals: (workspaceId: string, ids: string[]) =>
    invoke<void>("reorder_terminals", { workspaceId, ids }),
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
  /** Secret guard (#730): rejects with `SecretsFound` (see `lib/secretGuard`)
   *  on a possible credential in the staged diff (or a partial scan), unless
   *  `allowFindings` is the refusal's `fingerprint` — the user's confirm of
   *  exactly what the dialog showed. The core rescans every time. */
  commitChanges: (workspacePath: string, message: string, allowFindings?: string) =>
    invoke<string>("commit_changes", { workspacePath, message, allowFindings: allowFindings ?? null }),

  /** Secret guard (#835): what Commit's scan of the staged diff would find,
   *  for the Review Companion's verdict. `null` when the guard is off. Never
   *  blocks anything and carries no fingerprint: Commit rescans and asks. */
  secretScanStaged: (workspacePath: string) =>
    invoke<SecretPreview | null>("secret_scan_staged", { workspacePath }),

  /** "Scan this branch's commits" (#820): the guard's rules over every commit
   *  since the merge base with `base`, on demand, guard switch on or off.
   *  Read-only; rejects when no merge base resolves. */
  secretScanBranch: (workspacePath: string, base: string) =>
    invoke<SecretPreview>("secret_scan_branch", { workspacePath, base }),

  /** Secret guard (#1046): the guard's rules over the context blocks a Talk
   *  message is about to attach. `null` when the guard is off. A finding's
   *  `file` is the block's `label`; its line counts from `firstLine`. */
  secretScanText: (blocks: { label: string; text: string; firstLine?: number; wholeFile?: boolean }[]) =>
    invoke<SecretPreview | null>("secret_scan_text", { blocks }),

  getStagedDiff: (path: string) => invoke<string>("get_staged_diff", { path }),
  amendCommit: (workspacePath: string, message: string, allowFindings?: string) =>
    invoke<string>("amend_commit", { workspacePath, message, allowFindings: allowFindings ?? null }),
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

  /** Returns the trimmed git-push output (combined stdout+stderr). Secret
   *  guard (#730): rejects with `SecretsFound` on a possible credential in the
   *  commits being pushed, unless `allowFindings` is the fingerprint the
   *  dialog showed and the fresh scan still matches it. */
  pushBranch: (workspacePath: string, allowFindings?: string) =>
    invoke<string>("push_branch", { workspacePath, allowFindings: allowFindings ?? null }),

  /** Workspace-wide file listing (respects .gitignore). Returns paths
   *  relative to the workspace root. Capped at 20k entries. */
  listWorkspaceFiles: (workspacePath: string) =>
    invoke<string[]>("list_workspace_files", { workspacePath }),

  /** Workspace-wide text search. Literal (not regex); case-insensitive when
   *  `caseSensitive` is false. Capped at 500 hits.
   *
   *  `wholeWord` matches only on identifier boundaries (`[A-Za-z0-9_$]`, the
   *  same rule the editor's own word scan uses). Go-to-definition needs it:
   *  as a plain substring scan, looking up `run` spent the whole 500-hit cap
   *  on `running`/`runtime`/`rerun` and reported that nothing declared it. The
   *  ⌘⇧F palette deliberately stays substring — a human typing a fragment
   *  expects fragments back. */
  searchWorkspaceText: (
    workspacePath: string,
    query: string,
    caseSensitive = false,
    wholeWord = false,
  ) =>
    invoke<SearchHit[]>("search_workspace_text", {
      workspacePath,
      query,
      caseSensitive,
      wholeWord,
    }),

  /** Look up a pull request on GitHub for the current branch (any state).
   *  Resolves to `null` when there's no PR, no GitHub remote, or any
   *  network error — UI is expected to hide the chip silently. */
  findPrForBranch: (workspacePath: string) =>
    invoke<Pr | null>("find_pr_for_branch", { workspacePath }),

  /** The tail of these Actions runs' failed-step logs (`gh run view
   *  --log-failed`), capped at 8k chars. Empty without `gh`. */
  prFailedCheckLogs: (workspacePath: string, runIds: number[]) =>
    invoke<string>("pr_failed_check_logs", { workspacePath, runIds }),

  openPrsForProject: (projectPath: string) =>
    invoke<BranchPr[]>("open_prs_for_project", { projectPath }),

  /** The project's missions whose PR was merged at their worktree's HEAD,
   *  with nothing changed in the worktree (never the project root). Rejects
   *  when the merged PRs can't be read (no `gh`, not on GitHub). */
  mergedWorkspaces: (projectId: string, projectPath: string) =>
    invoke<MergedWorkspace[]>("merged_workspaces", { projectId, projectPath }),

  /** Archive those of `workspaceIds` that still pass when it acts (merged at
   *  HEAD, clean, no Talk turn or Direct run active, and no local files but
   *  the ones `localFilesOk` names for it, the paths its confirm showed);
   *  says which were skipped and why. */
  archiveMergedWorkspaces: (
    projectId: string,
    projectPath: string,
    workspaceIds: string[],
    localFilesOk: Record<string, string[]>,
  ) =>
    invoke<MergedArchive>("archive_merged_workspaces", { projectId, projectPath, workspaceIds, localFilesOk }),

  /** Open pull requests for the project, for "start a workspace from a PR".
   *  Rejects with a friendly message when the GitHub CLI is missing or not
   *  authenticated — the UI maps any failure to a quiet empty state. */
  listPrs: (path: string) => invoke<PrInfo[]>("list_prs", { path }),
  /** Open GitHub issues for the project (the "Ship it" picker's source). */
  listGithubIssues: (path: string) => invoke<GhIssue[]>("list_github_issues", { path }),
  /** Preflight for "Ship it": github.com origin + authenticated gh. */
  githubShipReadiness: (path: string) =>
    invoke<ShipReadiness>("github_ship_readiness", { path }),
  /** The branch's diff + commits against `base` and the repo's PR template. */
  prDraftContext: (workspacePath: string, base: string) =>
    invoke<PrDraftContext>("pr_draft_context", { workspacePath, base }),
  /** `gh pr create` from the current branch (body passed via a file). The
   *  branch must already be published. Resolves to the new PR. Secret guard
   *  (#730): the PR's own scan, separate from the push's; `allowFindings`
   *  confirms only the fingerprint the PR dialog showed. */
  createPullRequest: (workspacePath: string, base: string, title: string, body: string, draft: boolean, allowFindings?: string) =>
    invoke<Pr>("create_pull_request", { workspacePath, base, title, body, draft, allowFindings: allowFindings ?? null }),

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

  // ─── Portable crews (.octocrew.json) ──────────────────────────────
  /** A saved pipeline (plus the custom roles it uses) as crew-file text. */
  exportCrew: (pipelineId: string) => invoke<string>("export_crew", { pipelineId }),
  /** Native save dialog, then the file. Resolves to the path, or null if cancelled. */
  saveCrewFile: (pipelineId: string) => invoke<string | null>("save_crew_file", { pipelineId }),
  readCrewFile: (path: string) => invoke<string>("read_crew_file", { path }),
  /** What an import would save. Writes nothing. `modelSwaps`: [from, to] pairs. */
  previewCrew: (text: string, modelSwaps?: [string, string][]) =>
    invoke<CrewPreview>("preview_crew", { text, modelSwaps: modelSwaps ?? null }),
  /** Save a reviewed crew as a new custom pipeline; never starts a run. Returns its id. */
  importCrew: (text: string, modelSwaps?: [string, string][]) =>
    invoke<string>("import_crew", { text, modelSwaps: modelSwaps ?? null }),
  /** Crews committed under `<worktree>/.octopush/crews/`, re-read on every call. */
  listRepoCrews: (workspacePath: string) => invoke<RepoCrew[]>("list_repo_crews", { workspacePath }),
  /** One repo crew's text (never through a symlink), for Fork. */
  readRepoCrew: (workspacePath: string, file: string) => invoke<string>("read_repo_crew", { workspacePath, file }),

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
  /** A routine fire moved to a new phase (condition, fresh workspace, setup, launch). */
  onRoutinePhase: (handler: (ev: RoutinePhaseEvent) => void) =>
    listen<RoutinePhaseEvent>("routine://phase", (ev) => handler(ev.payload)),
  /** Next `count` fire times (RFC3339 UTC) for a schedule — the editor preview.
   *  Read-only; an invalid spec returns []. */
  previewRoutineSchedule: (kind: string, spec: string, count: number) =>
    invoke<string[]>("preview_routine_schedule", { kind, spec, count }),

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

  /** Runs that settled after `since` — by default after the app was last quit
   *  (falling back to 24 h ago). Seeds Mission Control's "While you were away". */
  listRunsSettledSince: (since?: string) =>
    invoke<Run[]>("list_runs_settled_since", { since: since ?? null }),

  resolveCheckpoint: (
    runId: string,
    /** The stage the director decided on. Required: a run can hold several
     *  (a plan limit beside a gate), and the director decides on the one
     *  they looked at, never "the first". A named stage that is no longer
     *  waiting (decided elsewhere) is refused with "This stage was already
     *  decided — refresh to see what's waiting.", never redirected to
     *  another stage (Abort always goes through). */
    stageId: string,
    action: CheckpointActionName,
    opts: CheckpointOptions = {},
  ) =>
    invoke<void>("resolve_checkpoint", {
      runId,
      action,
      feedback: opts.feedback ?? null,
      modelOverride: opts.modelOverride ?? null,
      maxTurnsOverride: opts.maxTurnsOverride ?? null,
      stageId,
    }),

  /** Answer a stage that parked itself via the `ask_director` escape valve.
   *  `answers` is positional — one per question the stage asked; a missing or
   *  empty entry falls back to that question's recommended default. The
   *  decisions become the stage's re-run feedback and the stage re-runs.
   *  `source` names the surface that answered, for the run journal; omitted =
   *  the Direct answer form. */
  answerBlocker: (runId: string, stageId: string, answers: string[], source?: AnswerSource) =>
    invoke<void>("answer_blocker", { runId, stageId, answers, source: source ?? null }),

  abortRun: (runId: string) =>
    invoke<void>("abort_run", { runId }),

  /** Turn off a plan-parked run's automatic resume: it waits for a manual
   *  Resume. ("Resume now" is `resolveCheckpoint(runId, stageId, "resume")`
   *  on the plan-limited stage.) */
  cancelPlanResume: (runId: string) =>
    invoke<void>("cancel_plan_resume", { runId }),

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
  /** Persisted live journal of one Talk sub-agent (`Agent` tool call), oldest
   *  first — the crew card rehydrates from this after a reload. Live entries
   *  arrive on `CHAT_AGENT_LOG_EVENT` while the sub-agent runs. */
  getChatAgentLog: (callId: string) =>
    invoke<LiveEntry[]>("get_chat_agent_log", { callId }),

  /** Archived attempts for a stage, oldest first (iteration ascending). */
  listStageIterations: (stageId: string) =>
    invoke<StageIteration[]>("list_stage_iterations", { stageId }),

  estimateRunCost: (pipelineId: string, stageOverrides?: [number, string][]) =>
    invoke<RunEstimate>("estimate_run_cost", {
      pipelineId,
      stageOverrides: stageOverrides ?? null,
    }),

  // ─── Entitlement (premium scaffolding) ────────────────────────
  getEntitlement: () => invoke<Entitlement>("get_entitlement"),
  /** Rust refreshed the signed entitlement token and the plan changed
   *  (`entitlement_token::ENTITLEMENT_CHANGED_EVENT`). */
  onEntitlementChanged: (handler: () => void) =>
    listen("entitlement-changed", () => handler()),
  directRunUsage: () => invoke<DirectRunUsage>("direct_run_usage"),
  /** Durable "has ever started a Direct run" — the first-run invite signal. */
  hasEverStartedRun: () => invoke<boolean>("has_ever_started_run"),

  // ─── Cross-machine run history (Pro-real Part B / B1) ──────────
  /** The user's cloud-sync opt-ins (both off by default). Local read. */
  getSyncPrefs: () => invoke<SyncPrefs>("get_sync_prefs"),
  /** The last push attempt per sync kind, for the line under each toggle.
   *  Local read. */
  getSyncStatus: () => invoke<SyncStatus>("get_sync_status"),
  /** Turn one cloud sync on/off; returns the new pair. Turning on is Pro-gated
   *  (throws `UpgradeRequired` for Free). Off never deletes server data. */
  setSyncPref: (kind: SyncKind, enabled: boolean) =>
    invoke<SyncPrefs>("set_sync_pref", { kind, enabled }),
  /** The local read-only history mirror (instant, no network). */
  historyList: () => invoke<SyncedRun[]>("history_list"),
  /** Pull the user's run history from the cloud, replace the mirror, return it.
   *  Pro-gated (throws `UpgradeRequired` for Free). */
  historySyncPull: () => invoke<SyncedRun[]>("history_sync_pull"),
  /** One synced run's full story (journals · artifacts · diffs), fetched on
   *  demand (B2). Null when the server has no detail for that run. Pro-gated. */
  historyRunDetail: (runId: string) =>
    invoke<SyncedRunDetail | null>("history_run_detail", { runId }),
  /** The models among `models` this Mac has no price for (deduplicated). The
   *  History sheet marks their synced stages "unpriced" instead of "$0.00". */
  unpricedModels: (models: string[]) => invoke<string[]>("unpriced_models", { models }),

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
  /** Installed Claude Code CLI version vs the tested floor (cached per app session). */
  claudeCliVersion: () =>
    invoke<ClaudeCliVersion>("claude_cli_version"),
  /** Direct launcher: the one model among `models` the installed Claude Code
   *  is too old to launch (`agent_adapter::CLAUDE_MODEL_FLOORS`), read from the
   *  cached version without probing; null when none or the version is unknown. */
  claudeModelFloorNote: (models: string[]) =>
    invoke<ClaudeModelFloorNote | null>("claude_model_floor_note", { models }),
  /** Direct launcher: the line naming a Claude Code release to skip
   *  (`agent_adapter::CLAUDE_KNOWN_BAD_RELEASES`) when one of `models` is a
   *  gateway model, read from the cached version without probing; null otherwise. */
  claudeKnownBadNote: (models: string[]) =>
    invoke<string | null>("claude_known_bad_note", { models }),
  /** The launcher's untrusted-Codex-project line for `workspacePath`, or null. Reads Codex's config only. */
  codexTrustNote: (workspacePath: string) =>
    invoke<CodexTrustNote | null>("codex_trust_note", { workspacePath }),
  /** The hooks and MCP servers the repo's own Claude Code config runs, or null. Read-only. */
  repoHooksNotice: (workspacePath: string) =>
    invoke<RepoHooksNotice | null>("repo_hooks_notice", { workspacePath }),
  /** The models among `models` with a published retirement date
   *  (`token_engine::MODEL_RETIREMENTS`), each id once; the caller does the date math. */
  modelRetirements: (models: string[]) =>
    invoke<ModelRetirement[]>("model_retirements", { models }),
  /** Settings › General readiness card: local checks, each bounded at 3 s, never cached.
   *  `askClaude` (an explicit Check again) also runs `claude auth status`. */
  readinessCheck: (askClaude = false) =>
    invoke<ReadinessCheck[]>("readiness_check", { askClaude }),
};

/** One row of the readiness card (mirrors Rust `readiness::ReadinessCheck`). */
export interface ReadinessCheck {
  /** `models` is built in the frontend (`modelRetirement.readinessRetirementCheck`), not by the backend. */
  id: "claude" | "auth" | "codex" | "git" | "gh" | "disk" | "ollama" | "models";
  label: string;
  status: "ok" | "warn" | "fail";
  /** The live value: a version, "Token found", "No answer in 3 s"… */
  value: string;
  fix: string | null;
  /** A copyable command that fixes it, when there is one. */
  command: string | null;
  timedOut: boolean;
  /** Recommendations that are no verdict: the Claude Code row's missing
   *  `agent_adapter::CLAUDE_RECOMMENDED_FIXES` rows, oldest first; the card
   *  decides by audience which show. */
  recommended?: RecommendedFix[];
}

/** A Claude Code fix worth updating for (mirrors Rust `agent_adapter::RecommendedFix`).
 *  `run`: shown while a Run-mode session runs Claude Code; `any`: shown to
 *  anyone on an older Claude Code. */
export interface RecommendedFix {
  version: string;
  /** "fixes …", one line. */
  reason: string;
  audience: "run" | "any";
}

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

/** One stage of a pre-run estimate. `lowUsd`/`highUsd` are null when its
 *  model is unpriced. `rough` = the role's built-in prior, not this Mac's runs. */
export interface StageEstimate {
  position: number;
  role: string;
  effort: string | null;
  model: string;
  lowUsd: number | null;
  highUsd: number | null;
  samples: number;
  rough: boolean;
}

/** `estimate_run_cost`: this Mac's past token use per (role, effort),
 *  re-priced at the chosen models. The range fields are optional so an older
 *  shape (demo fixtures) still renders a single figure. */
export interface RunEstimate {
  estimateUsd: number;
  baselineUsd: number;
  lowUsd?: number;
  highUsd?: number;
  unpricedModels?: string[];
  unpricedStages?: number;
  perStage?: StageEstimate[];
  confidence?: "history" | "rough";
}

/** The installed Claude Code CLI's version against the tested floor. */
export interface ClaudeCliVersion {
  /** `x.y.z` from `claude --version`; null when the CLI isn't found. */
  version: string | null;
  floor: string;
  /** True only when the version is known and older than the floor. */
  belowFloor: boolean;
  /** The newest sandbox/permission fix (`agent_adapter::CLAUDE_SECURITY_FIXES`)
   *  the known version lacks; null when it has them all or is unknown. */
  securityFix?: { version: string; reason: string } | null;
  /** The version to update to: the higher of the floor and `securityFix`. */
  recommended?: string;
  /** The release to skip (`agent_adapter::CLAUDE_KNOWN_BAD_RELEASES`) the
   *  known version is exactly; null for any other version or an unknown one. */
  knownBad?: { version: string; reason: string; scope: "gatewayStages" } | null;
}

/** Codex will skip the repo's `.codex/` config: the project is marked
 *  untrusted in Codex, or has no trust decision saved
 *  (`commands::codex_trust_note`). */
export interface CodexTrustNote {
  line: string;
  /** How the user can trust it themselves; differs between the two states. */
  how: string;
}

/** What a worktree's committed `.claude/settings.json` (hooks, status line)
 *  and `.mcp.json` (servers) run in a Claude Code stage
 *  (`commands::repo_hooks_notice`). */
export interface RepoHooksNotice {
  hooks: { event: string; matcher: string | null; kind: "command" | "http" | "mcp_tool" | "status_line"; runs: string }[];
  servers: { name: string; runs: string }[];
  /** SHA-256 over the canonical JSON of every entry. */
  hash: string;
}

/** A crew model the installed Claude Code is too old for (mirrors Rust
 *  `agent_adapter::ClaudeModelFloorNote`). */
export interface ClaudeModelFloorNote {
  /** Display name, e.g. "Fable 5.2". */
  label: string;
  /** The oldest Claude Code that runs it. */
  needs: string;
  installed: string;
}

/** A crew model with a published retirement date (mirrors Rust
 *  `token_engine::ModelRetirement`). */
export interface ModelRetirement {
  /** The id as the stage names it, e.g. "claude-sonnet-4-5-20250929". */
  model: string;
  /** Display name, e.g. "Sonnet 4.5". */
  label: string;
  /** `YYYY-MM-DD`; requests fail after this day. */
  retires: string;
  replacement: string;
  replacementLabel: string;
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
export { CHAT_AGENT_LOG_EVENT } from "./agentTools";

/** Picker-sized view of a `.claude/agents/*.md` definition. */
export interface SubagentTypeMeta {
  name: string;
  description: string;
  /** "project" or "user". */
  source: string;
  /** Workspace tool names the sub-agent is limited to; null = the full set. */
  tools: string[] | null;
  /** The frontmatter `model` as written (an id or an alias like "haiku"). */
  model: string | null;
}

/** One Claude plan window as a CLI stage last saw it (`claude_plan.rs`).
 *  `utilization` is a fraction; `resetsAt` epoch seconds; `seenAt` RFC3339. */
export interface PlanSnapshot {
  /** `five_hour` · `seven_day` · `seven_day_opus` · … (unknown kinds kept). */
  kind: string;
  utilization: number | null;
  resetsAt: number | null;
  /** `allowed` · `allowed_warning` · `rejected` · …; null when unknown. */
  status: string | null;
  overageStatus: string | null;
  usingOverage: boolean;
  seenAt: string;
}

/** `claude_login::LoginExpiry`: when the stored claude.ai sign-in ends. */
export interface ClaudeLoginExpiry {
  /** Epoch seconds. */
  expiresAt: number;
  /** When a stage reported it, RFC3339. */
  seenAt: string;
}

export const RUN_EVENTS = {
  stageUpdate: "run://stage-update",
  cost: "run://cost",
  checkpoint: "run://checkpoint",
  error: "run://error",
  /** Live per-stage activity, streamed by both substrates. Payload:
   *  `{ runId, stageId, entry: LiveEntry }` or `{ runId, stageId, reset: true }`. */
  log: "run://log",
  /** A Claude CLI stage's latest context reading (#895), kept on its stage
   *  row and re-emitted by the detached bridge. Payload:
   *  `{ runId, stageId, contextTokens: number | null, contextWindow: number | null }`. */
  context: "run://context",
} as const;
