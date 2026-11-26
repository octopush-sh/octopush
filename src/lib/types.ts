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
  /** True while the chunk is replayed scrollback (history shown again after a
   *  reattach) rather than live output; absent from builds that predate it. */
  replay?: boolean;
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
  /** The project-scope rail group this project sits in. Null (or absent, in
   *  a row built before the backend answers) means ungrouped; so does an id
   *  that matches no loaded group. */
  groupId?: string | null;
}

// ─── Workspaces ───────────────────────────────────────────────────

export type TintName = "brass" | "verdigris" | "rouge" | "indigo" | "lavender" | "smoke" | "bone";

// ─── Rail groups ──────────────────────────────────────────────────

/** What a rail group holds: projects (at the rail's top level) or one
 *  project's workspaces. Also the `kind` of an item moved between groups. */
export type GroupScope = "project" | "workspace";

/** A rail group: a named, optionally tinted, one-level container. It outlives
 *  its members: an emptied group stays until it is deleted. Membership is the
 *  member's own `groupId` (`ProjectInfo.groupId`, `Workspace.groupId`), so an
 *  item is in at most one group. Whether a group is folded is a UI preference
 *  and is not stored here. */
export interface Group {
  id: string;
  scope: GroupScope;
  /** The owning project of a `workspace` group; null for a `project` group. */
  projectId: string | null;
  name: string;
  tint: TintName | null;
  /** Position among the groups of the same scope (and, for `workspace`
   *  groups, the same project). Ascending; not necessarily dense. */
  sortOrder: number;
  createdAt: string;
}

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
  /** The workspace-scope rail group this workspace sits in, kept through
   *  archive and restore. Null or absent means ungrouped; so does an id that
   *  matches no loaded group. */
  groupId?: string | null;
}

/** `create_workspace`'s response: the workspace, plus its `setup` terminal when
 *  the setup script was started (only for a freshly created worktree). */
export interface CreatedWorkspace extends Workspace {
  setupTerminalId: string | null;
  /** Why the setup script couldn't be started; the workspace itself is fine. */
  setupError: string | null;
  /** What the fresh worktree borrowed from the main checkout; null (or absent)
   *  when the project shares nothing or the worktree wasn't fresh. */
  shared?: ShareOutcome | null;
}

/** "Share with new missions" (#961): dependency folders to link from the main
 *  checkout and local env files to copy, each a name at the repo root. */
export interface ShareSpec {
  link: string[];
  copy: string[];
}

/** `share_with_missions`: what the project shares now, and what its main
 *  checkout could share (present and git-ignored there). */
export interface ShareOptions {
  saved: ShareSpec;
  available: ShareSpec;
}

/** What applying a project's ShareSpec did to a fresh worktree. */
export interface ShareOutcome {
  linked: string[];
  copied: string[];
  /** One sentence per entry left out ("node_modules: not linked in a sandboxed mission",
   *  ".env: not copied into a sandboxed mission"). */
  skipped: string[];
}

// ─── Missions ─────────────────────────────────────────────────────

/** A mission — the first-level unit of intent. The worktree is a property it
 *  chooses along two isolation axes; a code mission (build/fix) owns exactly one
 *  workspace, while design/probe missions may have none. */
