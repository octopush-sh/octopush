// How a resolved Talk tool call ended, for its ledger row: a failure in rouge
// with its exit code or a short reason, a denial in mute, nothing for a pass.
//
// New rows carry the engine's own verdict (`ok`, `outcome`, `exitCode`, and
// `reason: "stopped"` when the engine stopped the call; stamped by
// `chat_engine::stamp_outcome`), and what it stamped wins over any reading
// of the text. Rows written before it carry none, so their verdict is read
// from text the engine has always written at a fixed place: a shell
// command's TRAILING `(exit code N)` line (followed at most by the 127
// note) and the denial it opens with. A legacy row that says neither stays
// unmarked: unknown is never shown as a failure, and output that merely
// quotes those words in the middle is just output.
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

/** Every denial the engine feeds back for a command opens with this: the
 *  approval card's and the secret guard's (`chat_engine.rs`). */
const DENIAL_PREFIX = "Command not run —";

/** The last thing `format_command_output` writes: `(exit code N)`, then at
 *  most the one-line note a 127 gets (`` `gh` wasn't found … ``). */
const TRAILING_EXIT = /(?:^|\n)\(exit code (-?\d+)\)(?:\n[^\n]*wasn't found[^\n]*)?\s*$/;

/** The shared shell's interrupt at its cap: its note is the line right before
 *  the trailing `(exit code -1)`. */
const SHELL_TIMEOUT = /\(command was still running after \d+s and was interrupted[^\n]*\)\n\(exit code -1\)\s*$/;
/** `wait_command_bounded`'s own timeout and stop, which open its result. */
const BOUNDED_TIMEOUT = /^Command timed out after \d+s and was killed\./;
const BOUNDED_STOP = /^Command stopped by the director\./;

/** The exit status on the trailing `(exit code N)` line `format_command_output`
 *  wrote, or null when the result doesn't end with one. */
export function exitCodeFromResult(result: string): number | null {
  const m = TRAILING_EXIT.exec(result);
  return m ? Number(m[1]) : null;
}

function firstLine(text: string, max = 160): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A denial's own clause, up to its first sentence end: `the user declined
 *  to approve it (flagged: …)` after the command denial's dash, or the MCP
 *  refusal's `docs is turned off in this conversation, …`. */
function denialClause(result: string): string {
  const rest = (result.startsWith(DENIAL_PREFIX) ? result.slice(DENIAL_PREFIX.length) : result).trim();
  const end = rest.search(/\.(\s|$)/);
  return firstLine(end >= 0 ? rest.slice(0, end) : rest);
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
    const clause = denialClause(result);
    return { kind, meta: "denied", title: clause ? `Denied, not run: ${clause}` : "Denied, not run" };
  }
  // What the engine stamped wins over any reading of the text.
  if (tool.reason === "stopped") return STOPPED;
  if (tool.exitCode != null && tool.exitCode > 0) return exited(tool.exitCode);
  if (shell && (SHELL_TIMEOUT.test(result) || BOUNDED_TIMEOUT.test(result))) {
    return { kind: "failed", meta: "timed out", title: "Timed out and was stopped" };
  }
  if (shell && BOUNDED_STOP.test(result)) return STOPPED;
  const code = shell ? exitCodeFromResult(result) : null;
  if (code != null && code > 0) return exited(code);
  const line = firstLine(result);
  return { kind: "failed", meta: "failed", title: line ? `Failed: ${line}` : "Failed" };
}

const STOPPED: ToolVerdict = { kind: "failed", meta: "stopped", title: "Stopped before it finished" };

function exited(code: number): ToolVerdict {
  return { kind: "failed", meta: `exit ${code}`, title: `Exited with code ${code}` };
}

/** A row from before the engine stamped verdicts: only a shell command whose
 *  result ENDS with a non-zero exit line counts as a failure (the shared
 *  shell's timeout note ends with `(exit code -1)` too). */
function legacyFailed(shell: boolean, result: string): boolean {
  if (!shell) return false;
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
