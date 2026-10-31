// Demo-clip harness entry (clips.html) — NOT part of the app bundle: only
// clips.html loads it, and `vite build` builds index.html alone.
//
// Runs the real App in a plain browser with Tauri IPC mocked from a scenario
// fixture (scripts/clips/scenarios/), so scripts/clips/record.mjs can record
// demo clips of real UI. URL: /clips.html?octo-record=1&scenario=<name>
//
// Exposes `window.__octoClips` to the recorder:
//   ready        — true once App has mounted
//   scenario     — the scenario name in use
//   log          — { calls, defaulted, failed } (see ./dispatcher)
//   openSurface  — the real named-surface registry (src/lib/tour/surfaces.ts)
//   emit         — fire a backend event at the app's listeners
import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { SCENARIOS } from "../../scripts/clips/scenarios";
import { createDispatcher, type CallLog } from "./dispatcher";
import "../styles.css";

declare global {
  interface Window {
    __octoClips?: {
      ready: boolean;
      scenario: string;
      log: CallLog;
      openSurface: (name: string) => boolean;
      emit: (event: string, payload?: unknown) => Promise<void>;
      error?: string;
    };
  }
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get("scenario") ?? "default";
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario "${name}" (have: ${Object.keys(SCENARIOS).join(", ")})`);
  if (params.get("octo-record") === "1") document.documentElement.dataset.octoRecord = "1";

  // Each load starts from exactly the scenario's storage — no leftovers.
  try {
    localStorage.clear();
    for (const [k, v] of Object.entries(scenario.localStorage ?? {})) localStorage.setItem(k, v);
  } catch {
    /* storage blocked — the app copes */
  }

  // Mocks must exist before any store module loads: some subscribe to backend
  // events at import time.
  mockWindows("main");
  mockConvertFileSrc("macos");
  const { handle, log } = createDispatcher(scenario);
  mockIPC(handle, { shouldMockEvents: true });

  const [{ default: App }, { openSurface }] = await Promise.all([
    import("../App"),
    import("../lib/tour/surfaces"),
  ]);
  window.__octoClips = { ready: false, scenario: name, log, openSurface, emit: (e, p) => emit(e, p) };

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </React.StrictMode>,
  );
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (window.__octoClips) window.__octoClips.ready = true;
  }));
}

boot().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[clips] harness failed:", msg);
  window.__octoClips = { ready: false, scenario: "", log: { calls: {}, defaulted: [], failed: [] }, openSurface: () => false, emit: async () => {}, error: msg };
});
