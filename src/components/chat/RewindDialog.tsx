/**
 * RewindDialog — Talk's "Rewind files to here" confirm (#958). Shows exactly
 * what the rewind will change before anything is written: each file and
 * whether it is restored, removed or reverted, with the files changed
 * outside this conversation since flagged in amber so nothing is overwritten
 * silently. "Rewind the files" is the default; "Rewind and fork" also opens
 * a new conversation from this turn. The toast that follows offers the undo.
 */
import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { ModalShell } from "../ModalShell";
import { pushToast } from "../Toasts";
import { ipc } from "../../lib/ipc";
import { useChatStore } from "../../stores/chatStore";
import { KIND_LABEL, outsideNote, rewindError, rewindHeadline, type RewindPreview } from "../../lib/talkRewind";

interface Props {
  workspaceId: string;
  workspacePath: string;
  threadId: string;
  messageId: number;
  onClose: () => void;
}

export function RewindDialog({ workspaceId, workspacePath, threadId, messageId, onClose }: Props) {
  const refreshThread = useChatStore((s) => s.refreshThread);
  const forkThread = useChatStore((s) => s.forkThread);
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    ipc
      .previewTalkRewind(workspacePath, threadId, messageId)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError(rewindError(e)));
    return () => {
      live = false;
    };
  }, [workspacePath, threadId, messageId]);

  async function undo() {
    try {
      await ipc.undoTalkRewind(workspaceId, workspacePath, threadId);
      await refreshThread(workspaceId);
      pushToast({ level: "success", title: "The files are back as they were." });
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't undo the rewind.", body: rewindError(e) });
    }
  }

  async function confirm(fork: boolean) {
    if (!preview) return;
    setBusy(true);
    try {
      const n = await ipc.rewindTalkFiles(workspaceId, workspacePath, threadId, messageId, preview.current);
      await refreshThread(workspaceId);
      if (fork) await forkThread(workspaceId, workspacePath, threadId, messageId);
      onClose();
      pushToast({
        level: "success",
        title: `Rewound ${n} ${n === 1 ? "file" : "files"}.`,
        body: fork ? "This turn now waits in a new conversation." : undefined,
        timeout: 12000,
        action: { label: "Undo the rewind", onClick: () => void undo() },
      });
    } catch (e) {
      setError(rewindError(e));
      setBusy(false);
    }
  }

  const changes = preview?.changes ?? [];
  const note = outsideNote(changes);
  const disabled = busy || !preview || changes.length === 0;

  return (
    <ModalShell onClose={onClose} closeOnBackdrop={false} ariaLabel="Rewind files" panelClassName="w-full max-w-[520px]">
      <div data-tour="talk-rewind-dialog" className="rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
          <History size={12} strokeWidth={1.75} aria-hidden />
          <span>Rewind files</span>
        </div>
        <h2 className="mt-2 font-serif text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory">
          {preview ? rewindHeadline(changes) : error ? "This turn can't be rewound." : "Reading the files…"}
        </h2>
        {changes.length > 0 && (
          <ul className="octo-scroll mt-3 max-h-[240px] space-y-1 overflow-y-auto" aria-label="What will change">
            {changes.map((c) => (
              <li key={c.path} className="octo-rise-in flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
                <span className="w-12 shrink-0 text-octo-mute">{KIND_LABEL[c.kind]}</span>
                <span className="min-w-0 truncate text-octo-sage" title={c.path}>
                  {c.path}
                </span>
                {c.outsideTalk && (
                  <span
                    className="ml-auto shrink-0 text-octo-warning"
                    title="Changed outside this conversation since this turn: by you, another conversation or a terminal"
                  >
                    changed outside
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {note && (
          <p data-tour="talk-rewind-outside" className="mt-3 text-[12px] leading-relaxed text-octo-warning">
            {note}
          </p>
        )}
        {error && <p className="mt-3 text-[12px] leading-relaxed text-octo-rouge">{error}</p>}
        <p className="mt-3 text-[12px] leading-relaxed text-octo-sage">
          The conversation stays as it is. Your staged changes, branch and ignored files are left alone, and you can undo the rewind.
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute transition-colors hover:text-octo-sage"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void confirm(true)}
            className="rounded-md border border-octo-hairline px-4 py-2 font-serif text-[13px] text-octo-sage transition-colors duration-[180ms] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:cursor-not-allowed disabled:opacity-40"
          >
            Rewind and fork from here
          </button>
          <button
            type="button"
            autoFocus
            disabled={disabled}
            data-tour="talk-rewind-confirm"
            onClick={() => void confirm(false)}
            className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:cursor-not-allowed disabled:opacity-40"
          >
            Rewind the files
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
