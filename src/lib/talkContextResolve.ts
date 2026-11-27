/**
 * Resolve a Talk context mention (`lib/talkContext.ts`) into the fenced block
 * appended to the outgoing message. Each block is capped at 64k; a failure is
 * written into the block instead of dropping it, so the user and the model
 * both see what wasn't included. Each block also says what the secret guard
 * scans before the turn is sent (#1046).
 */

import { ipc } from "./ipc";
import type { SecretFinding, SecretRefusal } from "./secretGuard";
import type { SentContextBlock } from "./sentContext";
import { readTerminalBuffer } from "./terminalBuffers";
import {
  CONTEXT_CAP,
  FOLDER_MAX_ENTRIES,
  SESSION_TAIL_LINES,
  blockTokens,
  capRefs,
  capTail,
  capText,
  chipLabel,
  dirsOf,
  extractContextRefs,
  diffForFile,
  diffScanInputs,
  fenced,
  formatChatDigest,
  formatFolderListing,
  joinDiffs,
  quoteToken,
  stripAnsi,
  tailLines,
  type ChatRef,
  type ContextRef,
  type SessionRef,
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
  /** What the guard scans, scanned together: one input for most blocks, one
   *  per file section and hunk side for a diff (`diffScanInputs`); empty for
   *  a block that only says what's missing. */
  scan: ScanInput[];
  /** Why nothing could be included (the text says so too). */
  missing?: string;
}

/** Shared by the blocks resolved together, so `@diff` and `@diff:a.ts` in
 *  one message read the diff once. */
export interface ResolveShare {
  diff?: Promise<[string, string]>;
  /** The workspace the message is sent in: `@chat:` reads only its own
   *  conversations, and the backend refuses any other. */
  workspaceId?: string;
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
  const missing = (why: string): ResolvedBlock => ({ ref, text: note(ref, why), scan: [], missing: why });
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
            scan: [{ label: ref.path, text: res.content, wholeFile: true }],
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
          scan: [{ label: ref.path, text: res.content, firstLine: res.start }],
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
          scan: [{ label: `@${ref.token}`, text: listing }],
        };
      }
      case "session": {
        const lines = readTerminalBuffer(ref.session.id);
        if (!lines) {
          return { ref, text: `\n\nRun session "${ref.session.label}" _(not included: not open)_`, scan: [], missing: "not open" };
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
          scan: [{ label: `@${ref.token}`, text: tail.text }],
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
        // Scanned per file, by the file's path: an untracked `.env` or
        // `id_rsa` in the diff is flagged as it would be in a commit.
        return { ref, text: fenced(heading, body, "diff"), scan: diffScanInputs(body) };
      }
      case "chat": {
        if (!share.workspaceId) return missing("not in this workspace");
        const digest = await ipc.chatThreadDigest(share.workspaceId, ref.chat.id);
        const body = capText(formatChatDigest(digest) || "(nothing asked yet)");
        const from = digest.summary ? "summary" : "asks and last answer";
        return {
          ref,
          text: fenced(`Conversation "${ref.chat.title}" · ${from}`, body),
          scan: [{ label: `@${ref.token}`, text: body }],
        };
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
  workspaceId?: string,
): Promise<ResolvedBlock[]> {
  const share: ResolveShare = { workspaceId };
  return Promise.all(refs.map((r) => resolveContextBlock(r, workspacePath, files, share)));
}

/** The guard's verdict on a message's blocks. `unchecked` is the part of
 *  `flagged` whose scan couldn't run. */
export interface ContextVerdict {
  flagged: Set<number>;
  unchecked: Set<number>;
  refusal: SecretRefusal;
}

/** The secret guard's verdict on a message's blocks (#1046): which blocks
 *  hold a possible secret, and the refusal the confirm shows (kind and block,
 *  never the value). Each block is scanned on its own so every flagged one is
 *  known, even past the findings cap. A block whose scan can't run is held
 *  too, as unchecked (the refusal is `partial` and names it in `unchecked`):
 *  it is about to leave the Mac, so the confirm asks rather than sending it
 *  unread. `null` when nothing was found or the guard is off. */
export async function scanContextBlocks(blocks: ResolvedBlock[]): Promise<ContextVerdict | null> {
  const previews = await Promise.all(
    blocks.map(async (b) => {
      if (b.scan.length === 0) return null;
      try {
        return await ipc.secretScanText(b.scan);
      } catch {
        return "unchecked" as const;
      }
    }),
  );
  const flagged = new Set<number>();
  const unchecked = new Set<number>();
  const findings: SecretFinding[] = [];
  let total = 0;
  previews.forEach((p, i) => {
    if (p === "unchecked") {
      flagged.add(i);
      unchecked.add(i);
      return;
    }
    if (!p) return;
    const n = Math.max(p.total, p.findings.length);
    if (n === 0) return;
    flagged.add(i);
    findings.push(...p.findings);
    total += n;
  });
  if (flagged.size === 0) return null;
  const refusal: SecretRefusal = { findings, total, partial: unchecked.size > 0, fingerprint: "" };
  if (unchecked.size > 0) refusal.unchecked = [...unchecked].map((i) => `@${quoteToken(blocks[i].ref.token)}`);
  return { flagged, unchecked, refusal };
}

/** A message as sent: the typed text with its blocks appended, and where
 *  each block sits (#1150). */
export interface SentMessage {
  content: string;
  context: SentContextBlock[];
}

/** The message's blocks appended to what was typed: a flagged block the user
 *  left out says so in its place, and why (`unchecked`: its scan couldn't
 *  run). Each block's span is recorded for the thread's chips. */
export function withContext(
  typed: string,
  blocks: ResolvedBlock[],
  leaveOut: Set<number> = new Set(),
  unchecked: Set<number> = new Set(),
): SentMessage {
  let content = typed;
  const context = blocks.map((b, i): SentContextBlock => {
    const leftOut = leaveOut.has(i) ? (unchecked.has(i) ? "couldn't be checked for secrets" : "possible secret") : null;
    const text = leftOut ? note(b.ref, leftOut) : b.text;
    const why = leftOut ?? b.missing;
    const start = content.length;
    content += text;
    const entry: SentContextBlock = {
      token: b.ref.token,
      kind: b.ref.kind,
      label: chipLabel(b.ref),
      tokens: blockTokens(text),
      start,
      end: content.length,
    };
    if (why) entry.notIncluded = why;
    return entry;
  });
  return { content, context };
}

/** The blocks alone, as `withContext` appends them. */
export function joinBlocks(blocks: ResolvedBlock[], leaveOut?: Set<number>, unchecked?: Set<number>): string {
  return withContext("", blocks, leaveOut, unchecked).content;
}

/** A resend with no composer to ask in (Edit & resend, #1150): the draft's
 *  `@` tokens resolved fresh, as at send. A block the guard flags, or
 *  couldn't check, is left out, and its chip says so. */
export async function expandDraft(
  text: string,
  workspacePath: string,
  sessions: SessionRef[],
  chats: ChatRef[] = [],
  workspaceId?: string,
): Promise<SentMessage> {
  const files = await ipc.listWorkspaceFiles(workspacePath).catch(() => [] as string[]);
  const refs = capRefs(extractContextRefs(text, { files: new Set(files), dirs: dirsOf(files), sessions, chats })).kept;
  if (refs.length === 0) return { content: text, context: [] };
  const blocks = await resolveContextBlocks(refs, workspacePath, files, workspaceId);
  const verdict = await scanContextBlocks(blocks);
  return withContext(text, blocks, verdict?.flagged, verdict?.unchecked);
}
