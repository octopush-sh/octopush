import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { formatTokens } from "../lib/cost";
import type { InstructionFile, InstructionList } from "../lib/types";
import { useChatStore } from "../stores/chatStore";

/** One file's line in the row's tooltip: its tokens, or why it wasn't sent
 *  whole. */
function fileLine(f: InstructionFile): string {
  if (f.skipped) return `${f.label} · skipped: ${f.skipped}`;
  if (f.trimmed && f.tokens === 0) return `${f.label} · left out, the instructions were already at their limit`;
  return `${f.label} · ${formatTokens(f.tokens)}${f.trimmed ? " · trimmed to fit" : ""}`;
}

/** The "follows" row's tooltip: what the files are, one line per file, and
 *  how many more skipped files weren't listed. Pure so the copy is tested. */
export function instructionsTitle(files: InstructionFile[], moreSkipped = 0): string {
  return [
    "Talk and its sub-agents follow these files, read again on every turn: yours (~/.claude/CLAUDE.md and those in the folders above this project's repository), then the repository's CLAUDE.md files, or its AGENTS.md when it has no CLAUDE.md. A repository file that points outside the repository is skipped.",
    ...files.map(fileLine),
    ...(moreSkipped > 0 ? [`+${moreSkipped} more skipped`] : []),
  ].join("\n");
}

const EMPTY: InstructionList = { files: [], moreSkipped: 0 };

/** The worktree's instruction files, re-read on a worktree change and when a
 *  turn starts or settles (the edges where an edit to them takes effect). A
 *  late answer for another worktree is dropped. */
function useProjectInstructions(worktreePath: string | undefined, workspaceId: string): InstructionList {
  const streaming = useChatStore((s) => s.streamingByWs[workspaceId] ?? false);
  const [list, setList] = useState<InstructionList>(EMPTY);
  const seq = useRef(0);

  useEffect(() => {
    const token = ++seq.current;
    if (!worktreePath) {
      setList(EMPTY);
      return;
    }
    void ipc
      .listProjectInstructions(worktreePath)
      .then((l) => {
        if (seq.current === token) setList(l?.files ? l : EMPTY);
      })
      .catch(() => {
        /* the row stays as it was; the rest of the section stands */
      });
  }, [worktreePath, streaming]);

  return list;
}

/**
 * The Conversation section's "follows" row: the instruction files Talk and
 * its sub-agents carry in their system prompt (the worktree's CLAUDE.md
 * chain, or its AGENTS.md), in the order they're sent, with each file's
 * tokens in the tooltip. A file that wasn't sent (left out, or skipped
 * because it points outside the project) is struck through, and the tooltip
 * says why. Past 20 skipped files, the rest are counted ("+N more").
 * Hidden when there is none.
 */
export function CompanionInstructions({ worktreePath, workspaceId }: { worktreePath?: string; workspaceId?: string }) {
  const { files, moreSkipped } = useProjectInstructions(worktreePath, workspaceId ?? "");
  if (files.length === 0) return null;
  return (
    <div
      className="octo-rise-in mt-3 flex flex-wrap items-center gap-x-3 gap-y-1"
      data-tour="companion-follows"
      data-testid="companion-follows"
      title={instructionsTitle(files, moreSkipped)}
    >
      <span className="text-octo-sage">follows</span>
      {files.map((f) => (
        <span
          key={f.path}
          className={`octo-fade-in font-mono text-[10px] ${f.tokens === 0 ? "text-octo-mute line-through decoration-octo-mute/60" : "text-octo-ivory"}`}
        >
          {f.label}
        </span>
      ))}
      {moreSkipped > 0 && (
        <span className="octo-fade-in font-mono text-[10px] text-octo-mute">+{moreSkipped} more</span>
      )}
    </div>
  );
}
