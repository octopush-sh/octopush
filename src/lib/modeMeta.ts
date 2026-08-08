// The mode band's status tail — one short, glanceable line per mode, telling
// the user what the room they are looking at currently holds. Kept pure (no
// stores, no React) so App stays the only place that reads state and the
// wording stays unit-testable.

import type { WorkspaceMode } from "./modes";

export interface DiffStat {
  added: number;
  removed: number;
}

/** What the crew is doing in this workspace, as far as the tail cares. */
export type RunTailState = "none" | "running" | "paused" | "settled";

export interface ModeMetaInput {
  /** Terminals open in the active workspace (Run). */
  terminalCount: number;
  /** Prompt tokens of the last assistant turn, and the model's ceiling (Talk). */
  tokensUsed: number;
  tokensLimit: number;
  /** Changed files in the worktree (Review). */
  changedCount: number;
  /** Added/removed line counts of the working diff (Review). Zeroes outside
   *  review mode — App only fetches the diff there. */
  diffStat: DiffStat;
  /** The crew's state for this workspace (Direct). */
  runState: RunTailState;
}

/** Added/removed line counts from a unified diff. The `+++`/`---` file headers
 *  are skipped, so every file in the diff would otherwise inflate both counts
 *  by one. */
export function diffStat(diff: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Collapses a workspace's runs into the one word the tail shows. "running"
 *  wins over "paused": an in-flight crew is the more current fact, and the
 *  paused one already has the attention beacon. */
export function runTailState(
  runs: readonly { status: string }[] | undefined,
): RunTailState {
  if (!runs || runs.length === 0) return "none";
  if (runs.some((r) => r.status === "running")) return "running";
  if (runs.some((r) => r.status === "paused")) return "paused";
  return "settled";
}

/** Compact token count: 34120 → "34k", 980 → "980". Deliberately not
 *  `stageMeta.fmtTokens` — that one keeps a decimal ("34.1k") for the Direct
 *  surfaces and pulls the roles store in with it; the tail wants the shortest
 *  honest number and no store dependency. */
function compactTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** The status tail for a mode, or null when there is nothing worth saying —
 *  a null tail renders nothing rather than an empty slot. */
export function modeMetaLabel(mode: WorkspaceMode, input: ModeMetaInput): string | null {
  switch (mode) {
    case "run": {
      const n = input.terminalCount;
      if (n <= 0) return "No terminals";
      return n === 1 ? "1 terminal" : `${n} terminals`;
    }
    case "talk": {
      // Before the first assistant turn there is no context to report.
      if (input.tokensUsed <= 0 || input.tokensLimit <= 0) return null;
      return `${compactTokens(input.tokensUsed)} / ${compactTokens(input.tokensLimit)} context`;
    }
    case "review": {
      const { changedCount, diffStat: stat } = input;
      if (changedCount <= 0) return "Nothing to review";
      const files = changedCount === 1 ? "1 file changed" : `${changedCount} files changed`;
      if (stat.added === 0 && stat.removed === 0) return files;
      return `${files} · +${stat.added} −${stat.removed}`;
    }
    case "direct": {
      switch (input.runState) {
        case "running":
          return "Crew running";
        case "paused":
          return "Crew waiting on you";
        case "settled":
          return "Crew idle";
        case "none":
          return "No runs yet";
      }
    }
  }
}
