// How a resolved Talk tool call ended, for its ledger row: a failure in rouge
// with its exit code or a short reason, a denial in mute, nothing for a pass.
//
// New rows carry the engine's own verdict (`ok`, `outcome`, `exitCode`, stamped
// by `chat_engine::stamp_outcome`). Rows written before it carry none, so their
// verdict is read from the result text the engine has always written: the
// trailing `(exit code N)` line of a shell command and the denial and timeout
// sentences. A legacy row that says neither stays unmarked: unknown is never
// shown as a failure.
//
// Pure: no React, no store.
import type { ToolExecution } from "../stores/chatStore";

export type ToolVerdictKind = "ok" | "failed" | "denied";

export interface ToolVerdict {
  kind: ToolVerdictKind;
  /** Mono meta for the row (`exit 1`, `timed out`, `stopped`, `failed`,
   *  `denied`); empty for a pass. */
  meta: string;
  /** The verdict in words, for the row's `title` and accessible name;
   *  empty for a pass. */
  title: string;
}

const PASS: ToolVerdict = { kind: "ok", meta: "", title: "" };

/** Every denial the engine feeds back opens with this: the approval card's
 *  and the secret guard's (`chat_engine.rs`). */
const DENIAL_PREFIX = "Command not run —";

/** `wait_command_bounded`'s timeout and the shared shell's interrupt at its cap. */
const TIMED_OUT = [/^Command timed out after \d+s/, /was still running after \d+s and was interrupted/];

const STOPPED_PREFIX = "Command stopped by the director.";

function timedOut(result: string): boolean {
  return TIMED_OUT.some((re) => re.test(result));
}

/** The exit status on the last `(exit code N)` line `format_command_output`
 *  wrote, or null when there is none. */
export function exitCodeFromResult(result: string): number | null {
  const lines = [...result.matchAll(/^\(exit code (-?\d+)\)$/gm)];
  const last = lines[lines.length - 1];
  return last ? Number(last[1]) : null;
}

function firstLine(text: string, max = 160): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The denial's own clause, `the user declined to approve it (flagged: …)`:
 *  what follows the dash, up to its first sentence end. */
function denialClause(result: string): string {
  const rest = result.slice(DENIAL_PREFIX.length).trim();
  const end = rest.search(/\.(\s|$)/);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

export function toolVerdict(tool: ToolExecution): ToolVerdict {
  const result = tool.result ?? "";
  // Only a shell command's text is the engine's own (denials, timeouts, exit
  // lines); a file read that merely contains these words is just a read.
  const shell = tool.toolName === "run_command";
  const kind: ToolVerdictKind =
    tool.outcome ??
    (shell && result.startsWith(DENIAL_PREFIX)
      ? "denied"
      : tool.ok === true
        ? "ok"
        : tool.ok === false || legacyFailed(shell, result)
          ? "failed"
          : "ok");

  if (kind === "ok") return PASS;
  if (kind === "denied") {
    const clause = result.startsWith(DENIAL_PREFIX) ? denialClause(result) : "";
    return { kind, meta: "denied", title: clause ? `Denied, not run: ${clause}` : "Denied, not run" };
  }
  if (shell && timedOut(result)) {
    return { kind, meta: "timed out", title: "Timed out and was stopped" };
  }
  if (shell && result.startsWith(STOPPED_PREFIX)) {
    return { kind, meta: "stopped", title: "Stopped before it finished" };
  }
  const code = tool.exitCode ?? (shell ? exitCodeFromResult(result) : null);
  if (code != null && code > 0) {
    return { kind, meta: `exit ${code}`, title: `Exited with code ${code}` };
  }
  const line = firstLine(result);
  return { kind, meta: "failed", title: line ? `Failed: ${line}` : "Failed" };
}

/** A row from before the engine stamped verdicts: only what its text says
 *  for certain counts as a failure. */
function legacyFailed(shell: boolean, result: string): boolean {
  if (!shell) return false;
  if (timedOut(result) || result.startsWith(STOPPED_PREFIX)) return true;
  const code = exitCodeFromResult(result);
  return code != null && code !== 0;
}

/** How many of a round's calls failed and how many were denied. */
export function verdictCounts(tools: ToolExecution[]): { failed: number; denied: number } {
  let failed = 0;
  let denied = 0;
  for (const t of tools) {
    const k = toolVerdict(t).kind;
    if (k === "failed") failed += 1;
    else if (k === "denied") denied += 1;
  }
  return { failed, denied };
}
