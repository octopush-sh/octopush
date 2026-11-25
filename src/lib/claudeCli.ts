// The installed Claude Code CLI's version against the floor Octopush is
// tested with (`agent_adapter::TESTED_CLAUDE_FLOOR`) and the security fixes it
// may lack (`CLAUDE_SECURITY_FIXES`). An old CLI is a warning in Settings ›
// Integrations and the Direct launcher — it never blocks a run.
import { ipc, type ClaudeCliVersion, type ClaudeModelFloorNote, type PipelineWithStages, type RecommendedFix, type Routine } from "./ipc";
import { routineOverrides } from "./modelRetirement";
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
 *  model the catalog doesn't know. Empty = a non-reasoning model. Matched
 *  like Codex does: the longest slug that prefixes the id (`gpt-5.5-<date>`
 *  → `gpt-5.5`), then once more with one leading `namespace/` stripped. */
export function codexEffortLevels(model: string): readonly string[] | undefined {
  const table = codexCatalog.models as Record<string, readonly string[]>;
  const longestPrefix = (id: string) => {
    const slug = Object.keys(table)
      .filter((s) => id.startsWith(s))
      .reduce<string | undefined>((best, s) => (best === undefined || s.length > best.length ? s : best), undefined);
    return slug === undefined ? undefined : table[slug];
  };
  const id = model.trim().toLowerCase();
  const slash = id.indexOf("/");
  return longestPrefix(id) ?? (slash >= 0 ? longestPrefix(id.slice(slash + 1)) : undefined);
}

/** The level a Codex CLI stage actually gets (mirrors
 *  `cli_runner::codex_effort_level`): the effort when the model lists it,
 *  else the highest listed level below it (the lowest listed if none is
 *  below); null — no override, Codex's own default — for a model the catalog
 *  doesn't know or one without reasoning. */
export function codexEffortLevel(model: string, effort: string): string | null {
  const listed = codexEffortLevels(model);
  return listed ? clampToListedLevels(listed, effort) : null;
}

/** `codexEffortLevel`'s clamp on an explicit level list (mirrors
 *  `cli_runner::clamp_to_listed_levels`): null when the list holds none of
 *  Octopush's levels (a non-reasoning model). */
export function clampToListedLevels(listed: readonly string[], effort: string): string | null {
  const supported = EFFORT_ORDER.filter((e) => listed.includes(e));
  const rank = EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  const below = supported.filter((e) => EFFORT_ORDER.indexOf(e) <= rank);
  return below[below.length - 1] ?? supported[0] ?? null;
}

/** The tooltip for an effort segment that Codex runs as another level on a
 *  model listing `listed` ("Runs as XHi on this model in Codex, the highest
 *  level it lists below Max", or "…, the lowest level it lists" when clamped
 *  up); null when the level passes as is or nothing passes. `label` names a
 *  level the way the segments do. */
export function codexClampTitle(listed: readonly string[], effort: string, label: (level: string) => string): string | null {
  const runs = clampToListedLevels(listed, effort);
  if (!runs || runs === effort) return null;
  const up = EFFORT_ORDER.indexOf(runs as (typeof EFFORT_ORDER)[number]) > EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  const why = up ? "the lowest level it lists" : `the highest level it lists below ${label(effort)}`;
  return `Runs as ${label(runs)} on this model in Codex, ${why}`;
}

/** True when any CLI stage of the crew (with the launcher's per-position
 *  model overrides applied) will run on Claude Code. */
export function crewUsesClaudeCode(
  stages: { position: number; substrate: string; agentModel: string }[],
  overrides: Record<number, string>,
): boolean {
  return stages.some((s) => s.substrate === "cli" && runsOnClaudeCode(overrides[s.position] || s.agentModel));
}

