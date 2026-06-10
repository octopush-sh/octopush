import { useState } from "react";
import type { PipelineWithStages, StageDraft } from "../lib/ipc";
import { usePipelineStore } from "../stores/pipelineStore";
import { ModelPicker } from "./ModelPicker";
import { labelForRole, ROMAN } from "./RunTrack";

const ALL_ROLES = [
  "plan", "plan_review", "implement", "code_review", "test",
  "repro", "fix", "verify", "critique", "refine",
];
const REVIEW_ROLES = new Set(["plan_review", "code_review", "critique", "verify"]);
const DEFAULT_STAGE = { role: "implement", agentModel: "claude-sonnet-4-6", substrate: "api" as const, checkpoint: false };

/** Builder-local stage: loop target tracked by stage IDENTITY (key), not position. */
interface DraftStage {
  key: string;
  role: string;
  agentModel: string;
  substrate: "api" | "cli";
  checkpoint: boolean;
  loopTargetKey: string | null;
  loopMaxIterations: number;
  loopMode: "gated" | "auto" | null;
  loopCleared: boolean; // show the one-line notice after a normalize cleared the loop
}

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function draftsFrom(pipeline: PipelineWithStages | null): DraftStage[] {
  if (!pipeline) {
    return [{ key: newKey(), ...DEFAULT_STAGE, loopTargetKey: null, loopMaxIterations: 0, loopMode: null, loopCleared: false }];
  }
  const sorted = [...pipeline.stages].sort((a, b) => a.position - b.position);
  const keys = sorted.map(() => newKey());
  return sorted.map((s, i) => ({
    key: keys[i],
    role: s.role,
    agentModel: s.agentModel,
    substrate: s.substrate as "api" | "cli",
    checkpoint: s.checkpoint,
    loopTargetKey:
      s.loopTargetPosition !== null
        ? keys[sorted.findIndex((t) => t.position === s.loopTargetPosition)] ?? null
        : null,
    loopMaxIterations: s.loopMaxIterations,
    loopMode: s.loopMode as "gated" | "auto" | null,
    loopCleared: false,
  }));
}

/** Clear loops whose target no longer exists, isn't strictly earlier, or whose
 *  stage is no longer a review role. Marks cleared stages for the notice. */
function normalizeLoops(stages: DraftStage[]): DraftStage[] {
  return stages.map((s, i) => {
    if (!s.loopTargetKey) return s;
    const targetIdx = stages.findIndex((t) => t.key === s.loopTargetKey);
    const valid = REVIEW_ROLES.has(s.role) && targetIdx !== -1 && targetIdx < i;
    return valid
      ? s
      : { ...s, loopTargetKey: null, loopMaxIterations: 0, loopMode: null, loopCleared: true };
  });
}

function toStageDrafts(stages: DraftStage[]): StageDraft[] {
  return stages.map((s) => {
    const targetIdx = s.loopTargetKey ? stages.findIndex((t) => t.key === s.loopTargetKey) : -1;
    const hasLoop = targetIdx !== -1;
    return {
      role: s.role,
      agentModel: s.agentModel,
      substrate: s.substrate,
      checkpoint: s.checkpoint,
      loopTargetPosition: hasLoop ? targetIdx : null,
      loopMaxIterations: hasLoop ? s.loopMaxIterations : 0,
      loopMode: hasLoop ? s.loopMode : null,
    };
  });
}

interface Props {
  /** null = compose a new pipeline; a loaded pipeline = edit (builtins fork on save). */
  pipeline: PipelineWithStages | null;
  onClose: () => void;
}

