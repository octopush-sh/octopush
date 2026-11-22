/**
 * Resolve a Talk context mention (`lib/talkContext.ts`) into the fenced block
 * appended to the outgoing message. Each block is capped at 64k; a failure is
 * written into the block instead of dropping it, so the user and the model
 * both see what wasn't included.
 */

import { ipc } from "./ipc";
import { readTerminalBuffer } from "./terminalBuffers";
import {
  CONTEXT_CAP,
  FOLDER_MAX_ENTRIES,
  SESSION_TAIL_LINES,
  capText,
  diffForFile,
  fenced,
  formatFolderListing,
  sliceLines,
  stripAnsi,
  tailLines,
  type ContextRef,
} from "./talkContext";

export async function resolveContextBlock(
  ref: ContextRef,
  workspacePath: string,
  files: string[],
): Promise<string> {
  try {
    switch (ref.kind) {
      case "file": {
        // A range reads the whole file (lines past the cap would be lost),
        // then caps what it keeps.
        const res = await ipc.readFileChecked(
          `${workspacePath}/${ref.path}`,
          ref.range ? undefined : CONTEXT_CAP,
        );
        if (res.kind !== "text") return `\n\n${ref.token} _(not included: ${res.kind})_`;
        if (!ref.range) return fenced(ref.path, res.content);
        const s = sliceLines(res.content, ref.range.start, ref.range.end);
        return fenced(
          `${ref.path} · lines ${s.start}–${s.end} of ${s.total}`,
          capText(s.text),
        );
      }
      case "folder": {
        const prefix = `${ref.path}/`;
        const under = files.filter((f) => f.startsWith(prefix));
        const shown = under.slice(0, FOLDER_MAX_ENTRIES);
        const metas = await Promise.all(
          shown.map((f) => ipc.fileMeta(`${workspacePath}/${f}`).catch(() => null)),
        );
        const entries = under.map((path, i) => ({ path, size: metas[i]?.size ?? null }));
        return fenced(
          `${prefix} · folder listing, ${under.length} file${under.length === 1 ? "" : "s"}`,
          formatFolderListing(ref.path, entries) || "(empty)",
        );
      }
      case "session": {
        const lines = readTerminalBuffer(ref.session.id);
        if (!lines) return `\n\nRun session "${ref.session.label}" _(not included: not open)_`;
        const tail = tailLines(lines, SESSION_TAIL_LINES);
        return fenced(
          `Run session "${ref.session.label}" · last ${tail.length} lines`,
          capText(stripAnsi(tail.join("\n"))),
        );
      }
      case "diff": {
        const all = await ipc.getGitDiff(workspacePath);
        const diff = ref.path ? diffForFile(all, ref.path) : all.trimEnd();
        const heading = ref.path ? `Diff of ${ref.path}` : "Workspace diff (uncommitted)";
        return fenced(heading, capText(diff || "(no changes)"), "diff");
      }
    }
  } catch {
    return `\n\n${ref.token} _(not included: unreadable)_`;
  }
}
