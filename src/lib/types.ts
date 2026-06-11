// Mirror of the Rust `Session` model. Kept in sync manually for Phase 1;
// Phase 2 will consider generating from Rust via `ts-rs` or `specta`.

export type SessionStatus =
  | "active"
  | "idle"
  | "paused"
  | "completed"
  | "error";

export type Provider =
  | { type: "anthropic" }
  | { type: "anthropic_bedrock" }
  | { type: "open_ai" }
  | { type: "google" }
  | { type: "ollama" }
  | { type: "custom"; value: string };

export interface AgentConfig {
  provider: Provider;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPromptOverride: string | null;
}

export interface Session {
  id: string;
  name: string;
  color: string;
  icon: string;
  projectRoot: string;
  agent: AgentConfig;
  tokenBudget: number | null;
  tokensUsed: number;
  tokensInput: number;
  tokensOutput: number;
  status: SessionStatus;
  contextFiles: string[];
  tags: string[];
  createdAt: string;
  lastActive: string;
}

export interface CreateSessionArgs {
  name: string;
  projectRoot: string;
  color?: string;
  icon?: string;
  agent?: AgentConfig;
  tokenBudget?: number;
  tags?: string[];
  contextFiles?: string[];
}

export interface PtyDataEvent {
  sessionId: string;
  bytes: number[];
}

export interface PtyExitEvent {
  sessionId: string;
  code: number | null;
}

// ─── Token types ──────────────────────────────────────────────────

export interface TokenEvent {
  id: number | null;
  sessionId: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
  costUsd: number;
}

export interface CostEntry {
  label: string;
  costUsd: number;
  tokens: number;
}

export interface TrendPoint {
  hour: string;
  tokens: number;
  costUsd: number;
}

export interface TokenReport {
  totalInput: number;
  totalOutput: number;
  totalCached: number;
  totalCostUsd: number;
  costBySession: CostEntry[];
  costByModel: CostEntry[];
  hourlyTrend: TrendPoint[];
  budgetRemaining: number | null;
  projectedDailyCost: number;
}

export interface BudgetStatus {
  sessionId: string;
  budget: number | null;
  used: number;
  remaining: number | null;
  percentUsed: number | null;
}

// ─── Templates ────────────────────────────────────────────────────

// ─── Projects ─────────────────────────────────────────────────────

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  jiraProjectKey: string | null;
  pinned: boolean;
  tint: string | null;
}

// ─── Workspaces ───────────────────────────────────────────────────

export type TintName = "brass" | "verdigris" | "rouge" | "indigo" | "lavender" | "smoke" | "bone";

export interface Workspace {
  id: string;
  projectId: string;
  name: string;
  task: string;
  branch: string;
  worktreePath: string | null;
  setupScript: string;
  status: string;
  createdAt: string;
  lastActive: string;
  glyph: string | null;
  tint: TintName | null;
  testCommand?: string | null;
  linkedIssueKey: string | null;
  /** Resolved base branch this workspace was created from (null for rows
   *  predating the column and for the auto-created default-branch row). */
  fromBranch: string | null;
}

// ─── File edits ───────────────────────────────────────────────────

export interface FileEdit {
  id: number;
  workspaceId: string;
  filePath: string;
  toolName: string;
  messageId: number | null;
  createdAt: string;
}

// ─── Test runner ──────────────────────────────────────────────────

export interface TestRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ─── Terminals ────────────────────────────────────────────────────

export interface TerminalRecord {
  id: string;
  workspaceId: string;
  label: string;
  position: number;
  createdAt: number;
}

/** A live PTY session reported by the daemon (via `list_pty_sessions`). */
export interface PtySession {
  id: string;
  running: boolean;
  startedAt: number;
}

/** Payload of the `pty://reattached` Tauri event. */
export interface PtyReattachedEvent {
  sessionId: string;
}

/** Payload of the `pty://attention` Tauri event. Emitted by the
 *  daemon when a session has been idle long enough after a
 *  meaningful burst of output to count as "waiting on the user". */
export interface PtyAttentionEvent {
  sessionId: string;
}

// ─── Chat ─────────────────────────────────────────────────────────

