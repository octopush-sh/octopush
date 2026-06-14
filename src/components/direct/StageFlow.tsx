import type { PipelineStage } from "../../lib/ipc";
import { archetypeFor, TOOLS } from "../builder/graph";
import { ARTIFACT_ICON } from "../builder/icons";
import { ROMAN, stageTitle } from "../../lib/stageMeta";
import { ModelPicker } from "../ModelPicker";

interface Props {
  stages: PipelineStage[];
  /** position → overridden model id (the crew override map). */
  overrides: Record<number, string>;
  onOverride: (position: number, model: string) => void;
}

/** The selected pipeline drawn as a readable flow of stage cards — the
 *  launcher's centerpiece. It speaks the builder's node language (archetype
 *  icon, Roman numeral, substrate, tools, gate/loop) AND doubles as the crew
 *  editor: each card's model chip overrides that stage in place, so there is no
 *  separate "team" table. Cards are fixed-width and WRAP (never collapsed, never
 *  scroll-hidden), so every stage stays legible and visible at any width. */
export function StageFlow({ stages, overrides, onOverride }: Props) {
  const sorted = [...stages].sort((a, b) => a.position - b.position);

  return (
    <div className="flex flex-wrap items-stretch gap-y-3">
      {sorted.map((s, i) => (
        <div key={s.id} className="flex items-center">
          {i > 0 && (
            <span className="px-2 text-octo-brass/70" title={sorted[i - 1].checkpoint ? "Gated handoff" : "Hands off to"}>
              {sorted[i - 1].checkpoint ? "⟜" : "⟶"}
            </span>
          )}
          <FlowStageCard
            stage={s}
            index={i}
            model={overrides[s.position] ?? s.agentModel}
            onModel={(m) => onOverride(s.position, m)}
          />
        </div>
      ))}
    </div>
  );
}

function FlowStageCard({
  stage,
  index,
  model,
  onModel,
}: {
  stage: PipelineStage;
  index: number;
  model: string;
  onModel: (m: string) => void;
}) {
  const a = archetypeFor(stage.role);
  const Icon = ARTIFACT_ICON[a.artifact];
  const cliManaged = stage.substrate === "cli";
  // `!stage.tools` covers both null (archetype default = all) and a legacy row
  // that never carried the column.
  const granted = (toolId: string) => cliManaged || !stage.tools || stage.tools.includes(toolId);
  const looping = stage.loopTargetPosition !== null;

  return (
    <div
      // Staggered entrance — one orchestrated reveal as the flow paints in.
      className="octo-rise-in flex w-[210px] shrink-0 flex-col gap-2.5 rounded-lg border border-octo-hairline bg-octo-panel-2 px-3.5 py-3"
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <div className="flex items-center gap-2">
        <span className="text-octo-sage">
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1 truncate font-serif text-[14px] text-octo-ivory" title={stageTitle(stage)}>
          {stageTitle(stage)}
        </span>
        <span className="font-mono text-[11px] text-octo-brass">{ROMAN[index] ?? index + 1}</span>
      </div>

      {/* Model chip — clicking it tunes the crew right on the pipeline. */}
      <ModelPicker
        activeModel={model}
        onSelectModel={onModel}
        allowedProviders={cliManaged ? ["anthropic"] : undefined}
      />

      <div className="flex items-center gap-2">
        <span
          className={`rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ${
            cliManaged
              ? "bg-[var(--state-purple-ghost)] text-octo-state-purple"
              : "bg-[var(--state-blue-ghost)] text-octo-state-blue"
          }`}
        >
          {stage.substrate}
        </span>
        <span
          className="flex items-center gap-1"
          title={cliManaged ? "Managed by the CLI agent" : `Tools: ${TOOLS.filter((t) => granted(t.id)).map((t) => t.label).join(" · ") || "none"}`}
        >
          {TOOLS.map((t) => (
            <span
              key={t.id}
              className={`h-1.5 w-1.5 rounded-full ${granted(t.id) ? "bg-octo-sage" : "border border-octo-hairline"}`}
            />
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em]">
          {stage.checkpoint && (
            <span className="text-octo-brass" title="Pauses for your approval">⟜ gate</span>
          )}
          {looping && (
            <span className="text-octo-brass" title={`Loops back up to ×${stage.loopMaxIterations}`}>
              ⟲ ×{stage.loopMaxIterations}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
