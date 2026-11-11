export interface HaltCause {
  title: string;
  remedy?: string;
  /** Re-run is the primary action even when the session can be resumed. */
  preferRerun?: boolean;
}

/** The markers `parse_cli_result` (cli_runner.rs) puts on a hook-deferred tool call. */
const DEFERRED_MARKERS = ["(terminal_reason: tool_deferred)", "(terminal_reason: tool_deferred_unavailable)"];

/** Whether a stage error is a hook-deferred tool halt (either marker). */
export function isDeferredToolHalt(error: string | null): boolean {
  return !!error && DEFERRED_MARKERS.some((m) => error.includes(m));
}

/** Map a backend stage error string to a plain-English cause + remedy. */
export function haltCause(error: string | null, maxIterations: number): HaltCause {
  const raw = (error ?? "").trim();
  if (!raw) return { title: "Stage halted" };
  if (isDeferredToolHalt(raw)) {
    // The backend's first line is the whole explanation: "<cause>. <remedy>"
    // (the tool name can hold dots, the remedy can't).
    const line = raw.split("\n")[0];
    const cut = line.lastIndexOf(". ");
    return cut < 0
      ? { title: line, preferRerun: true }
      : { title: line.slice(0, cut), remedy: line.slice(cut + 2), preferRerun: true };
  }
  if (raw.includes("error_max_turns")) {
    return {
      title: `Claude stopped early — it reached the ${maxIterations}-turn limit`,
      remedy: "The partial work is still in the worktree. Resume with more turns, accept the partial work, or discard the changes.",
    };
  }
  if (raw.includes("error_max_budget_usd")) {
    return {
      title: "Claude stopped at the run's budget",
      remedy:
        "The partial work is still in the worktree. Resuming continues the same session within whatever budget is left; if the budget is used up, the run asks you before it continues. You can also accept the partial work or discard the changes.",
    };
  }
  if (raw.includes("could not save its session")) {
    return {
      title: "Claude finished the work but couldn't save its session",
      remedy:
        "The disk or quota is likely full. The changes are in the worktree — free some space, then accept the work or re-run. Re-running starts a fresh session.",
    };
  }
  if (raw.includes("error_during_execution")) {
    return { title: "Claude hit an execution error mid-run", remedy: "Resume or re-run to continue." };
  }
  if (/no output for/i.test(raw)) {
    return { title: "Claude produced no output and timed out", remedy: "The CLI stalled — resume or re-run." };
  }
  if (/exceeded the .* cap/i.test(raw)) {
    return { title: "Claude ran past the time cap", remedy: "Resume or re-run with more turns." };
  }
  return { title: raw.split("\n")[0] };
}