export interface ChatMessage {
  id: number;
  workspaceId: string;
  role: "user" | "assistant" | "tool" | "error";
  content: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdAt: string;
}

export interface ChatStreamEvent {
  workspaceId: string;
  delta: string;
  done: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}

// ─── Git ──────────────────────────────────────────────────────────

export interface GitStatus {
  branch: string | null;
  changedFiles: FileChange[];
  ahead: number;
  behind: number;
  /** False when the current branch has never been pushed (no upstream
   *  tracking branch configured). UI uses this to enable Publish for the
   *  first push, since `ahead` is 0 with no upstream to compare against. */
  hasUpstream: boolean;
  /** Count of files with an unresolved merge conflict. */
  conflicted: number;
  /** False when ahead/behind timed out (huge graph); UI hides the ↑/↓ badge. */
  aheadBehindKnown: boolean;
  /** The in-progress multi-step operation, if any. */
  operation: "merge" | "rebase" | null;
}

/** Branches offered as a base for new workspaces. Locals come repo-default
 *  first; remotes are fully qualified (`origin/dev`) and pass through to the
 *  backend unchanged. */
export interface BranchList {
  local: string[];
  remote: string[];
}

export interface FileChange {
  path: string;
  status: "new" | "modified" | "deleted" | "renamed" | "unknown" | "conflicted";
  /** The file has changes in the index (staged for commit). */
  staged: boolean;
  /** The file has unstaged worktree modifications. */
  unstaged: boolean;
  /** Unresolved merge-conflict (unmerged index) state. */
  conflicted: boolean;
}

export type PrState = "open" | "draft" | "merged" | "closed";

/** A single pull request on the current branch (GitHub only for now).
 *  State is derived server-side: open/draft for live PRs, merged/closed for completed ones. */
export interface Pr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: PrState;
}

/** @deprecated Use `Pr` instead. */
export type OpenPr = Pr;

/** A branch and its open PR, from open_prs_for_project (rail PR indicator). */
export interface BranchPr {
  branch: string;
  pr: Pr;
}

/** A single text-search hit (line-level match) within the workspace. */
export interface SearchHit {
  /** Path relative to the workspace root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column where the match starts. */
  col: number;
  /** The full or partially-snipped source line for preview. */
  preview: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
  isIgnored: boolean;
}

// ─── Settings ─────────────────────────────────────────────────────

export interface GitCredentialEntry {
  username: string;
  token: string;
}

export interface AppSettings {
  providerKeys: Record<string, string>;
  providerBaseUrls: Record<string, string>;
  /** Per-host git credentials, keyed by hostname (e.g. "github.com"). */
  gitCredentials: Record<string, GitCredentialEntry>;
  /** ISO-8601 timestamp of the last successful pricing refresh from LiteLLM. */
  lastPricingRefresh?: string | null;
  /** Optional "Open in editor" command override; empty/undefined → autodetect. */
  editorCommand?: string | null;
  /** Jira/issue-tracker connection config (preserved across saves). */
  issueTracker?: IssueTrackerConfig | null;
  /** @deprecated use providerKeys.anthropic */
  anthropicApiKey?: string | null;
  /** @deprecated use providerKeys.openai */
  openaiApiKey?: string | null;
}

export interface EditorChoice {
  id: string;
  name: string;
  command: string;
}

