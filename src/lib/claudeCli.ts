// The installed Claude Code CLI's version against the floor Octopush is
// tested with (`agent_adapter::TESTED_CLAUDE_FLOOR`). An old CLI is a warning
// in Settings › Integrations and the Direct launcher — it never blocks a run.
import { ipc, type ClaudeCliVersion } from "./ipc";

/** Why an old CLI matters, in one line (shared by every surface that warns). */
export const CLAUDE_UPDATE_REASON =
  "Older releases can record wrong token usage, which skews costs, and skip sandbox rules on resumed sessions.";

/** "Update Claude Code (x.y.z or newer recommended)" — or null when the
 *  version is current or unknown. */
export function claudeUpdateLabel(info: ClaudeCliVersion | null): string | null {
  if (!info || !info.version || !info.belowFloor) return null;
  return `Update Claude Code (${info.floor} or newer recommended)`;
}

/** Mirrors `cli_runner::dialect_for_model`: OpenAI-family ids run on Codex
 *  CLI, everything else on Claude Code. */
export function runsOnClaudeCode(model: string): boolean {
  const m = model.toLowerCase();
  return !(m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.includes("codex"));
}

/** True when any CLI stage of the crew (with the launcher's per-position
 *  model overrides applied) will run on Claude Code. */
export function crewUsesClaudeCode(
  stages: { position: number; substrate: string; agentModel: string }[],
  overrides: Record<number, string>,
): boolean {
  return stages.some((s) => s.substrate === "cli" && runsOnClaudeCode(overrides[s.position] || s.agentModel));
}

let cached: Promise<ClaudeCliVersion | null> | null = null;

/** The version, fetched once per app session (the backend caches the probe
 *  too). A failed call resolves to null and is retried next time. */
export function loadClaudeCliVersion(): Promise<ClaudeCliVersion | null> {
  if (!cached) {
    cached = Promise.resolve().then(() => ipc.claudeCliVersion()).catch(() => {
      cached = null;
      return null;
    });
  }
  return cached;
}

/** Test hook: forget the cached version. */
export function resetClaudeCliVersionCache(): void {
  cached = null;
}
