// Named surfaces a guided tour or a recorded demo can open before a step
// (`open:` in a whats-new changeset — docs/WHATS-NEW.md §3).
//
// Navigation state lives in App.tsx (settings tab, workspace mode, overlays),
// so surfaces don't reach into it: they dispatch an `octo:navigate` event that
// App.tsx handles. The keys of SURFACES are the public names; the changeset
// validator (scripts/whats-new.mjs) reads them from this file, so keep each key
// a quoted string literal.
import type { SettingsTab } from "../settingsTabs";
import type { WorkspaceMode } from "../modes";

export const NAVIGATE_EVENT = "octo:navigate";

export type NavigateDetail =
  | { kind: "settings"; tab: SettingsTab }
  | { kind: "close-settings" }
  | { kind: "mode"; mode: WorkspaceMode }
  | { kind: "palette" }
  | { kind: "mission-control" }
  | { kind: "logbook" };

export function navigate(detail: NavigateDetail): void {
  window.dispatchEvent(new CustomEvent<NavigateDetail>(NAVIGATE_EVENT, { detail }));
}

const settings = (tab: SettingsTab) => () => navigate({ kind: "settings", tab });
const mode = (m: WorkspaceMode) => () => navigate({ kind: "mode", mode: m });

export const SURFACES: Record<string, () => void> = {
  "settings/general": settings("general"),
  "settings/editor": settings("editor"),
  "settings/models": settings("models"),
  "settings/routines": settings("routines"),
  "settings/appearance": settings("appearance"),
  "settings/usage": settings("usage"),
  "settings/shortcuts": settings("shortcuts"),
  "settings/privacy": settings("privacy"),
  "settings/integrations": settings("integrations"),
  "settings/account": settings("account"),
  "settings/about": settings("about"),
  "mode/talk": mode("talk"),
  "mode/run": mode("run"),
  "mode/review": mode("review"),
  "mode/direct": mode("direct"),
  "palette": () => navigate({ kind: "palette" }),
  "mission-control": () => navigate({ kind: "mission-control" }),
  "logbook": () => navigate({ kind: "logbook" }),
};

/** Open a named surface. Returns false for an unknown name (the step is then skipped). */
export function openSurface(name: string): boolean {
  const open = SURFACES[name];
  if (!open) return false;
  open();
  return true;
}
