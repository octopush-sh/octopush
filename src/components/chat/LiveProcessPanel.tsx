import { useEffect } from "react";
import { SquareTerminal, Square, Terminal } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import {
  listedProcesses,
  selectBackgroundProcesses,
  useBackgroundProcessStore,
} from "../../stores/backgroundProcessStore";
import { TerminalView } from "./TerminalView";

interface Props {
  workspaceId: string;
}

const STOP_BUTTON =
  "flex items-center gap-1 rounded border border-octo-hairline px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-rouge transition-colors hover:border-[var(--rouge-border)] hover:bg-[var(--rouge-ghost)] disabled:opacity-50";

/**
 * Pinned mini-terminal for a thread's live `$`-direct process (a promoted
 * long-running command — dev server, watcher), or an agent command promoted
 * at its timeout. Streams output via xterm and offers Ctrl-C. Above it, one
 * row per background process the agent started (#1160), each with its own
 * Stop, so nothing the agent runs is out of sight.
 */
export function LiveProcessPanel({ workspaceId }: Props) {
  const live = useChatStore((s) => s.getLiveProcess(workspaceId));
  const stop = useChatStore((s) => s.stopShellProcess);
  const threadId = useChatStore((s) => s.activeThreadByWs[workspaceId]);
  const processes = useBackgroundProcessStore(selectBackgroundProcesses(threadId));
  const stopping = useBackgroundProcessStore((s) => s.stopping);
  const stopProcess = useBackgroundProcessStore((s) => s.stop);
  const load = useBackgroundProcessStore((s) => s.load);

  useEffect(() => {
    if (threadId) void load(threadId);
  }, [threadId, load]);

  const listed = listedProcesses(processes, Boolean(live));
  if (!live && listed.length === 0) return null;

  return (
    <div className="octo-rise-in shrink-0 border-t border-octo-hairline bg-octo-onyx">
      {threadId && listed.length > 0 && (
        <ul aria-label="Background processes" className="divide-y divide-octo-hairline">
          {listed.map((p) => {
            const busy = Boolean(stopping[`${threadId}/${p.id}`]);
            const origin =
              p.kind === "promoted"
                ? "Moved to the background at its timeout, in this conversation's shell"
                : "Started by the agent in the background";
            return (
              <li key={p.id} data-tour="talk-process-row" className="octo-rise-in flex items-center gap-2 px-3 py-1">
                <span title={origin} className="shrink-0">
                  <Terminal size={12} className="text-octo-sage" aria-label={origin} />
                </span>
                <span className="shrink-0 font-mono text-[10px] text-octo-mute">{p.id}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-ivory" title={`${p.command}\n${p.cwd}`}>
                  {p.command}
                </span>
                <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-sage">
                  <span className="octo-stage-pulse inline-block h-1.5 w-1.5 rounded-full bg-octo-sage" />
                  running
                </span>
                <button
                  type="button"
                  onClick={() => void stopProcess(threadId, p.id)}
                  disabled={busy}
                  title="Stop this process and everything it started"
                  aria-label={`Stop ${p.id}`}
                  className={STOP_BUTTON}
                >
                  <Square size={10} fill="currentColor" /> Stop
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {live && (
        <>
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
              className={STOP_BUTTON}
            >
              <Square size={10} fill="currentColor" /> Stop
            </button>
          </div>
          <TerminalView
            callId={live.callId}
            threadId={live.threadId}
            className="h-[200px] px-2 pb-2"
          />
        </>
      )}
    </div>
  );
}