export function PipelineBuilder({ pipeline, onClose }: Props) {
  const isBuiltin = pipeline?.pipeline.isBuiltin ?? false;
  const save = usePipelineStore((s) => s.save);
  const remove = usePipelineStore((s) => s.remove);

  const [name, setName] = useState(() =>
    pipeline ? (isBuiltin ? `${pipeline.pipeline.name} (custom)` : pipeline.pipeline.name) : "",
  );
  const [description, setDescription] = useState(pipeline?.pipeline.description ?? "");
  const [stages, setStages] = useState<DraftStage[]>(() => draftsFrom(pipeline));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const mutate = (fn: (prev: DraftStage[]) => DraftStage[]) =>
    setStages((prev) => normalizeLoops(fn(prev)));

  const patch = (key: string, p: Partial<DraftStage>) =>
    mutate((prev) => prev.map((s) => (s.key === key ? { ...s, loopCleared: false, ...p } : s)));

  const move = (idx: number, delta: -1 | 1) =>
    mutate((prev) => {
      const next = [...prev];
      const j = idx + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  const removeStage = (key: string) => mutate((prev) => prev.filter((s) => s.key !== key));
  const addStage = () =>
    mutate((prev) => [
      ...prev,
      { key: newKey(), ...DEFAULT_STAGE, loopTargetKey: null, loopMaxIterations: 0, loopMode: null, loopCleared: false },
    ]);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await save({
        pipelineId: pipeline?.pipeline.id ?? null, // the backend forks builtins
        name: name.trim(),
        description: description.trim(),
        stages: toStageDrafts(stages),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!pipeline) return;
    try {
      await remove(pipeline.pipeline.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex-1 overflow-auto px-5 py-5 octo-fade-in">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-octo-brass">I · Name the pipeline</p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="What is this pipeline called?"
        className="mb-2 w-full rounded-lg border border-octo-hairline bg-octo-panel-2 px-3 py-2 font-serif text-lg text-octo-ivory placeholder:text-octo-mute"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="One line on when to reach for it"
        className="mb-6 w-full rounded-lg border border-octo-hairline bg-octo-panel-2 px-3 py-2 text-sm text-octo-sage placeholder:text-octo-mute"
      />

      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-octo-brass">II · Assemble the stages</p>
      <div className="mb-4 flex flex-col gap-2.5">
        {stages.map((s, i) => (
          <div key={s.key} className="rounded-lg border border-octo-hairline bg-octo-panel-2 px-3 py-2.5 octo-rise-in">
            <div className="flex items-center gap-3">
              <span className="w-7 shrink-0 font-mono text-[11px] text-octo-brass">{ROMAN[i] ?? i + 1}</span>
              <select
                value={s.role}
                onChange={(e) => patch(s.key, { role: e.target.value })}
                aria-label="Stage role"
                className="rounded-md border border-octo-hairline bg-octo-onyx px-2 py-1.5 font-serif text-sm text-octo-ivory"
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>{labelForRole(r)}</option>
                ))}
              </select>
              <div className="min-w-0 flex-1">
                <ModelPicker
                  activeModel={s.agentModel}
                  onSelectModel={(m) => patch(s.key, { agentModel: m })}
                  allowedProviders={s.substrate === "cli" ? ["anthropic"] : undefined}
                />
              </div>
              <button
                type="button"
                onClick={() => patch(s.key, { substrate: s.substrate === "api" ? "cli" : "api" })}
                className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-[9px] uppercase text-octo-sage hover:border-[var(--brass-dim)]"
              >
                {s.substrate}
              </button>
              <label className="flex items-center gap-1.5 font-mono text-[9px] uppercase text-octo-mute">
                <input
                  type="checkbox"
                  checked={s.checkpoint}
                  onChange={(e) => patch(s.key, { checkpoint: e.target.checked })}
                />
                checkpoint
              </label>
              <div className="ml-auto flex items-center gap-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                  className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-xs text-octo-sage disabled:opacity-30">↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === stages.length - 1}
                  className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-xs text-octo-sage disabled:opacity-30">↓</button>
                <button type="button" onClick={() => removeStage(s.key)} disabled={stages.length === 1}
                  aria-label="Remove stage"
                  className="rounded border border-octo-hairline px-1.5 py-0.5 font-mono text-xs text-octo-mute hover:text-octo-rouge disabled:opacity-30">✕</button>
              </div>
            </div>

            {REVIEW_ROLES.has(s.role) && (
              <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-octo-hairline pt-2 font-mono text-[11px] text-octo-sage">
                <span className="text-octo-brass">⟜ loop</span>
                <label className="flex items-center gap-1.5">
                  Return to
                  <select
                    value={s.loopTargetKey ?? ""}
                    onChange={(e) =>
                      patch(s.key, e.target.value
                        ? { loopTargetKey: e.target.value, loopMaxIterations: s.loopMaxIterations || 2, loopMode: s.loopMode ?? "gated" }
                        : { loopTargetKey: null, loopMaxIterations: 0, loopMode: null })
                    }
                    className="rounded border border-octo-hairline bg-octo-onyx px-1.5 py-1 text-octo-ivory"
                  >
                    <option value="">— linear —</option>
                    {stages.slice(0, i).map((t, ti) => (
                      <option key={t.key} value={t.key}>{ROMAN[ti] ?? ti + 1} · {labelForRole(t.role)}</option>
                    ))}
                  </select>
                </label>
                {s.loopTargetKey && (
                  <>
                    <label className="flex items-center gap-1.5">
                      Max loop-backs
                      <input
                        type="number" min={1} value={s.loopMaxIterations}
                        onChange={(e) => patch(s.key, { loopMaxIterations: Math.max(1, Number(e.target.value) || 1) })}
                        className="w-14 rounded border border-octo-hairline bg-octo-onyx px-1.5 py-1 text-octo-ivory"
                      />
                    </label>
                    <label className="flex items-center gap-1.5">
                      Mode
                      <select
                        value={s.loopMode ?? "gated"}
                        onChange={(e) => patch(s.key, { loopMode: e.target.value as "gated" | "auto" })}
                        className="rounded border border-octo-hairline bg-octo-onyx px-1.5 py-1 text-octo-ivory"
                      >
                        <option value="gated">gated</option>
                        <option value="auto">auto</option>
                      </select>
                    </label>
                    {s.loopMode === "auto" && (
                      <span className="text-octo-mute">Auto relies on a parseable verdict; it gates to you otherwise.</span>
                    )}
                  </>
                )}
                {s.loopCleared && (
                  <span className="text-octo-mute">Loop target removed — review is linear again.</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addStage}
        className="mb-6 rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-sage hover:border-[var(--brass-dim)]"
      >
        + Add a stage
      </button>

      {error && <p className="mb-3 font-mono text-xs text-octo-rouge">{error}</p>}

      <div className="flex items-center gap-2 border-t border-octo-hairline pt-4">
        <button
          type="button"
          disabled={saving || !name.trim()}
          onClick={() => void onSave()}
          className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx disabled:opacity-40"
        >
          {isBuiltin ? "Save as my copy ⟶" : "Save pipeline ⟶"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute"
        >
          Cancel
        </button>
        {pipeline && !isBuiltin && (
          confirmingDelete ? (
            <button type="button" onClick={() => void onDelete()}
              className="ml-auto rounded-md border border-octo-rouge px-3 py-2 font-mono text-xs text-octo-rouge">
              Confirm delete?
            </button>
          ) : (
            <button type="button" onClick={() => setConfirmingDelete(true)}
              className="ml-auto rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute hover:text-octo-rouge">
              Delete
            </button>
          )
        )}
      </div>
    </div>
  );
}