/** Whether any CLI stage of the crew (with the launcher's overrides) runs on Codex. */
export function crewUsesCodex(
  stages: { position: number; substrate: string; agentModel: string }[],
  overrides: Record<number, string>,
): boolean {
  return stages.some((s) => s.substrate === "cli" && !runsOnClaudeCode(overrides[s.position] || s.agentModel));
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

/** Whether a saved crew, or a Routine with its model overrides, has a Claude
 *  Code CLI stage (its model or its escalation model). */
export function libraryUsesClaudeCode(pipelines: PipelineWithStages[], routines: Routine[]): boolean {
  if (pipelines.some((p) => crewClaudeModels(p.stages, {}).length > 0)) return true;
  return routines.some((r) => {
    const crew = pipelines.find((p) => p.pipeline.id === r.pipelineId);
    return !!crew && crewClaudeModels(crew.stages, routineOverrides(r.stageOverrides)).length > 0;
  });
}

/** The Readiness card's Claude Code note: every missing fix whose audience is
 *  there (`run` while a Run-mode session runs Claude Code; `any` then, or
 *  while a crew or Routine has a Claude Code CLI stage), oldest first. Null
 *  when none shows. Never a verdict. */
export function claudeRecommendedNote(
  fixes: RecommendedFix[] | undefined,
  where: { inRun: boolean; inCrews: boolean },
): string | null {
  const shown = (fixes ?? []).filter((f) => where.inRun || (f.audience === "any" && where.inCrews));
  if (shown.length === 0) return null;
  if (shown.length === 1) return `Recommended: Claude Code ${shown[0].version} ${shown[0].reason}.`;
  const newest = shown[shown.length - 1].version;
  return `Recommended: Claude Code ${newest}. ${shown.map((f) => `${f.version} ${f.reason}.`).join(" ")}`;
}

/** "Ship runs on Codex, whose sandbox keeps .git read-only, so it can't
 *  commit or push. Pick a Claude model for it." — for the crew's Action-role
 *  CLI stages (they may commit and push) that will run on Codex outside a
 *  sandboxed mission; null when there are none. Only a Claude model is
 *  recommended until a sandboxed Codex mission is checked on a Mac (#784).
 *  Mirrors `cli_runner::codex_git_notice`. */
export function codexCommitNote(
  stages: { position: number; role: string; substrate: string; agentModel: string; customName?: string | null }[],
  overrides: Record<number, string>,
  roles: { key: string; label: string; environment: string }[],
  execIsolation: string | null,
): string | null {
  if (execIsolation === "sandbox") return null;
  const names = stages
    .filter((s) => s.substrate === "cli" && !runsOnClaudeCode(overrides[s.position] || s.agentModel))
    .flatMap((s) => {
      const role = roles.find((r) => r.key === s.role);
      if (role?.environment !== "action") return [];
      return [s.customName?.trim() || role.label || s.role];
    });
  if (names.length === 0) return null;
  const one = names.length === 1;
  const who = one ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${who} ${one ? "runs" : "run"} on Codex, whose sandbox keeps .git read-only, so ${one ? "it" : "they"} can't commit or push. Pick a Claude model for ${one ? "it" : "them"}.`;
}

/** The launcher's warning, and the stage failure, for a read-only Codex
 *  stage in a sandboxed mission. Mirrors
 *  `cli_runner::CODEX_READ_ONLY_SANDBOX_REFUSAL`. */
export const CODEX_READ_ONLY_SANDBOX_NOTE =
  "A read-only Codex stage can't run in a sandboxed mission yet. Give this stage a Claude model.";

/** The warning for a crew with a read-only CLI stage (a review role in the
 *  worktree environment) on Codex, in a mission that runs sandboxed (its own
 *  choice, or a readonly mission, which forces the sandbox on): Codex's own
 *  read-only sandbox can't run inside Octopush's, so the stage is refused at
 *  launch. Null otherwise. Mirrors `cli_runner::codex_read_only_refusal`. */
export function codexReadOnlySandboxNote(
  stages: { position: number; role: string; substrate: string; agentModel: string }[],
  overrides: Record<number, string>,
  roles: { key: string; artifactKind?: string; environment: string }[],
  execIsolation: string | null,
  gitIsolation: string | null,
): string | null {
  if (execIsolation !== "sandbox" && gitIsolation !== "readonly") return null;
  const refused = stages.some((s) => {
    if (s.substrate !== "cli" || runsOnClaudeCode(overrides[s.position] || s.agentModel)) return false;
    const role = roles.find((r) => r.key === s.role);
    return role?.artifactKind === "review" && role.environment === "worktree";
  });
  return refused ? CODEX_READ_ONLY_SANDBOX_NOTE : null;
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
