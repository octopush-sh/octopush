// `empty` — a fresh install: no projects, signed out, free plan, nothing configured.
import type { Scenario } from "./types";
import type { AuthStatus, Entitlement } from "../../../src/lib/ipc";
import type { AppSettings, PerfStats, SyncPrefs, TokenReport } from "../../../src/lib/types";
import { ATELIER } from "./shared";

const MB = 1024 * 1024;

export const empty: Scenario = {
  name: "empty",
  description: "Fresh install — no projects, signed out, free plan.",
  commands: {
    get_theme: ATELIER,
    list_themes: [ATELIER],
    list_recent_projects: [],
    list_closed_projects: [],
    get_settings: { providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} } satisfies AppSettings,
    auth_status: { signedIn: false, email: null, name: null } satisfies AuthStatus,
    get_entitlement: { plan: "free", features: [], directRunsPerMonth: 5 } satisfies Entitlement,
    direct_run_usage: { used: 0, limit: 5, remaining: 5 },
    get_sync_prefs: { historySync: false, librarySync: false } satisfies SyncPrefs,
    has_ever_started_run: false,
    list_providers: [],
    list_models: [],
    sketchbook_path: "/Users/dev/.octopush/sketchbook",
    get_token_report: {
      totalInput: 0, totalOutput: 0, totalCached: 0, totalCostUsd: 0,
      costBySession: [], costByModel: [], hourlyTrend: [], budgetRemaining: null, projectedDailyCost: 0,
    } satisfies TokenReport,
    get_perf_stats: {
      app: { rssBytes: 180 * MB, cpuPct: 1.1, processCount: 3 },
      daemon: { rssBytes: 24 * MB, cpuPct: 0.2, processCount: 1 },
      total: { rssBytes: 204 * MB, cpuPct: 1.3, processCount: 4 },
      disk: { freeBytes: 312 * 1024 * MB, totalBytes: 1000 * 1024 * MB },
      ts: 0,
    } satisfies PerfStats,
  },
};
