import { useRef } from "react";
import { X } from "lucide-react";
import { ModelPicker } from "../ModelPicker";
import { Listbox } from "../controls/Listbox";
import { SegmentedControl } from "../controls/SegmentedControl";
import { TogglePill } from "../controls/TogglePill";
import { Stepper } from "../controls/Stepper";
import { Reveal } from "../primitives/Reveal";
import { archetypes, archetypeFor, stageLabel, TOOLS, type StageNode, type StageNodeData } from "./graph";
import { iconForRole } from "../../lib/roleIcons";
import { useRolesStore } from "../../stores/rolesStore";

const SUBSTRATE_OPTIONS = [
  { value: "api" as const, label: "API", activeClass: "bg-[var(--state-blue-ghost)] text-octo-state-blue" },
  { value: "cli" as const, label: "CLI", activeClass: "bg-[var(--state-purple-ghost)] text-octo-state-purple" },
];
const MODE_OPTIONS = [
  { value: "gated" as const, label: "Gated" },
  { value: "auto" as const, label: "Auto" },
];
/** Reasoning-effort segments. `off` is the null state (no thinking). Labels are
 *  compact so all six fit the inspector's full-width track. */
const EFFORT_OPTIONS = [
  { value: "off" as const, label: "Off", title: "No extra thinking (fastest, cheapest)" },
  { value: "low" as const, label: "Low", title: "A little reasoning before answering" },
  { value: "medium" as const, label: "Med", title: "Moderate reasoning" },
  { value: "high" as const, label: "High", title: "Deep reasoning (slower, pricier)" },
  { value: "xhigh" as const, label: "XHi", title: "Very deep reasoning" },
  { value: "max" as const, label: "Max", title: "Maximum reasoning depth" },
];

export interface LoopState {
  target: string | null;
  max: number;
  mode: "gated" | "auto";
}

interface Props {
  node: StageNode;
  /** Valid loop targets (this node's flow-ancestors), for the "Return to" list. */
  ancestors: { value: string; label: string }[];
  loop: LoopState;
  /** This stage's first validation error / caution, surfaced inline so the
   *  amber/rouge ring on the node always has a stated reason. */
  issue?: { error?: string; warning?: string };
  onPatch: (partial: Partial<StageNodeData>) => void;
  onSetLoop: (next: LoopState) => void;
  onClose: () => void;
}

/** The Companion: edits the selected stage as an agent — archetype, model,
 *  substrate, tools, gate, turn budget, free-form instructions, and (for review
 *  archetypes) the loop. The archetype is the operability anchor; everything
 *  else is the author's to shape. */
