// Thin typed wrappers around Tauri's `invoke` for the Octopus core.

import { invoke } from "@tauri-apps/api/core";
import type {
  AdapterInfo,
  AppSettings,
  BudgetStatus,
  ChatMessage,
  CreateSessionArgs,
  GitStatus,
  ModelSuggestion,
  ModelWithProvider,
  ProjectInfo,
  Session,
  SessionRecap,
  SessionTemplate,
  TaskType,
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

  // ─── Settings ─────────────────────────────────────────────────
  getSettings: () =>
    invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) =>
    invoke<void>("save_settings", { settings }),
};