/** Compact per-workspace git signal for the rail (from workspaces_git_summary). */
export interface WorkspaceGitSummary {
  workspaceId: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

// ─── Usage breakdown (cloud vs local) ─────────────────────────────

export interface UsageBreakdown {
  cloudCostUsd: number;
  cloudTokens: number;
  localTokens: number;
  estimatedLocalSavingsUsd: number;
}

// ─── Pricing refresh ───────────────────────────────────────────────

export interface RefreshPricingResult {
  modelsUpdated: number;
  modelsTotal: number;
  fetchedAt: string;
}

// ─── Theme ────────────────────────────────────────────────────────

export interface ThemeConfig {
  name: string;
  bg: string;
  panel: string;
  /** "Raised" surface — used for row hover, popovers, active selections.
   *  For dark themes this is a step brighter than `panel`; for light
   *  themes it can be a step darker, providing the same contrast cue. */
  panel2: string;
  border: string;
  accent: string;
  accentDim: string;
  success: string;
  warning: string;
  danger: string;
  text: string;
  textDim: string;
  textMuted: string;
  terminalBg: string;
}

// ─── Session Recap ────────────────────────────────────────────────

export interface SessionRecap {
  sessionId: string;
  sessionName: string;
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
  costUsd: number;
  durationSecs: number;
  model: string;
  projectRoot: string;
  createdAt: string;
  endedAt: string;
}

// ─── Providers / Models ───────────────────────────────────────────

export interface ModelInfo {
  id: string;
  displayName: string;
  inputCostPerM: number;
  outputCostPerM: number;
  /** Cost per million cache-read tokens. 0 = not applicable. */
  cacheReadCostPerM: number;
  /** Cost per million cache-creation tokens. 0 = not applicable. */
  cacheCreationCostPerM: number;
  maxContext: number;
  supportsVision: boolean;
  supportsTools: boolean;
  /** Curated short labels rendered next to the model name in the picker. */
  tags?: string[];
}

export interface ModelWithProvider {
  provider: string;
  model: ModelInfo;
}

export interface ModelSuggestion {
  modelId: string;
  provider: string;
  reason: string;
  estimatedCostTier: "low" | "medium" | "high";
}

export interface ProviderConfig {
  name: string;
  apiBase: string;
  apiKeyEnv: string;
  models: ModelInfo[];
  rateLimits?: { requestsPerMinute?: number | null; tokensPerMinute?: number | null };
  enabled: boolean;
  protocol: string; // "anthropic" | "openai-compatible"
  local: boolean;
}

export type TaskType =
  | "code_review"
  | "architecture"
  | "quick_fix"
  | "debugging"
  | "documentation"
  | "testing"
  | "refactoring"
  | "general";

export interface AdapterInfo {
  name: string;
  displayName: string;
  supportsHotSwap: boolean;
}

export interface SwitchResult {
  session: Session;
  appliedToPty: boolean;
  message: string;
}

// ─── Budgets ──────────────────────────────────────────────────────

export type BudgetScope = "global" | "project" | "workspace";
export type BudgetPeriod = "daily" | "monthly";

export interface Budget {
  scopeType: BudgetScope;
  scopeId: string;
  period: BudgetPeriod;
  limitUsd: number;
  updatedAt: string;
}

export interface SpendSnapshot {
  costUsd: number;
  tokens: number;
}

// ─── Performance stats ────────────────────────────────────────────

export interface ProcGroup {
  rssBytes: number;
  cpuPct: number;
  processCount: number;
}

export interface PerfStats {
  app: ProcGroup;
  daemon: ProcGroup;
  total: ProcGroup;
  disk: { freeBytes: number; totalBytes: number };
  ts: number;
}

export interface WorkspaceCacheSizes {
  entries: { name: string; bytes: number }[];
  totalBytes: number;
}

// ─── Issue Tracker ────────────────────────────────────────────────

export type StatusCategory = "todo" | "inProgress" | "done" | "unknown";

/** Lightweight reference to a related ticket — emitted inline by Jira's
 *  issuelinks / subtasks arrays. Enough data to render a row without a
 *  second round-trip. */
export interface LinkedIssueRef {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: StatusCategory;
  issueType: string;
  url: string;
}

export interface Issue {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: StatusCategory;
  issueType: string;
  priority: string | null;
  url: string;
  parentKey: string | null;
  subtask: boolean;
  hierarchyLevel: number;
  /** Tickets this ticket blocks. Populated by getIssue; empty for the
   *  list_my_issues payload, which doesn't request issuelinks. */
  blocks?: LinkedIssueRef[];
  /** Tickets that block this ticket. */
  blockedBy?: LinkedIssueRef[];
  /** Direct children of this ticket. */
  subtasks?: LinkedIssueRef[];
}

export interface IssueTrackerConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

// ─── Templates ────────────────────────────────────────────────────

export interface SessionTemplate {
  name: string;
  projectRoot: string;
  agent?: AgentConfig;
  env?: Record<string, string>;
  contextFiles?: string[];
  tokenBudget?: number;
  tags?: string[];
  icon?: string;
  color?: string;
}
