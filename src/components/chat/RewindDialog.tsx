/**
 * RewindDialog — Talk's "Rewind files to here" confirm (#958). Shows exactly
 * what the rewind will change before anything is written: each file and
 * whether it is restored, removed or reverted, with the files changed
 * outside this conversation since flagged in amber so nothing is overwritten
 * silently. Paths that differ but are left alone (git-ignored now or at
 * that turn, sensitive names, anything the snapshot doesn't hold) are listed
 * apart. "Rewind the files" is the default; "Rewind and fork" also opens
 * a new conversation from this turn. The toast that follows offers the undo;
 * once the files are rewound the dialog closes, even if the fork then fails.
 * A rewind that stops part-way keeps the dialog open with the reason and
 * its own "Undo the rewind".
 */
import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { ModalShell } from "../ModalShell";
import { pushToast } from "../Toasts";
import { ipc } from "../../lib/ipc";
import { useChatStore } from "../../stores/chatStore";
import {
  KIND_LABEL,
  UNTOUCHED_LABEL,
  UNTOUCHED_TITLE,
  outsideNote,
  rewindError,
  rewindHeadline,
  rewoundTitle,
  untouchedNote,
  type RewindOutcome,
  type RewindPreview,
} from "../../lib/talkRewind";

interface Props {
  workspaceId: string;
  threadId: string;
  messageId: number;
  onClose: () => void;
}

export function RewindDialog({ workspaceId, threadId, messageId, onClose }: Props) {
  const refreshThread = useChatStore((s) => s.refreshThread);
  const forkThread = useChatStore((s) => s.forkThread);
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set once a rewind stopped part-way: the dialog then offers the undo.
  const [stopped, setStopped] = useState<RewindOutcome | null>(null);

  useEffect(() => {
    let live = true;
    ipc
      .previewTalkRewind(threadId, messageId)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError(rewindError(e)));
    return () => {
      live = false;
    };
  }, [threadId, messageId]);

  async function undo() {
    try {
      const back = await ipc.undoTalkRewind(threadId);
      await refreshThread(workspaceId).catch(() => {});
      if (back.error) {
        pushToast({ level: "error", title: "The undo stopped part-way.", body: back.error });
        return false;
      }
      const left = back.untouched.length;
      pushToast({
        level: "success",
        title: left > 0 ? `The files are back; ${left} left untouched.` : "The files are back as they were.",
      });
      return true;
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't undo the rewind.", body: rewindError(e) });
      return false;
    }
  }

  async function undoStopped() {
    setBusy(true);
    const done = await undo();
    setBusy(false);
    if (done) onClose();
  }

  async function confirm(fork: boolean) {
    if (!preview) return;
    setBusy(true);
    let outcome: RewindOutcome;
    try {
      outcome = await ipc.rewindTalkFiles(threadId, messageId, preview.current);
    } catch (e) {
      setError(rewindError(e));
      setBusy(false);
      return;
    }
    if (outcome.error) {
      // Some files were rewound and some were not. Stay open, say so, and
      // offer the way back to how the files were before.
      setStopped(outcome);
      setError(null);
      setBusy(false);
      await refreshThread(workspaceId).catch(() => {});
      return;
    }
    // The files are rewound: from here the dialog closes and the undo is
    // offered whatever happens to the fork.
    onClose();
    pushToast({
      level: "success",
      title: rewoundTitle(outcome),
      timeout: 12000,
      action: outcome.canUndo ? { label: "Undo the rewind", onClick: () => void undo() } : undefined,
    });
    await refreshThread(workspaceId).catch(() => {});
    if (!fork) return;
    try {
      await forkThread(workspaceId, threadId, messageId);
      pushToast({ level: "success", title: "Forked into a new conversation.", body: "The turn's text is in the composer." });
    } catch (e) {
      pushToast({ level: "error", title: "The files are rewound, but the fork failed.", body: rewindError(e) });
    }
  }

  const changes = preview?.changes ?? [];
  const untouched = stopped?.untouched ?? preview?.untouched ?? [];
  const note = outsideNote(changes);
  const leftNote = untouchedNote(untouched);
  const disabled = busy || !preview || changes.length === 0 || stopped !== null;

  return (
    <ModalShell onClose={onClose} closeOnBackdrop={false} ariaLabel="Rewind files" panelClassName="w-full max-w-[520px]">
      <div data-tour="talk-rewind-dialog" className="rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
          <span title="Rewind files" className="inline-flex">
            <History size={12} strokeWidth={1.75} aria-hidden />
          </span>
          <span>Rewind files</span>
        </div>
        <h2 className="mt-2 font-serif text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory">
          {stopped
            ? "The rewind stopped part-way."
            : preview
              ? rewindHeadline(changes)
              : error
                ? "This turn can't be rewound."
                : "Reading the files…"}
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
        {leftNote && (
          <div data-tour="talk-rewind-untouched" className="mt-3">
            <p className="text-[12px] leading-relaxed text-octo-sage">{leftNote}</p>
            <ul className="octo-scroll mt-1 max-h-[120px] space-y-1 overflow-y-auto" aria-label="Left untouched">
              {untouched.map((u) => (
                <li key={u.path} className="octo-rise-in flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
                  <span className="min-w-0 truncate text-octo-mute" title={u.path}>
                    {u.path}
                  </span>
                  <span className="ml-auto shrink-0 text-octo-mute" title={UNTOUCHED_TITLE[u.reason]}>
                    {UNTOUCHED_LABEL[u.reason]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {stopped && (
          <p className="mt-3 text-[12px] leading-relaxed text-octo-rouge">
            {stopped.changed} {stopped.changed === 1 ? "file was" : "files were"} changed before it stopped: {stopped.error}
            {stopped.canUndo
              ? " The files as they were before the rewind are kept, and you can put them back."
              : " The state before the rewind could not be recorded, so there is no undo."}
          </p>
        )}
        {error && <p className="mt-3 text-[12px] leading-relaxed text-octo-rouge">{error}</p>}
        <p className="mt-3 text-[12px] leading-relaxed text-octo-sage">
          The conversation stays as it is. Your staged changes and branch are left alone, and so is any file that is git-ignored now or was at that turn. The notice that follows offers an undo for a few seconds.
        </p>
        <p data-tour="talk-rewind-storage" className="mt-2 text-[11px] leading-relaxed text-octo-mute">
          Checkpoints are kept in this repository as git objects under refs/octopush/talk/, untracked files included, for up to 30 days. Files with a sensitive name, such as an env file or a private key, are never stored.
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute transition-colors hover:text-octo-sage"
          >
            {stopped ? "Close" : "Cancel"}
          </button>
          {stopped?.canUndo && (
            <button
              type="button"
              disabled={busy}
              data-tour="talk-rewind-undo"
              onClick={() => void undoStopped()}
              className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:cursor-not-allowed disabled:opacity-40"
            >
              Undo the rewind
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => void confirm(true)}
            className="rounded-md border border-octo-border-strong px-4 py-2 font-serif text-[13px] text-octo-sage transition-colors duration-[180ms] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:cursor-not-allowed disabled:opacity-40"
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
