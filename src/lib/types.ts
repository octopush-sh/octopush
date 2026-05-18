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
}

// ─── Terminals ────────────────────────────────────────────────────

export interface TerminalRecord {
  id: string;
  workspaceId: string;
  label: string;
  position: number;
  createdAt: number;
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
}

export interface FileChange {
  path: string;
  status: "new" | "modified" | "deleted" | "renamed" | "unknown";
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
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
  /** @deprecated use providerKeys.anthropic */
  anthropicApiKey?: string | null;
  /** @deprecated use providerKeys.openai */
  openaiApiKey?: string | null;
}

// ─── Theme ────────────────────────────────────────────────────────

export interface ThemeConfig {
  name: string;
  bg: string;
  panel: string;
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
  maxContext: number;
  supportsVision: boolean;
  supportsTools: boolean;
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
  enabled: boolean;
  protocol: string;
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
