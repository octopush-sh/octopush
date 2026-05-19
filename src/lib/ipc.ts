// Thin typed wrappers around Tauri's `invoke` for the Octopus core.

import { invoke } from "@tauri-apps/api/core";
import type {
  AdapterInfo,
  AppSettings,
  Budget,
  BudgetPeriod,
  BudgetScope,
  BudgetStatus,
  ChatMessage,
  CreateSessionArgs,
  DirectoryEntry,
  GitStatus,
  ModelSuggestion,
  ModelWithProvider,
  ProjectInfo,
  ProviderConfig,
  PtySession,
  Session,
  SessionRecap,
  SessionTemplate,
  SpendSnapshot,
  TaskType,
  TerminalRecord,
  ThemeConfig,
  TintName,
  TokenEvent,
  TokenReport,
  Workspace,
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

  // ─── Workspaces ─────────────────────────────────────────────────
  createWorkspace: (projectId: string, projectPath: string, name: string, task: string,
                    branch: string, fromBranch: string, setupScript: string) =>
    invoke<Workspace>("create_workspace", { projectId, projectPath, name, task, branch, fromBranch, setupScript }),
  listWorkspaces: (projectId: string) => invoke<Workspace[]>("list_workspaces", { projectId }),
  deleteWorkspace: (workspaceId: string, projectPath: string, branch: string, worktreePath: string | null) =>
    invoke<void>("delete_workspace", { workspaceId, projectPath, branch, worktreePath }),
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
};
