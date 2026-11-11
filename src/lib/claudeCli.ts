// The installed Claude Code CLI's version against the floor Octopush is
// tested with (`agent_adapter::TESTED_CLAUDE_FLOOR`) and the security fixes it
// may lack (`CLAUDE_SECURITY_FIXES`). An old CLI is a warning in Settings ›
// Integrations and the Direct launcher — it never blocks a run.
import { ipc, type ClaudeCliVersion, type ClaudeModelFloorNote } from "./ipc";
import codexCatalog from "./codexEffortLevels.json";

/** Why an old CLI matters, in one line (shared by every surface that warns). */
export const CLAUDE_UPDATE_REASON =
  "Older releases can record wrong token usage, which skews costs, and skip sandbox rules on resumed sessions.";

/** "Update Claude Code (x.y.z or newer recommended)" — or null when the
 *  version is current or unknown. x.y.z is the higher of the floor and the
 *  security fix the CLI lacks, so following it clears both notes. */
export function claudeUpdateLabel(info: ClaudeCliVersion | null): string | null {
  if (!info || !info.version || !info.belowFloor) return null;
  return `Update Claude Code (${info.recommended ?? info.floor} or newer recommended)`;
}

/** "Update Claude Code: 2.1.319 fixes a sandbox escape when creating a
 *  worktree" — only when the tested-floor label doesn't already show, and
 *  never for an unknown version. */
export function claudeSecurityLabel(info: ClaudeCliVersion | null): string | null {
  if (!info?.version || !info.securityFix || claudeUpdateLabel(info)) return null;
  return `Update Claude Code: ${info.securityFix.version} ${info.securityFix.reason}`;
}

/** Mirrors `cli_runner::dialect_for_model`: OpenAI-family ids run on Codex
 *  CLI, everything else on Claude Code. */
export function runsOnClaudeCode(model: string): boolean {
  const m = model.toLowerCase();
  return !(m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.includes("codex"));
}

/** Mirrors `cli_runner::effort_applies`: a stage's reasoning effort reaches
 *  the agent on the API, and on a CLI stage in either dialect — Claude Code
 *  as `--effort <level>`, Codex as `-c model_reasoning_effort="<level>"` but
 *  only on a model whose levels Codex's catalog lists (see
 *  `codexEffortLevel`). The model picks the dialect. */
export function effortApplies(substrate: string, model: string): boolean {
  if (substrate === "api") return true;
  if (substrate !== "cli") return false;
  return runsOnClaudeCode(model) || (codexEffortLevels(model)?.length ?? 0) > 0;
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

/** The levels Codex lists for `model` in its bundled catalog
 *  (`codexEffortLevels.json`, shared with `cli_runner::codex_effort_levels`,
 *  which cites the openai/codex `models.json` commit), or undefined for a
 *  model the catalog doesn't know. Empty = a non-reasoning model. */
export function codexEffortLevels(model: string): readonly string[] | undefined {
  const table = codexCatalog.models as Record<string, readonly string[]>;
  const key = model.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The level a Codex CLI stage actually gets (mirrors
 *  `cli_runner::codex_effort_level`): the effort when the model lists it,
 *  else the highest listed level below it (the lowest listed if none is
 *  below); null — no override, Codex's own default — for a model the catalog
 *  doesn't know or one without reasoning. */
export function codexEffortLevel(model: string, effort: string): string | null {
  const listed = codexEffortLevels(model);
  if (!listed) return null;
  const supported = EFFORT_ORDER.filter((e) => listed.includes(e));
  const rank = EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  const below = supported.filter((e) => EFFORT_ORDER.indexOf(e) <= rank);
  return below[below.length - 1] ?? supported[0] ?? null;
}

/** True when any CLI stage of the crew (with the launcher's per-position
 *  model overrides applied) will run on Claude Code. */
export function crewUsesClaudeCode(
  stages: { position: number; substrate: string; agentModel: string }[],
  overrides: Record<number, string>,
): boolean {
  return stages.some((s) => s.substrate === "cli" && runsOnClaudeCode(overrides[s.position] || s.agentModel));
}

/** Every model a Claude Code CLI stage of the crew may launch — its model
 *  (with the launcher's overrides) and its escalation model — deduplicated. */
export function crewClaudeModels(
  stages: { position: number; substrate: string; agentModel: string; escalateModel?: string | null }[],
  overrides: Record<number, string>,
): string[] {
  const models = stages
    .filter((s) => s.substrate === "cli")
    .flatMap((s) => [overrides[s.position] || s.agentModel, s.escalateModel ?? ""])
    .filter((m) => m && runsOnClaudeCode(m));
  return [...new Set(models)];
}

/** "Fable 5.2 needs Claude Code 2.1.321 or newer — this Mac has 2.1.316." */
export function modelFloorLabel(note: ClaudeModelFloorNote | null): string | null {
  if (!note) return null;
  return `${note.label} needs Claude Code ${note.needs} or newer — this Mac has ${note.installed}.`;
}

/** True when the installed Claude Code is known to be older than the tested
 *  floor — the backend then drops `--effort`, so the effort controls hide.
 *  An unknown version never hides them. */
export function cliTooOldForEffort(info: ClaudeCliVersion | null): boolean {
  return !!info?.version && info.belowFloor;
}

let cached: Promise<ClaudeCliVersion | null> | null = null;

/** The version, fetched once and kept until the Readiness card re-probes
 *  (the backend caches the probe too, until then). A failed call resolves to
 *  null and is retried next time. */
export function loadClaudeCliVersion(): Promise<ClaudeCliVersion | null> {
  if (!cached) {
    cached = Promise.resolve().then(() => ipc.claudeCliVersion()).catch(() => {
      cached = null;
      return null;
    });
  }
  return cached;
}

/** Forget the cached version, so the next surface that opens asks again
 *  (after a Readiness check, which also clears the backend's cache). */
export function resetClaudeCliVersionCache(): void {
  cached = null;
}
