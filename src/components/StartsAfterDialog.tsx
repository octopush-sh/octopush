import { useState } from "react";
import type { PrerequisiteCondition } from "../lib/ipc";
import type { Workspace } from "../lib/types";
import { usePrerequisitesStore } from "../stores/prerequisitesStore";
import { Switch } from "./settings/shared";
import { Listbox } from "./controls/Listbox";
import { SegmentedControl, type SegmentedOption } from "./controls/SegmentedControl";

interface Props {
  /** The mission that will wait. */
  workspace: Workspace;
  /** The other active missions of its project, the ones it can wait on. */
  candidates: Workspace[];
  onClose: () => void;
}

const CONDITIONS: SegmentedOption<PrerequisiteCondition>[] = [
  { value: "run_finished", label: "Run passes last gate", title: "Its run passes the last gate" },
  { value: "pr_merged", label: "Pull request merges", title: "Its pull request merges" },
];
const EYEBROW = "block font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute";

/** "Start after…" (#960): make a mission wait on another of its project. When
 *  the condition holds, the run is staged in Direct for Begin the run, or
 *  begun on its own with auto-start (off by default). */
export function StartsAfterDialog({ workspace, candidates, onClose }: Props) {
  const existing = usePrerequisitesStore((s) => s.byWs[workspace.id]);
  const kept = existing && candidates.some((c) => c.id === existing.afterWorkspaceId);
  const [after, setAfter] = useState(kept ? existing.afterWorkspaceId : candidates[0]?.id ?? "");
  const [condition, setCondition] = useState<PrerequisiteCondition>(existing?.afterCondition ?? "run_finished");
  const [autoStart, setAutoStart] = useState(existing?.autoStart ?? false);
  const [saving, setSaving] = useState(false);
  const store = usePrerequisitesStore.getState;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!after || saving) return;
    setSaving(true);
    const ok = await store().save(workspace.projectId, workspace.id, after, condition, autoStart);
    setSaving(false);
    if (ok) onClose();
  };

  // A refused clear keeps the link, so the dialog stays open on it.
  const stopWaiting = async () => {
    if (saving) return;
    setSaving(true);
    const ok = await store().clear(workspace.id);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <form
      onSubmit={submit}
      data-tour="starts-after-dialog"
      aria-label={`Start ${workspace.name} after another mission`}
      className="w-[360px] rounded-xl border border-octo-hairline bg-octo-panel p-4 shadow-xl"
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Start after</div>
      {candidates.length === 0 ? (
        <p className="mt-3 text-[12px] text-octo-mute">This project has no other mission to wait on.</p>
      ) : (
        <>
          <span className={`mt-3 ${EYEBROW}`}>Mission</span>
          <div className="mt-1">
            <Listbox
              value={after}
              options={candidates.map((c) => ({ value: c.id, label: c.name }))}
              onChange={setAfter}
              ariaLabel="Mission"
              className="w-full"
            />
          </div>
          <span className={`mt-3 ${EYEBROW}`}>When</span>
          <div className="mt-1">
            <SegmentedControl options={CONDITIONS} value={condition} onChange={setCondition} ariaLabel="When" fill />
          </div>
          <div className="mt-3 flex items-start gap-3" data-tour="starts-after-auto-start">
            <Switch checked={autoStart} onChange={setAutoStart} ariaLabel="Start the run on its own" testId="starts-after-auto-start" />
            <span className="flex flex-col text-[12px] text-octo-ivory">
              Start the run on its own
              <span className="text-[11px] text-octo-mute">Off: its brief and crew wait in Direct for Begin the run.</span>
            </span>
          </div>
        </>
      )}
      <div className="mt-4 flex items-center gap-2">
        {candidates.length > 0 && (
          <button
            type="submit"
            disabled={!after || saving}
            className="rounded-md px-3 py-1.5 font-serif text-[12px] text-octo-brass disabled:opacity-40"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            Wait for it
          </button>
        )}
        {existing && (
          <button type="button" onClick={() => void stopWaiting()} disabled={saving} className="rounded-md px-3 py-1.5 text-[12px] text-octo-sage hover:text-octo-ivory disabled:opacity-40">
            Stop waiting
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-[12px] text-octo-mute hover:text-octo-sage">
          Cancel
        </button>
      </div>
    </form>
  );
}