export function StageInspector({ node, ancestors, loop, issue, onPatch, onSetLoop, onClose }: Props) {
  const data = node.data;
  // Subscribe to roles store so the Listbox re-renders when roles load late.
  // archetypes() reads the module-level cache populated by setArchetypes() —
  // subscribing to `loaded` here guarantees a re-render after the initial load.
  useRolesStore((s) => s.loaded);
  const a = archetypeFor(data.role);
  const roleOptions = archetypes().map((arch) => ({ value: arch.role, label: arch.label, description: arch.description }));
  const isCli = data.substrate === "cli";
  const grantedSet = new Set(data.tools ?? TOOLS.map((t) => t.id));

  // Remember the last real loop config so toggling "don't loop" and back
  // doesn't silently reset the cap/mode to the defaults.
  const lastLoop = useRef<{ max: number; mode: "gated" | "auto" }>({ max: loop.max, mode: loop.mode });
  const applyLoop = (next: LoopState) => {
    if (next.target !== null) lastLoop.current = { max: next.max, mode: next.mode };
    onSetLoop(next);
  };

  const toggleTool = (toolId: string) => {
    const next = new Set(grantedSet);
    if (next.has(toolId)) {
      if (next.size === 1) return; // never strip the last tool — the stage must be able to act
      next.delete(toolId);
    } else {
      next.add(toolId);
    }
    onPatch({ tools: TOOLS.filter((t) => next.has(t.id)).map((t) => t.id) });
  };

  return (
    <div className="octo-rise-in flex w-[300px] flex-col gap-4 overflow-y-auto rounded-lg border border-octo-hairline bg-octo-panel/95 p-4 backdrop-blur-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
            {(() => {
              const HeaderIcon = iconForRole(data.role);
              return <HeaderIcon size={11} strokeWidth={1.75} />;
            })()}
            {a.label}
          </p>
          <p className="font-serif text-[16px] text-octo-ivory">{stageLabel(data)}</p>
        </div>
        <button
          type="button"
          aria-label="Close inspector"
          title="Close"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-octo-mute transition-colors duration-[150ms] hover:text-octo-ivory"
        >
          <X size={13} />
        </button>
      </div>

      {/* Why this stage is flagged — the cause behind the node's ring/icon. */}
      {issue?.error ? (
        <div className="rounded-md border-l-2 border-octo-rouge bg-[var(--rouge-ghost)] px-3 py-2 font-mono text-[11px] leading-relaxed text-octo-rouge">
          {issue.error}
        </div>
      ) : issue?.warning ? (
        <div className="rounded-md border-l-2 border-octo-warning bg-[var(--warning-ghost)] px-3 py-2 font-mono text-[11px] leading-relaxed text-octo-warning">
          {issue.warning}
        </div>
      ) : null}

      {/* Name */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">Name</span>
        <input
          value={data.customName ?? ""}
          onChange={(e) => onPatch({ customName: e.target.value })}
          placeholder={a.label}
          aria-label="Stage name"
          className="w-full rounded-sm border border-octo-hairline bg-octo-onyx px-2 py-1.5 font-serif text-[13px] text-octo-ivory outline-none transition-colors duration-[150ms] placeholder:text-octo-mute focus:border-[var(--brass-dim)]"
        />
      </label>

      {/* Archetype */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">Archetype</span>
        <Listbox value={data.role} options={roleOptions} onChange={(r) => onPatch({ role: r })} ariaLabel="Stage archetype" className="w-full" />
      </label>

      {/* Model */}
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">Model</span>
        <ModelPicker
          activeModel={data.agentModel}
          onSelectModel={(m) => onPatch({ agentModel: m })}
          allowedProviders={isCli ? ["anthropic"] : undefined}
        />
      </div>

      {/* Reasoning effort — how hard the model thinks per turn. Off = no thinking.
          API substrate only: the CLI agent manages its own reasoning. */}
      <div className="flex flex-col gap-1">
        <span
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute"
          title="How hard the model thinks on this stage — the cost/quality lever. Off adds no thinking. Applies to API stages only."
        >
          Reasoning
        </span>
        <SegmentedControl
          fill
          disabled={isCli}
          options={EFFORT_OPTIONS}
          value={data.effort ?? "off"}
          onChange={(v) => onPatch({ effort: v === "off" ? null : v })}
          ariaLabel="Reasoning effort"
        />
        {isCli && <span className="font-mono text-[9px] text-octo-mute">The CLI agent manages its own reasoning.</span>}
      </div>

      {/* Escalate on failure — retry ONCE at a stronger tier before halting.
          The model swap applies to both substrates (the CLI runner reads the
          model too); the effort bump is API-only, like the base effort. */}
      <div className="flex flex-col gap-2">
        <span
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute"
          title="If this stage fails, retry once with this model/effort before halting."
        >
          Escalate on failure
        </span>
        <div className="flex items-center gap-2">
          <ModelPicker
            activeModel={data.escalateModel ?? ""}
            onSelectModel={(m) => onPatch({ escalateModel: m })}
            allowedProviders={isCli ? ["anthropic"] : undefined}
          />
          {data.escalateModel ? (
            <button
              type="button"
              aria-label="Clear escalation model"
              title="No escalation model"
              onClick={() => onPatch({ escalateModel: null })}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-octo-mute transition-colors duration-[150ms] hover:text-octo-ivory"
            >
              <X size={12} />
            </button>
          ) : (
            <span className="font-mono text-[9px] text-octo-mute">— none —</span>
          )}
        </div>
        <SegmentedControl
          fill
          disabled={isCli}
          options={EFFORT_OPTIONS}
          value={data.escalateEffort ?? "off"}
          onChange={(v) => onPatch({ escalateEffort: v === "off" ? null : v })}
          ariaLabel="Escalation effort"
        />
        {isCli && <span className="font-mono text-[9px] text-octo-mute">The CLI agent manages its own reasoning.</span>}
      </div>

      {/* Substrate + gate */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">Substrate</span>
          <SegmentedControl options={SUBSTRATE_OPTIONS} value={data.substrate} onChange={(v) => onPatch({ substrate: v })} ariaLabel="Execution substrate" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">Approval</span>
          <TogglePill on={data.checkpoint} onChange={(v) => onPatch({ checkpoint: v })} label="⟜ gate" ariaLabel="Approval gate" />
        </div>
      </div>

      {/* Tools */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">Tools</span>
        <div className="flex flex-wrap gap-1.5" aria-disabled={isCli}>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="switch"
              aria-checked={grantedSet.has(t.id)}
              disabled={isCli}
              title={t.hint}
              onClick={() => toggleTool(t.id)}
              className={`rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors duration-[150ms] disabled:opacity-40 ${
                grantedSet.has(t.id)
                  ? "border-[var(--brass-dim)] bg-[var(--brass-ghost)] text-octo-brass"
                  : "border-octo-hairline text-octo-mute hover:text-octo-sage"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {isCli && <span className="font-mono text-[9px] text-octo-mute">The CLI agent manages its own tools.</span>}
      </div>

      {/* Max turns */}
      <label className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">Max turns</span>
        <Stepper value={data.maxIterations} min={1} max={100} onChange={(v) => onPatch({ maxIterations: v })} ariaLabel="Max turns" />
      </label>

      {/* Instructions */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">Instructions</span>
        <textarea
          value={data.instructions ?? ""}
          onChange={(e) => onPatch({ instructions: e.target.value })}
          placeholder="Shape this stage in your own words…"
          aria-label="Stage instructions"
          rows={3}
          className="w-full resize-y rounded-sm border border-octo-hairline bg-octo-onyx px-2 py-1.5 font-mono text-[11px] leading-relaxed text-octo-ivory outline-none transition-colors duration-[150ms] placeholder:text-octo-mute focus:border-[var(--brass-dim)]"
        />
      </label>

      {/* Loop — review archetypes only */}
      <Reveal open={a.canLoop}>
        <div className="flex flex-col gap-2 border-t border-octo-hairline pt-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">⟲ Loop</span>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">Return to</span>
            <Listbox
              value={loop.target ?? ""}
              options={[{ value: "", label: "— don't loop —" }, ...ancestors]}
              onChange={(v) =>
                applyLoop(
                  v
                    ? { target: v, max: lastLoop.current.max, mode: lastLoop.current.mode }
                    : { ...loop, target: null },
                )
              }
              placeholder="— don't loop —"
              ariaLabel="Loop target"
              className="w-full"
            />
          </label>
          <Reveal open={loop.target !== null}>
            <div className="flex items-center justify-between gap-2 pt-1">
              <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-octo-mute">
                max ×
                <Stepper value={loop.max} min={1} max={9} onChange={(v) => applyLoop({ ...loop, max: v })} ariaLabel="Max loop-backs" />
              </label>
              <SegmentedControl options={MODE_OPTIONS} value={loop.mode} onChange={(v) => applyLoop({ ...loop, mode: v })} ariaLabel="Loop mode" />
            </div>
          </Reveal>
        </div>
      </Reveal>
    </div>
  );
}
