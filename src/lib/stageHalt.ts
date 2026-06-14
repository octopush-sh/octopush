export interface HaltCause {
  title: string;
  remedy?: string;
}

/** Map a backend stage error string to a plain-English cause + remedy. */
export function haltCause(error: string | null, maxIterations: number): HaltCause {
  const raw = (error ?? "").trim();
  if (!raw) return { title: "Stage halted" };
  if (raw.includes("error_max_turns")) {
    return {
      title: `Claude stopped early — it reached the ${maxIterations}-turn limit`,
      remedy: "The partial work is still in the worktree. Resume with more turns, accept the partial work, or discard the changes.",
    };
  }
  if (raw.includes("error_during_execution")) {
    return { title: "Claude hit an execution error mid-run", remedy: "Resume to continue, or re-run." };
  }
  if (/no output for/i.test(raw)) {
    return { title: "Claude produced no output and timed out", remedy: "The CLI stalled. Resume or re-run." };
  }
  if (/exceeded the .* cap/i.test(raw)) {
    return { title: "Claude ran past the time cap", remedy: "Resume to continue where it left off." };
  }
  return { title: raw.split("\n")[0] };
}
