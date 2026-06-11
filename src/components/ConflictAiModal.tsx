/**
 * ConflictAiModal — AI-assisted merge-conflict resolution (G7 slice II).
 *
 * Reads the conflicted file, asks the workspace's review model for a fully
 * merged version, previews it in mono, and applies it via write_file +
 * mark_conflict_resolved. Discard leaves the file untouched.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { FadeSwap } from "./primitives/FadeSwap";
import { pushToast } from "./Toasts";
import { ipc } from "../lib/ipc";
import { CONFLICT_SYSTEM, buildConflictPrompt, stripFences } from "../lib/aiConflict";

interface Props {
  /** Workspace (worktree) root — joined with `file` for read/write. */
  workspacePath: string;
  /** Optional workspace id — attributes the AI spend in Usage dashboards. */
  workspaceId?: string;
  /** Repo-relative path of the conflicted file. */
  file: string;
  /** Resolved review model id (from the aiReview store). */
  model: string;
  onClose: () => void;
  /** Called after a successful apply — the parent closes and refreshes. */
  onResolved: () => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "preview"; text: string; hasMarkers: boolean }
  | { kind: "error"; message: string };

export function ConflictAiModal({ workspacePath, workspaceId, file, model, onClose, onResolved }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [applying, setApplying] = useState(false);
  const absPath = `${workspacePath}/${file}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const read = await ipc.readFileChecked(absPath);
        if (cancelled) return;
        if (read.kind !== "text") {
          setPhase({
            kind: "error",
            message:
              read.kind === "tooLarge"
                ? "This file can't be resolved with AI — it is too large to read."
                : "This file can't be resolved with AI — it isn't a text file.",
          });
          return;
        }
        const prompt = buildConflictPrompt(file, read.content);
        const res = await ipc.aiComplete(model, CONFLICT_SYSTEM, prompt, { workspaceId });
        if (cancelled) return;
        const text = stripFences(res.text);
        setPhase({ kind: "preview", text, hasMarkers: text.includes("<<<<<<<") });
      } catch (e) {
        if (!cancelled) setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally run once per mount — the modal is keyed by file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleApply() {
    if (phase.kind !== "preview" || applying) return;
    setApplying(true);
    try {
      await ipc.writeFile(absPath, phase.text);
      await ipc.markConflictResolved(workspacePath, file);
      pushToast({ level: "success", title: "Conflict resolved", body: file });
      onResolved();
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't apply the resolution", body: String(e) });
      setApplying(false);
    }
  }

  return (
    <ModalShell onClose={onClose} closeOnBackdrop={false} ariaLabel="Resolve conflict with AI" panelClassName="w-full max-w-[640px]">
      <div className="rounded-xl border border-octo-hairline bg-octo-panel shadow-2xl">
        <header className="flex items-center gap-2 border-b border-octo-hairline px-5 py-3">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
            Resolve with AI
          </span>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-octo-sage" title={file}>
            {file}
          </span>
        </header>

        <div className="px-5 py-4">
          <FadeSwap swapKey={phase.kind}>
            {phase.kind === "loading" && (
              <div className="flex items-center gap-2 py-6 text-[12px] text-octo-sage">
                <Loader2 size={12} className="animate-spin text-octo-brass" />
                Proposing a merged version…
              </div>
            )}
            {phase.kind === "error" && (
              <div className="octo-rise-in py-4 text-[12px] leading-relaxed text-octo-rouge">
                {phase.message}
              </div>
            )}
            {phase.kind === "preview" && (
              <div className="space-y-2">
                {phase.hasMarkers && (
                  <div
                    className="octo-rise-in font-mono text-[10px] text-octo-rouge"
                    title="The model left conflict markers in the output. You can still apply and finish by hand in the editor."
                  >
                    The proposal still contains conflict markers — review before applying.
                  </div>
                )}
                <pre className="max-h-[50vh] overflow-auto whitespace-pre rounded-md border border-octo-hairline bg-octo-onyx p-3 font-mono text-[11px] leading-[1.55] text-octo-ivory">
                  {phase.text}
                </pre>
              </div>
            )}
          </FadeSwap>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-octo-hairline px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition-colors hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            Discard
          </button>
          {phase.kind === "preview" && (
            <button
              type="button"
              onClick={handleApply}
              disabled={applying}
              title="Write the merged file and mark the conflict resolved"
              className="flex items-center gap-1.5 rounded px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              style={{ border: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }}
            >
              {applying && <Loader2 size={11} className="animate-spin" />}
              Apply
            </button>
          )}
        </footer>
      </div>
    </ModalShell>
  );
}