export interface Mission {
  id: string;
  /** Null for missions with no worktree (design/probe). */
  workspaceId: string | null;
  projectId: string;
  /** build | fix | review | probe | design | perf | ops */
  intent: string;
  title: string;
  /** active | done | archived */
  status: string;
  linkedIssueKey: string | null;
  /** worktree | readonly | ephemeral | pr */
  gitIsolation: string;
  /** none | sandbox | container | cloud */
  execIsolation: string;
  payload: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** `update_mission`'s response: the mission, plus what "Share with new
 *  missions" had given its worktree and was taken back because its Execution
 *  became `sandbox`: links removed, env copies removed, and env copies kept
 *  because they changed in the mission. */
export interface UpdatedMission extends Mission {
  unlinked?: string[];
  uncopied?: string[];
  keptCopies?: string[];
}

// ─── Logbook ──────────────────────────────────────────────────────

export interface LogbookSurfaceSecs {
  surface: string;
  secs: number;
}

/** One Logbook row: worked hours (activity-span union) + cost + savings +
 *  counts for a mission over a period. */
export interface LogbookMissionRow {
  missionId: string;
  title: string;
  intent: string;
  status: string;
  hoursSecs: number;
  costUsd: number;
  savingsUsd: number;
  runsCount: number;
  messagesCount: number;
  perSurface: LogbookSurfaceSecs[];
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

/** Why a terminal wants the user: `idle` from the daemon's heuristic, or from
 *  Claude Code's own hooks (#287) `permission` (a tool use to approve) or
 *  `input` (it finished and is waiting on you). */
export type PtyAttentionReason = "idle" | "permission" | "input";

/** Payload of the `pty://attention` Tauri event. Emitted by the
 *  daemon when a session has been idle long enough after a
 *  meaningful burst of output to count as "waiting on the user", and
 *  by the Claude Code hook poller. */
export interface PtyAttentionEvent {
  sessionId: string;
  /** Absent only from a daemon older than the field. */
  reason?: PtyAttentionReason;
}

/** Payload of the `pty://settled` Tauri event: Claude Code's `Stop` hook
 *  reported that the session's turn ended. Never sent without the hooks. */
export interface PtySettledEvent {
  sessionId: string;
}

/** Payload of the `pty://foreground` Tauri event. Emitted when the PTY's
 *  foreground process flips between the shell (idle) and a running command —
 *  `busy` is true while a command executes. Drives the rail's processing bar. */
export interface PtyForegroundEvent {
  sessionId: string;
  busy: boolean;
  /** Short argv summary of the command that took the foreground ("npm run
   *  dev"). Present only on the transition into busy, and only where the
   *  platform could resolve it — `lib/sessionRole.ts` turns it into the
   *  session's role, and its absence simply means "unknown". */
  command?: string | null;
}

// ─── Chat ─────────────────────────────────────────────────────────

export interface ChatThread {
  id: string;
  workspaceId: string;
  /** The mission this thread belongs to, stamped when the thread is created.
   *  Null when the workspace had no mission at creation time. */
  missionId?: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
}

export interface SkillMeta {
  name: string;
  description: string;
  /** "project" or "user" — where the SKILL.md was found. */
  source: string;
}

/** A base64 image attachment for the chat composer. */
export interface Attachment {
  mediaType: string;
  data: string;
  name: string;
}

/** A tool exposed by a connected MCP server. */
export interface McpToolInfo {
  server: string;
  name: string;
  namespaced: string;
  description: string;
}

/** What Talk's MCP registry knows about one configured server
 *  (`list_mcp_server_status`): running with N tools, not started yet (it
 *  starts on first use), or failed with the first line of why. `tools` is
 *  null while a call holds the connection. */
export interface McpServerStatus {
  name: string;
  state: "connected" | "idle" | "failed";
  tools: number | null;
  reason: string | null;
}

/** One instruction file Talk and its sub-agents follow
 *  (`list_project_instructions`): a file of the workspace's CLAUDE.md chain,
 *  or its AGENTS.md when it has no CLAUDE.md. `label` is the path as the user
 *  knows it (`CLAUDE.md`, `~/.claude/CLAUDE.md`); `tokens` estimates what the
 *  file adds to each request; `trimmed` means it wasn't sent whole (with 0
 *  tokens: left out, the section was full); `skipped` names why a file was
 *  never read (`outside the project`, `over 4 MiB`). */
export interface InstructionFile {
  label: string;
  path: string;
  tokens: number;
  trimmed: boolean;
  skipped?: string | null;
}

/** What `list_project_instructions` answers: the files, and how many more
 *  skipped files there were past the 20 listed. */
export interface InstructionList {
  files: InstructionFile[];
  moreSkipped: number;
}

/** A configured MCP server (stdio): the command to spawn + its args/env. */
export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Env names whose values live in the login Keychain; their `env` value
   *  is "" and the secret itself never reaches the frontend. */
  secret_env?: string[];
  /** Env names that look secret but the user keeps in mcp.json. */
  plain_env?: string[];
  /** A remote server's choices; the backend builds the `mcp-remote` bridge
   *  in command/args/env from them (`mcp::remote::apply_bridge`). */
  remote?: McpRemoteConfig;
  /** Any other key of the entry (`cwd`, `type`, `disabled`…), kept as it
   *  was (the backend's `extra`). */
  [extra: string]: unknown;
}

/** How a remote MCP server is reached (`mcp::remote::RemoteConfig`). */
export interface McpRemoteConfig {
  url: string;
  /** Browser (OAuth), a bearer token, or the user's own headers. */
  auth: "oauth" | "token" | "headers";
  /** The custom headers' names (`auth: "headers"`). */
  header_names?: string[];
  transport: "auto" | "http-only" | "sse-only";
  /** A pre-registered OAuth client (`auth: "oauth"`). */
  client_id?: string;
  /** More mcp-remote arguments, appended as given. */
  extra_args?: string[];
}

/** Why Settings' Test or Reconnect failed (`mcp::classify_failure`), the
 *  payload of an `AppError` with `kind: "McpFailure"`. */
export interface McpFailure {
  /** One short line: what went wrong. */
  summary: string;
  /** What to do about it, when Octopush knows. */
  hint: string | null;
  /** The whole reason and server output, redacted. */
  detail: string;
}

export interface ChatMessage {
  id: number;
  workspaceId: string;
  role: "user" | "assistant" | "tool" | "error" | "stopped";
  content: string;
  model: string | null;
  /** Uncached input tokens summed over the turn's rounds. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Cache-aware cost of the turn (director rounds only; sub-agents bill
   *  their own rows). */
  costUsd: number | null;
  createdAt: string;
  /** Tokens served from the prompt cache over the turn's rounds. */
  cacheReadTokens?: number | null;
  /** Tokens written to the prompt cache over the turn's rounds. */
  cacheCreationTokens?: number | null;
  /** The size of the LAST prompt of the turn (uncached + cached + written)
   *  — what the context meter shows. */
  contextTokens?: number | null;
  /** A user row's `@` context blocks (`SentContextBlock[]` as JSON, #1150);
   *  absent on older rows. */
  contextBlocks?: string | null;
}

/** What one Talk conversation has cost so far, from the ledger (director
 *  rounds + sub-agent runs, cache-aware). `baselineUsd` is the same tokens
 *  priced on the strong tier — 0 when that tier is unpriced; unpriced calls
 *  are in neither figure. */
export interface ThreadCost {
  spentUsd: number;
  subagentsUsd: number;
  baselineUsd: number;
  strongPriced: boolean;
  calls: number;
  cacheHitPct: number | null;
  /** Calls whose model had no price — left out of `spentUsd` and
   *  `baselineUsd` (so out of the saving), named in `unpricedModels`. */
  unpricedCalls?: number;
  unpricedModels?: string[];
}

/** What the Claude Code session in one Run terminal has used
 *  (`transcripts::SessionUsage`, `get_session_usage`): the Run Companion's
 *  Context section. Octopush knows a terminal's session from Claude Code's
 *  hooks; spend and cache share come from the ledger, the context size from
 *  the session's own transcript. */
export interface SessionUsage {
  /** The session's last prompt: input + cache read + cache write. Null when
   *  the transcript can't say (gone, or compacted with no message since). */
  contextTokens: number | null;
  /** The model's context window from the provider catalog; null for a model
   *  the catalog doesn't list. */
  maxContext: number | null;
  /** Priced spend of the session's ledger rows. */
  spentUsd: number;
  /** Ledger rows (billed API calls) of the session. */
  calls: number;
  /** Those of `calls` on a model without a price, left out of `spentUsd`. */
  unpricedCalls: number;
  /** Share of the session's prompt tokens read from the cache, 0–100. */
  cacheHitPct: number | null;
  /** The model of the last prompt, else of the newest ledger row. */
  model: string;
  /** When that last message was written (RFC3339 UTC). */
  asOf: string;
}

/** One thing a project's requests carry (`request_context::CarriedItem`).
 *  Its `tokens` is always an estimate (bytes ÷ 4, fitted to the measured
 *  total). */
export interface CarriedItem {
  /** A CLAUDE.md-chain file (or one it imports), the skill or agent
   *  listings, or the measured total minus every other item. */
  kind: "memory" | "skills" | "agents" | "by_difference";
  /** `CLAUDE.md`, `~/.claude/CLAUDE.md`, `Skills`, `Agents`, or
   *  `MCP and built-in tools, by difference`. */
  label: string;
  /** The file's full path, for a `memory` item. */
  path: string | null;
  /** Skills or agents counted; 1 for a file, 0 for `by_difference`. */
  count: number;
  bytes: number;
  tokens: number;
}

/** What every request of a project carries (`get_request_context`, #959). */
export interface RequestContext {
  /** Measured: the smallest first-request prompt of the project's recent
   *  sessions. Null with no transcript to read. */
  measuredTokens: number | null;
  sessionsMeasured: number;
  /** The model of most first requests. */
  model: string | null;
  /** Share of the sampled sessions' prompt tokens read from cache, 0–100. */
  cacheHitPct: number | null;
  /** `measuredTokens` at the model's input price; null when unpriced. */
  uncachedUsd: number | null;
  /** `measuredTokens` at the input-side rate the model's requests actually
   *  paid; null when unpriced. */
  usualUsd: number | null;
  /** Largest first; they add up to `measuredTokens` when it is known. */
  items: CarriedItem[];
  /** Memory files named but never read (a project file pointing outside the
   *  project, a file over 4 MiB), at most 20. */
  skipped: { label: string; path: string; reason: string }[];
  /** Skipped files past those, counted. */
  moreSkipped: number;
}

export interface ChatStreamEvent {
  workspaceId: string;
  threadId?: string;
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
  operation: "merge" | "rebase" | "cherry-pick" | null;
  /** The commit HEAD points at (hex oid); null on an unborn branch. Optional
   *  so fixtures written before it still type-check. */
  head?: string | null;
}

/** Branches offered as a base for new workspaces. Locals come repo-default
 *  first; remotes are fully qualified (`origin/dev`) and pass through to the
 *  backend unchanged. */
export interface BranchList {
  local: string[];
  remote: string[];
  /** The repo's real default branch (origin/HEAD, else main/master); `local[0]` is only the checked-out one. */
  repoDefault?: string | null;
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
  /** CI checks on the head commit (open/draft PRs). Absent when the PR has
   *  none or they couldn't be read (no `gh`, no token). */
  checks?: PrChecks;
}

export type ChecksState = "passing" | "pending" | "failing";

export interface FailingCheck {
  name: string;
  /** The GitHub Actions run behind it, for `gh run view --log-failed`. */
  runId: number | null;
}

export interface PrChecks {
  state: ChecksState;
  failing: FailingCheck[];
}

/** @deprecated Use `Pr` instead. */
export type OpenPr = Pr;

/** A pull request candidate for "start a workspace from a PR"
 *  (from `list_prs`, backed by the GitHub CLI). */
export interface PrInfo {
  number: number;
  title: string;
  /** The PR's head branch name — becomes the workspace base after fetching. */
  headRefName: string;
  /** Author login; null for deleted accounts or when gh omits it. */
  author: string | null;
}

/** An open GitHub issue (the "Ship it" picker's source). */
export interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** What the PR composer drafts from (`pr_draft_context`): the branch's diff
 *  against the base (`git diff base...HEAD`), its commit subjects (newest
 *  first) and the repo's pull-request template, if it has one. */
export interface PrDraftContext {
  branch: string;
  diff: string;
  commits: string[];
  template: string | null;
}

/** Preflight for "Ship it": github.com origin + authenticated gh. */
export interface ShipReadiness {
  githubRemote: boolean;
  ghAuthenticated: boolean;
}

/** A branch and its open PR, from open_prs_for_project (rail PR indicator). */
export interface BranchPr {
  branch: string;
  pr: Pr;
}

/** A mission whose PR was merged at its worktree's HEAD, with a clean
 *  worktree (`merged_workspaces`, #963). `localFiles`: its git-ignored files
 *  other than dependency and build folders, which archiving deletes. */
export interface MergedWorkspace {
  workspaceId: string;
  pr: Pr;
  localFiles: string[];
}

/** Why `archive_merged_workspaces` left a mission in place: re-checked when
 *  it acts, the mission no longer passes. */
export type ArchiveSkipReason = "busy" | "changed" | "moved" | "local-files" | "unverified" | "gone" | "failed";

export interface MergedArchive {
  archived: string[];
  skipped: { workspaceId: string; reason: ArchiveSkipReason }[];
}

/** A single text-search hit (line-level match) within the workspace. */
export interface SearchHit {
  /** Path relative to the workspace root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based CHARACTER column where the match starts (not a byte offset —
   *  see `search_workspace_text`). Navigation uses `line`; nothing reads this
   *  yet. */
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

/** The user's two cloud-sync opt-ins — both **off** by default. */
export interface SyncPrefs {
  historySync: boolean;
  librarySync: boolean;
}

export type SyncKind = "history" | "library";

/** How the last push attempt for one sync kind ended. */
export type SyncAttemptOutcome = "sent" | "failed";

/** The last push attempt for one sync kind: time, outcome, count, HTTP status
 *  — nothing else is kept (#518). */
export interface SyncAttempt {
  /** RFC3339 UTC. */
  at: string;
  outcome: SyncAttemptOutcome;
  /** Runs (history) or library items in the attempt. */
  count: number;
  /** The non-2xx status of a failed request; absent for a network error. */
  httpStatus?: number | null;
}

/** A library item still unsent because the sync service refused it (or this
 *  Mac refused to send it for the same reason), #799. */
export interface LibraryRejection {
  kind: "pipeline" | "role" | string;
  /** Pipeline id or role key. */
  id: string;
  /** The service's reason code: `oversize`, `bad_stamp`, `future_stamp`, … */
  reason: string;
  /** The item's local name (filled in by `get_sync_status`). */
  name?: string | null;
}

/** The last attempt per kind (`get_sync_status`); `null` = nothing recorded,
 *  or that sync doesn't apply to the signed-in account. */
export interface SyncStatus {
  history: SyncAttempt | null;
  library: SyncAttempt | null;
  /** Library items the service refused; empty or absent when none. */
  libraryRejected?: LibraryRejection[];
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
  /** Tool-call rounds one Talk message may run before the model is asked to
   *  answer with what it has. Unset/null → **no limit**. */
  talkMaxIterations?: number | null;
  /** The engine a Talk turn runs on (#1143), settings.json only for now:
   *  unset → `legacy`; `v2` replays the append-only transcript. */
  talkEngine?: "legacy" | "v2";
  /** Run-mode attention from Claude Code's lifecycle hooks instead of the
   *  terminal bell (#287). Unset/null → **on**; only `false` turns it off. */
  claudeHooksEnabled?: boolean | null;
  /** Settings › Privacy › "Quiet Claude Code in crews and Routines" (#703):
   *  crew stages and Routines start Claude Code with
   *  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Unset → **off**. */
  quietClaudeCode?: boolean;
  /** Secret guard (#730): on unless saved `false`. */
  secretGuardEnabled?: boolean | null;
  /** The menu bar Octo (#718, Settings › General › "Show in menu bar"): on
   *  unless saved `false`. */
  menuBarEnabled?: boolean | null;
  /** Settings › General › Attention › "Notify me elsewhere" (#964). Unset →
   *  **off**. Owned by `set_notify_elsewhere`: whole-file saves carry it and
   *  the URL through untouched. */
  notifyElsewhereEnabled?: boolean;
  /** The webhook URL for "Notify me elsewhere" (validated before it is stored). */
  notifyElsewhereUrl?: string | null;
  /** Tool-call rounds one sub-agent run may take. Unset/null → **no limit**
   *  (a sub-agent runs until it finishes or is stopped); a definition's
   *  `max-turns` applies under a set value. */
  subagentMaxTurns?: number | null;
  /** Provider-agnostic model tiers (`fast` / `balanced` / `strong`) → a
   *  configured model id. What a sub-agent's `model: haiku` or `model: "fast"`
   *  resolves to on this machine. */
  modelTiers?: Record<string, string> | null;
  /** Jira/issue-tracker connection config (preserved across saves). */
  issueTracker?: IssueTrackerConfig | null;
  /** Cloud run-history sync opt-in (default off). Owned by `set_sync_pref` —
   *  read-modify-write saves carry it through untouched. */
  historySyncEnabled?: boolean;
  /** Cloud Library sync opt-in (default off). Owned by `set_sync_pref`. */
  librarySyncEnabled?: boolean;
  /** Update channel. Owned by `set_update_channel` — carried through saves. */
  updateChannel?: "stable" | "beta";
  /** Version skipped in the launch alert. Owned by `set_skipped_update_version`. */
  skippedUpdateVersion?: string | null;
  /** @deprecated use providerKeys.anthropic */
  anthropicApiKey?: string | null;
  /** @deprecated use providerKeys.openai */
  openaiApiKey?: string | null;
}

/** "Notify me elsewhere" (#964) as saved: off, with no URL, by default. */
export interface NotifyElsewhere {
  enabled: boolean;
  url: string;
}

/** The one body the webhook receives — exactly these five keys. */
export interface NotifyElsewherePayload {
  text: string;
  content: string;
  mission: string;
  project: string;
  event: string;
}

/** The Settings preview: the body's fields for a checkpoint gate (sample names)
 *  and every `event` value with its label. */
export interface NotifyElsewherePreview {
  payload: NotifyElsewherePayload;
  events: { event: string; label: string }[];
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

// ─── Collision radar (#732) ────────────────────────────────────────

/** `lockfile`: only lockfiles overlap · `overlap`: the same file changes on
 *  both sides · `conflict`: an in-memory merge confirmed a conflict. */
export type CollisionSeverity = "lockfile" | "overlap" | "conflict";

/** Two live workspaces of one project changing the same files. */
export interface Collision {
  a: string;
  aName: string;
  b: string;
  bName: string;
  /** The overlapping paths, sorted; at most 50 cross IPC. */
  files: string[];
  /** Overlapping paths left out of `files`. */
  truncated: number;
  /** The conflicting non-lockfile paths, sorted; at most 50. */
  conflictingFiles: string[];
  /** Conflicting paths left out of `conflictingFiles`. */
  conflictingTruncated: number;
  severity: CollisionSeverity;
  confirmed: boolean;
}

export interface ProjectCollisions {
  collisions: Collision[];
  scanned: number;
  /** The merge-confirmation pair cap was hit: some pairs are overlap only. */
  capped: boolean;
  /** A workspace's uncommitted set hit its 2000-path cap: overlaps past it may be missing. */
  uncommittedCapped: boolean;
}

// ─── Usage report (Settings → Usage) ───────────────────────────────

export type UsageSurface = "talk" | "run" | "review" | "direct" | "adhoc";

/** One aggregate of the spend ledger. `cacheHitPct` is
 *  cache_read / (input + cache_read + cache_create) × 100 — a cache write
 *  is a miss — and null when no row reported cache data. */
export interface UsageSlice {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  calls: number;
  cacheHitPct: number | null;
  cacheTracked: boolean;
}

export interface SurfaceUsage extends UsageSlice {
  surface: string;
}

export interface ModelUsage extends UsageSlice {
  model: string;
  /** Calls of this model the ledger could not price (unknown model) —
   *  shown as "unpriced", never "$0.00". */
  unpricedCalls?: number;
}

export interface SourceUsage extends UsageSlice {
  id: string;
  label: string;
  kind: "workspace" | "session" | "other";
  project: string | null;
  lastTs: string;
  surfaces: Array<{ surface: string; costUsd: number }>;
}

export interface UsageTrendPoint {
  /** Local-time bucket: `YYYY-MM-DDTHH:00` (hour) or `YYYY-MM-DD` (day). */
  bucket: string;
  costUsd: number;
  tokens: number;
}

export interface UsageReport {
  start: string;
  end: string;
  surface: string | null;
  totals: UsageSlice;
  bySurface: SurfaceUsage[];
  byModel: ModelUsage[];
  bySource: SourceUsage[];
  trend: UsageTrendPoint[];
  trendBucket: "hour" | "day";
  activeDays: number;
  perActiveDayUsd: number;
  last24hUsd: number;
  unpricedCalls: number;
  pricingRefreshedAt: string | null;
}

// ─── Gateway reconciliation (Settings → Usage) ────────────────────

export interface GatewayIdentity {
  /** `litellm` — the implementation's id. */
  kind: string;
  /** What the UI calls it (`LiteLLM`). */
  label: string;
  host: string;
  /** The Octopush provider whose base URL is this gateway. */
  provider: string;
  keyAlias: string | null;
  keyHash: string | null;
  /** The key's running spend since its last budget reset. */
  keySpendUsd: number | null;
  keyMaxBudgetUsd: number | null;
  budgetResetAt: string | null;
}

export interface GatewayModelSpend {
  model: string;
  costUsd: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ReconciledModel {
  model: string;
  gatewayCostUsd: number;
  gatewayRequests: number;
  ledgerCostUsd: number;
  ledgerCalls: number;
}

/** What the gateway billed the key over the page's period against what the
 *  ledger recorded. `null` from the IPC when no provider is a gateway. */
export interface GatewayReconciliation {
  gateway: GatewayIdentity;
  start: string;
  end: string;
  gatewayCostUsd: number;
  gatewayRequests: number;
  /** Prompt + completion as the gateway counts them (cache included). */
  gatewayTokens: number;
  ledgerCostUsd: number;
  ledgerCalls: number;
  /** All four buckets, comparable with the gateway's count. */
  ledgerTokens: number;
  unaccountedCostUsd: number;
  unaccountedRequests: number;
  byModel: ReconciledModel[];
  /** Ledger models with no gateway counterpart — left out of the totals. */
  ledgerOnlyModels: string[];
  /** With `logs` basis: gateway requests whose id is in no ledger row. */
  unmatchedRequests: number | null;
  unmatchedCostUsd: number | null;
  unmatchedByModel: GatewayModelSpend[];
  /** `logs` (per request) · `daily` (whole UTC days — the gateway's daily
   *  tables or its per-day summary of the logs; `note` says which and what is
   *  missing) · `key` (running total only). */
  basis: "logs" | "daily" | "key";
  note: string | null;
  fetchedAt: string;
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
  /** Ledger rows recorded at $0 (unpriced model) that got a price now. */
  eventsRepriced?: number;
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
  /** Boundary colour for interactive chrome — input outlines, control edges,
   *  the focus ring. Held apart from `border` because WCAG 1.4.11's 3:1 applies
   *  to controls, not to the hairlines that merely divide panels. */
  borderStrong: string;
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
  /** The builtin model that replaces this one (Fable 5.1 → Fable 5.2);
   *  absent for every other model. The launcher offers the switch. */
  supersededBy?: string | null;
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
