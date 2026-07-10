import { SquareTerminal, Square } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { TerminalView } from "./TerminalView";

interface Props {
  workspaceId: string;
}

/**
 * Pinned mini-terminal for a thread's live `$`-direct process (a promoted
 * long-running command — dev server, watcher). Streams output via xterm and
 * offers Ctrl-C. Mounts when the process starts, unmounts when it exits.
 */
export function LiveProcessPanel({ workspaceId }: Props) {
  const live = useChatStore((s) => s.getLiveProcess(workspaceId));
  const stop = useChatStore((s) => s.stopShellProcess);

  if (!live) return null;

  return (
    <div className="octo-rise-in shrink-0 border-t border-octo-hairline bg-octo-onyx">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <SquareTerminal size={13} className="shrink-0 text-octo-brass" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-ivory">
          {live.command}
        </span>
        <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-sage">
          <span className="octo-stage-pulse inline-block h-1.5 w-1.5 rounded-full bg-octo-sage" />
          running
        </span>
        <button
          type="button"
          onClick={() => stop(workspaceId)}
          title="Stop process (Ctrl-C)"
          aria-label="Stop process"
          className="flex items-center gap-1 rounded border border-octo-hairline px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-rouge transition-colors hover:border-[var(--rouge-border)] hover:bg-[var(--rouge-ghost)]"
        >
          <Square size={10} fill="currentColor" /> Stop
        </button>
      </div>
      <TerminalView
        callId={live.callId}
        threadId={live.threadId}
        className="h-[200px] px-2 pb-2"
      />
    </div>
  );
}
