/**
 * Resolve a Talk context mention (`lib/talkContext.ts`) into the fenced block
 * appended to the outgoing message. Each block is capped at 64k; a failure is
 * written into the block instead of dropping it, so the user and the model
 * both see what wasn't included. Each block also says what the secret guard
 * scans before the turn is sent (#1046).
 */

import { ipc } from "./ipc";
import type { SecretFinding, SecretRefusal } from "./secretGuard";
import { readTerminalBuffer } from "./terminalBuffers";
import {
  CONTEXT_CAP,
  FOLDER_MAX_ENTRIES,
  SESSION_TAIL_LINES,
  capTail,
  capText,
  diffForFile,
  fenced,
  formatFolderListing,
  joinDiffs,
  quoteToken,
  stripAnsi,
  tailLines,
  type ContextRef,
} from "./talkContext";

/** What the guard reads of a block: its content, named by `label` (the
 *  file's path, else the `@token`), lines counted from `firstLine`. */
export interface ScanInput {
  label: string;
  text: string;
  firstLine?: number;
  wholeFile?: boolean;
}

export interface ResolvedBlock {
  ref: ContextRef;
  /** What is appended to the message. */
  text: string;
  /** What the guard scans; null for a block that only says what's missing. */
  scan: ScanInput | null;
}

/** Shared by the blocks resolved together, so `@diff` and `@diff:a.ts` in
 *  one message read the diff once. */
export interface ResolveShare {
  diff?: Promise<[string, string]>;
}

function note(ref: ContextRef, why: string): string {
  return `\n\n${quoteToken(ref.token)} _(not included: ${why})_`;
}

export async function resolveContextBlock(
  ref: ContextRef,
  workspacePath: string,
  files: string[],
  share: ResolveShare = {},
): Promise<ResolvedBlock> {
  const missing = (why: string): ResolvedBlock => ({ ref, text: note(ref, why), scan: null });
  try {
    switch (ref.kind) {
      case "file": {
        const abs = `${workspacePath}/${ref.path}`;
        if (!ref.range) {
          const res = await ipc.readFileChecked(abs, CONTEXT_CAP);
          if (res.kind !== "text") return missing(res.kind);
          return {
            ref,
            text: fenced(ref.path, res.content),
            scan: { label: ref.path, text: res.content, wholeFile: true },
          };
        }
        // Streamed: the read stops after the range's last line.
        const res = await ipc.readFileLines(abs, ref.range.start, ref.range.end, CONTEXT_CAP);
        if (res.kind !== "text") return missing(res.kind);
        if (res.start > res.end) return missing(`the file has ${res.total ?? res.end} lines`);
        const of = res.total != null ? ` of ${res.total}` : "";
        const body = res.cut ? `${res.content}\n… (cut at 64k characters)` : res.content;
        return {
          ref,
          text: fenced(`${ref.path} · lines ${res.start}–${res.end}${of}`, body),
          scan: { label: ref.path, text: res.content, firstLine: res.start },
        };
      }
      case "folder": {
        const prefix = `${ref.path}/`;
        const under = files.filter((f) => f.startsWith(prefix));
        const shown = under.slice(0, FOLDER_MAX_ENTRIES);
        const metas = await Promise.all(
          shown.map((f) => ipc.fileMeta(`${workspacePath}/${f}`).catch(() => null)),
        );
        const entries = under.map((path, i) => ({ path, size: metas[i]?.size ?? null }));
        const listing = formatFolderListing(ref.path, entries) || "(empty)";
        return {
          ref,
          text: fenced(`${prefix} · folder listing, ${under.length} file${under.length === 1 ? "" : "s"}`, listing),
          scan: { label: `@${ref.token}`, text: listing },
        };
      }
      case "session": {
        const lines = readTerminalBuffer(ref.session.id);
        if (!lines) {
          return { ref, text: `\n\nRun session "${ref.session.label}" _(not included: not open)_`, scan: null };
        }
        // The newest output is what matters: a tail over the cap loses its
        // oldest lines, and the heading counts the lines actually sent.
        const tail = capTail(tailLines(lines, SESSION_TAIL_LINES).map(stripAnsi));
        return {
          ref,
          text: fenced(
            `Run session "${ref.session.label}" · last ${tail.lines} line${tail.lines === 1 ? "" : "s"}`,
            tail.cut ? `… (cut at 64k characters, older lines left out)\n${tail.text}` : tail.text,
          ),
          scan: { label: `@${ref.token}`, text: tail.text },
        };
      }
      case "diff": {
        // Uncommitted = staged (HEAD → index) plus not staged yet (index →
        // worktree, untracked files included).
        share.diff ??= Promise.all([ipc.getStagedDiff(workspacePath), ipc.getGitDiff(workspacePath)]);
        const [staged, unstaged] = await share.diff;
        const diff = ref.path
          ? joinDiffs(diffForFile(staged, ref.path), diffForFile(unstaged, ref.path))
          : joinDiffs(staged, unstaged);
        const heading = ref.path ? `Diff of ${ref.path} (uncommitted)` : "Workspace diff (uncommitted)";
        const body = capText(diff || "(no changes)");
        return { ref, text: fenced(heading, body, "diff"), scan: { label: `@${ref.token}`, text: body } };
      }
    }
  } catch {
    return missing("unreadable");
  }
}

/** Every block of a message resolved together (one diff read between them). */
export function resolveContextBlocks(
  refs: ContextRef[],
  workspacePath: string,
  files: string[],
): Promise<ResolvedBlock[]> {
  const share: ResolveShare = {};
  return Promise.all(refs.map((r) => resolveContextBlock(r, workspacePath, files, share)));
}

/** The secret guard's verdict on a message's blocks (#1046): which blocks
 *  hold a possible secret, and the refusal the confirm shows (kind and block,
 *  never the value). Each block is scanned on its own so every flagged one is
 *  known, even past the findings cap. `null` when nothing was found or the
 *  guard is off. */
export async function scanContextBlocks(
  blocks: ResolvedBlock[],
): Promise<{ flagged: Set<number>; refusal: SecretRefusal } | null> {
  const previews = await Promise.all(
    blocks.map(async (b) => {
      if (!b.scan) return null;
      try {
        return await ipc.secretScanText([b.scan]);
      } catch {
        return null; // as the commit guard does: a scan that can't run doesn't hold
      }
    }),
  );
  const flagged = new Set<number>();
  const findings: SecretFinding[] = [];
  let total = 0;
  previews.forEach((p, i) => {
    if (!p) return;
    const n = Math.max(p.total, p.findings.length);
    if (n === 0) return;
    flagged.add(i);
    findings.push(...p.findings);
    total += n;
  });
  if (flagged.size === 0) return null;
  return { flagged, refusal: { findings, total, partial: false, fingerprint: "" } };
}

/** The message's blocks as sent: a flagged block the user left out says so
 *  in its place. */
export function joinBlocks(blocks: ResolvedBlock[], leaveOut: Set<number> = new Set()): string {
  return blocks.map((b, i) => (leaveOut.has(i) ? note(b.ref, "possible secret") : b.text)).join("");
}
