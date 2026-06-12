import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { PipelineWithStages, StageDraft } from "../lib/ipc";
import { prefersReducedMotion } from "../lib/motion";
import { usePipelineStore } from "../stores/pipelineStore";
import { ModelPicker } from "./ModelPicker";
import { labelForRole, ROMAN } from "./RunTrack";
import { Listbox } from "./controls/Listbox";
import { SegmentedControl } from "./controls/SegmentedControl";
import { TogglePill } from "./controls/TogglePill";
import { Stepper } from "./controls/Stepper";
import { IconButton } from "./controls/IconButton";
import { Reveal } from "./primitives/Reveal";

// Keep in sync with KNOWN_ROLES/REVIEW_ROLES in src-tauri/src/db.rs (the authoritative validator).
const ALL_ROLES = [
  "plan", "plan_review", "implement", "code_review", "test",
  "repro", "fix", "verify", "critique", "refine",
];
const REVIEW_ROLES = new Set(["plan_review", "code_review", "critique", "verify"]);
// Keep in sync with KNOWN_ROLES in src-tauri/src/db.rs (authoritative validator).
const ROLE_DESCRIPTIONS: Record<string, string> = {
  plan: "Outline the approach before any code",
  plan_review: "Critique the plan — can loop back",
  implement: "Write the code in the worktree",
  code_review: "Review the diff — can loop back",
  test: "Write and run the tests",
  repro: "Reproduce the reported problem",
  fix: "Apply the fix",
  verify: "Confirm the fix holds — can loop back",
  critique: "Critique the artifact — can loop back",
  refine: "Polish from the critique",
};
const ROLE_OPTIONS = ALL_ROLES.map((r) => ({ value: r, label: labelForRole(r), description: ROLE_DESCRIPTIONS[r] }));
const SUBSTRATE_OPTIONS = [
  { value: "api" as const, label: "API", activeClass: "bg-[var(--state-blue-ghost)] text-octo-state-blue" },
  { value: "cli" as const, label: "CLI", activeClass: "bg-[var(--state-purple-ghost)] text-octo-state-purple" },
];
const MODE_OPTIONS = [
  { value: "gated" as const, label: "Gated" },
  { value: "auto" as const, label: "Auto" },
];
// Keep the default model in sync with the seeder's choices in db.rs seed_builtin_pipelines,
// and the default turn budget with the max_iterations DB default (25).
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_STAGE = {
  role: "implement", agentModel: "claude-sonnet-4-6", substrate: "api" as const,
  checkpoint: false, maxIterations: DEFAULT_MAX_TURNS,
};

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
  /** Per-stage tool-turn budget (validated 1..=100 backend-side). */
  maxIterations: number;
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
  return normalizeLoops(sorted.map((s, i) => ({
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
    maxIterations: s.maxIterations ?? DEFAULT_MAX_TURNS,
  })));
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
  return stages.map((s, i) => {
    const targetIdx = s.loopTargetKey ? stages.findIndex((t) => t.key === s.loopTargetKey) : -1;
    const hasLoop = targetIdx !== -1 && targetIdx < i;
    return {
      role: s.role,
      agentModel: s.agentModel,
      substrate: s.substrate,
      checkpoint: s.checkpoint,
      loopTargetPosition: hasLoop ? targetIdx : null,
      loopMaxIterations: hasLoop ? s.loopMaxIterations : 0,
      loopMode: hasLoop ? s.loopMode : null,
      maxIterations: s.maxIterations,
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

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const exitTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => exitTimeouts.current.forEach(clearTimeout), []);
  const removeStage = (key: string) => {
    const drop = () => {
      delete cardRefs.current[key];
      mutate((prev) => prev.filter((s) => s.key !== key));
    };
    if (prefersReducedMotion()) {
      drop();
      return;
    }
    setExiting((prev) => new Set(prev).add(key));
    exitTimeouts.current.push(setTimeout(() => {
      setExiting((prev) => { const n = new Set(prev); n.delete(key); return n; });
      drop();
    }, 120));
  };

  const jumpTo = (key: string) => cardRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "center" });

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
    <div className="min-h-0 flex-1 overflow-auto px-8 py-6 octo-fade-in">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">direct · builder</p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name this pipeline"
        aria-label="Pipeline name"
        className="mb-1 w-full border-b border-transparent bg-transparent pb-1 font-serif text-[22px] tracking-[-0.005em] text-octo-ivory outline-none transition-colors duration-[180ms] placeholder:font-serif placeholder:text-octo-mute hover:border-octo-hairline focus:border-[var(--brass-dim)]"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="When should the team reach for it?"
        aria-label="Pipeline description"
        className="mb-6 w-full border-b border-transparent bg-transparent pb-1 font-mono text-xs text-octo-sage outline-none transition-colors duration-[180ms] placeholder:text-octo-mute hover:border-octo-hairline focus:border-[var(--brass-dim)]"
      />

      <PreviewRail stages={stages} onJump={jumpTo} />

      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">II · Compose the stages</p>
      <div className="mb-4 flex flex-col gap-3">
        {stages.map((s, i) => (
          <div
            key={s.key}
            ref={(el) => { cardRefs.current[s.key] = el; }}
            className={`rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-3 ${
              exiting.has(s.key) ? "octo-fade-out pointer-events-none" : "octo-rise-in"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="w-7 shrink-0 font-mono text-[11px] text-octo-brass">{ROMAN[i] ?? i + 1}</span>
              <Listbox value={s.role} options={ROLE_OPTIONS} onChange={(r) => patch(s.key, { role: r })} ariaLabel="Stage role" className="w-44 shrink-0" />
              <div className="min-w-0 flex-1">
                <ModelPicker
                  activeModel={s.agentModel}
                  onSelectModel={(m) => patch(s.key, { agentModel: m })}
                  allowedProviders={s.substrate === "cli" ? ["anthropic"] : undefined}
                />
              </div>
              <SegmentedControl options={SUBSTRATE_OPTIONS} value={s.substrate} onChange={(v) => patch(s.key, { substrate: v })} ariaLabel="Execution substrate" />
              <TogglePill on={s.checkpoint} onChange={(v) => patch(s.key, { checkpoint: v })} label="⟜ gate" ariaLabel="Approval gate" />
              <label className="flex shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-octo-mute">
                max turns
                <Stepper value={s.maxIterations} min={5} max={100} onChange={(v) => patch(s.key, { maxIterations: v })} ariaLabel="Max turns" />
              </label>
              <div className="ml-auto flex items-center gap-1">
                <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp size={12} /></IconButton>
                <IconButton label="Move down" disabled={i === stages.length - 1} onClick={() => move(i, 1)}><ChevronDown size={12} /></IconButton>
                <IconButton label="Remove stage" danger disabled={stages.length === 1} onClick={() => removeStage(s.key)}><X size={12} /></IconButton>
              </div>
            </div>

            <Reveal open={REVIEW_ROLES.has(s.role)}>
              <div className="mt-3 border-t border-octo-hairline pt-3">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">⟜ loop</span>
                  <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-octo-mute">
                    return to
                    <Listbox
                      value={s.loopTargetKey}
                      options={[
                        { value: "", label: "— linear —" },
                        ...stages.slice(0, i).map((t, ti) => ({ value: t.key, label: `${ROMAN[ti] ?? ti + 1} · ${labelForRole(t.role)}` })),
                      ]}
                      onChange={(v) =>
                        patch(s.key, v
                          ? { loopTargetKey: v, loopMaxIterations: s.loopMaxIterations || 2, loopMode: s.loopMode ?? "gated" }
                          : { loopTargetKey: null, loopMaxIterations: 0, loopMode: null })
                      }
                      placeholder="— linear —"
                      ariaLabel="Loop target"
                      className="w-44"
                    />
                  </label>
                  {/* S1: sub-controls stay mounted — they dim instead of reflowing. */}
                  <div className={`flex items-center gap-x-5 transition-opacity duration-[220ms] ${s.loopTargetKey ? "" : "pointer-events-none opacity-30"}`} aria-hidden={!s.loopTargetKey}>
                    <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-octo-mute">
                      max loop-backs
                      <Stepper value={s.loopMaxIterations || 2} min={1} max={9} onChange={(v) => patch(s.key, { loopMaxIterations: v })} ariaLabel="Max loop-backs" />
                    </label>
                    <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-octo-mute">
                      mode
                      <SegmentedControl options={MODE_OPTIONS} value={s.loopMode ?? "gated"} onChange={(v) => patch(s.key, { loopMode: v })} ariaLabel="Loop mode" />
                    </label>
                  </div>
                </div>
                <div className="mt-1.5 h-4 font-mono text-[10px] text-octo-mute">
                  {s.loopCleared
                    ? "Loop target removed — review is linear again."
                    : s.loopTargetKey && s.loopMode === "auto"
                      ? "Auto relies on a parseable verdict; it gates to you otherwise."
                      : ""}
                </div>
              </div>
            </Reveal>
            <Reveal open={s.loopCleared && !REVIEW_ROLES.has(s.role)}>
              <div className="mt-2 border-t border-octo-hairline pt-2 font-mono text-[10px] text-octo-mute">
                Loop target removed — review is linear again.
              </div>
            </Reveal>
          </div>
        ))}
      </div>
      <button type="button" onClick={addStage}
        className="mb-8 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-ivory">
        ⟶ Add another stage
      </button>

      <Reveal open={error !== null}>
        <div className="mb-3 rounded-md border-l-2 border-octo-rouge bg-[var(--rouge-ghost)] px-3 py-2 font-mono text-xs text-octo-rouge">
          {error}
        </div>
      </Reveal>

      <div className="sticky bottom-0 -mx-8 flex items-center gap-2 border-t border-octo-hairline bg-octo-panel px-8 py-3">
        <button type="button" disabled={saving || !name.trim()} onClick={() => void onSave()}
          className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi disabled:opacity-40">
          {isBuiltin ? "Save as my copy ⟶" : "Save pipeline ⟶"}
        </button>
        <button type="button" onClick={onClose}
          className="rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage">
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
              className="ml-auto rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-rouge">
              Delete
            </button>
          )
        )}
      </div>
    </div>
  );
}

function PreviewRail({ stages, onJump }: { stages: DraftStage[]; onJump: (key: string) => void }) {
  return (
    <div className="mb-8 flex items-start overflow-x-auto rounded-lg border border-octo-hairline bg-octo-panel-2 px-4 py-3">
      {stages.map((s, i) => {
        const targetIdx = s.loopTargetKey ? stages.findIndex((t) => t.key === s.loopTargetKey) : -1;
        const looping = targetIdx !== -1 && targetIdx < i;
        return (
          <div key={s.key} className="flex items-start">
            {i > 0 && (
              <span className="mx-2 mt-1 text-octo-brass opacity-60">{stages[i - 1].checkpoint ? "⟜" : "⟶"}</span>
            )}
            <button type="button" onClick={() => onJump(s.key)}
              className="flex flex-col items-start gap-0.5 rounded-sm px-1.5 py-0.5 text-left transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]">
              <span className="font-mono text-[10px] text-octo-brass">{ROMAN[i] ?? i + 1}</span>
              <span className="whitespace-nowrap font-serif text-[13px] text-octo-ivory">{labelForRole(s.role)}</span>
              <span className="h-3.5 whitespace-nowrap font-mono text-[9px] text-octo-mute">
                {looping ? `⟜ back to ${ROMAN[targetIdx] ?? targetIdx + 1} · ×${s.loopMaxIterations}` : ""}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
