import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { formatTokens } from "../lib/cost";
import type { InstructionFile } from "../lib/types";
import { useChatStore } from "../stores/chatStore";

/** One file's line in the row's tooltip: its tokens, or why it wasn't sent
 *  whole. */
function fileLine(f: InstructionFile): string {
  if (f.trimmed && f.tokens === 0) return `${f.label} · left out, the instructions were already at their limit`;
  return `${f.label} · ${formatTokens(f.tokens)}${f.trimmed ? " · trimmed to fit" : ""}`;
}

/** The "follows" row's tooltip: what the files are and one line per file.
 *  Pure so the copy is tested. */
export function instructionsTitle(files: InstructionFile[]): string {
  return [
    "Talk and its sub-agents follow these files, read again on every turn: the CLAUDE.md chain Claude Code loads, or AGENTS.md when there is no CLAUDE.md.",
    ...files.map(fileLine),
  ].join("\n");
}

/** The worktree's instruction files, re-read on a worktree change and when a
 *  turn starts or settles (the edges where an edit to them takes effect). A
 *  late answer for another worktree is dropped. */
function useProjectInstructions(worktreePath: string | undefined, workspaceId: string): InstructionFile[] {
  const streaming = useChatStore((s) => s.streamingByWs[workspaceId] ?? false);
  const [files, setFiles] = useState<InstructionFile[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const token = ++seq.current;
    if (!worktreePath) {
      setFiles([]);
      return;
    }
    void ipc
      .listProjectInstructions(worktreePath)
      .then((f) => {
        if (seq.current === token) setFiles(f ?? []);
      })
      .catch(() => {
        /* the row stays as it was; the rest of the section stands */
      });
  }, [worktreePath, streaming]);

  return files;
}

/**
 * The Conversation section's "follows" row: the instruction files Talk and
 * its sub-agents carry in their system prompt (the worktree's CLAUDE.md
 * chain, or its AGENTS.md), in the order they're sent, with each file's
 * tokens in the tooltip. Hidden when there is none.
 */
export function CompanionInstructions({ worktreePath, workspaceId }: { worktreePath?: string; workspaceId?: string }) {
  const files = useProjectInstructions(worktreePath, workspaceId ?? "");
  if (files.length === 0) return null;
  return (
    <div
      className="octo-rise-in mt-3 flex flex-wrap items-center gap-x-3 gap-y-1"
      data-tour="companion-follows"
      data-testid="companion-follows"
      title={instructionsTitle(files)}
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
    </div>
  );
}
