// Thin typed wrappers around Tauri's `invoke` for the Octopus core.

import { invoke } from "@tauri-apps/api/core";
import type {
  AdapterInfo,
  BudgetStatus,
  CreateSessionArgs,
  ModelSuggestion,
  ModelWithProvider,
  Session,
  SessionTemplate,
  TaskType,
  TokenEvent,
  TokenReport,
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
    invoke<Session>("switch_agent", { sessionId, newModel }),
};
