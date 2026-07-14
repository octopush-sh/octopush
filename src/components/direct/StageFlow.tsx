import { useState } from "react";
import { Pencil } from "lucide-react";
import type { PipelineStage } from "../../lib/ipc";
import { TOOLS } from "../builder/graph";
import { iconForRole } from "../../lib/roleIcons";
import { stageTitle } from "../../lib/stageMeta";
import { ModelPicker } from "../ModelPicker";
import { Reveal } from "../primitives/Reveal";
import { IconButton } from "../controls/IconButton";

interface Props {
  stages: PipelineStage[];
  /** position → overridden model id (the crew override map). */
  overrides: Record<number, string>;
  onOverride: (position: number, model: string) => void;
}

/** The selected ensemble's crew at two altitudes. At rest: ONE quiet line —
 *  role icon + name (+ the overridden model in mute), hairline connectors, the
 *  ⟜ gate mark on the stage that pauses for approval, ⟲ ×N on a looping
 *  review. The pencil unfolds the crew editor (Reveal): wrapping stage cards
 *  whose ModelPicker overrides that stage in place. Progressive disclosure
 *  over a standing table (§9); nothing lost, one click away. */
export function StageFlow({ stages, overrides, onOverride }: Props) {
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  const [editing, setEditing] = useState(false);
  // The crew editor mounts lazily on first open, then stays mounted so later
  // closes still get Reveal's collapse animation — but at rest, before the
  // pencil is ever touched, no CrewCard/ModelPicker exists in the DOM at all
  // (the quiet line is the only crew content until the user asks for more).
  const [everOpened, setEverOpened] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-2 rounded-lg border border-octo-hairline bg-octo-panel-2 px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-y-2">
          {sorted.map((s, i) => {
            const Icon = iconForRole(s.role);
            const override = overrides[s.position];
            const looping = s.loopTargetPosition !== null;
            return (
              <span key={s.id} className="flex items-center">
                {i > 0 && <span className="mx-2 h-px w-[22px] shrink-0 bg-octo-hairline" aria-hidden="true" />}
                {s.checkpoint && (
                  <span className="mr-1 font-mono text-[12px] text-octo-brass" title="Pauses for your approval">
                    ⟜
                  </span>
                )}
                <span className="text-octo-sage" title={s.role.replace(/_/g, " ")}>
                  <Icon size={11} strokeWidth={1.75} />
                </span>
                <span className="ml-1.5 max-w-[32ch] truncate text-[12px] text-octo-sage" title={stageTitle(s)}>
                  {stageTitle(s)}
                </span>
                {override && (
                  <span className="ml-1.5 font-mono text-[10px] text-octo-mute" title="Model override for this run">
                    · {override}
                  </span>
                )}
                {s.effort && s.substrate !== "cli" && (
                  <span className="ml-1.5 font-mono text-[10px] text-octo-brass" title="Reasoning effort for this stage">
                    · {s.effort}
                  </span>
                )}
                {looping && (
                  <span
                    className="ml-1.5 font-mono text-[10px] text-octo-brass"
                    title={`Loops back up to ×${s.loopMaxIterations}`}
                  >
                    ⟲ ×{s.loopMaxIterations}
                  </span>
                )}
              </span>
            );
          })}
        </div>
        <IconButton
          label={editing ? "Close the crew editor" : "Edit the crew"}
          ariaExpanded={editing}
          onClick={() => {
            const next = !editing;
            setEditing(next);
            if (next) setEverOpened(true);
          }}
        >
          <Pencil size={12} strokeWidth={1.75} />
        </IconButton>
      </div>

      {everOpened && (
        <Reveal open={editing}>
          <div className="flex flex-wrap gap-3 pt-3">
            {sorted.map((s, i) => (
              <CrewCard
                key={s.id}
                stage={s}
                index={i}
                model={overrides[s.position] ?? s.agentModel}
                onModel={(m) => onOverride(s.position, m)}
              />
            ))}
          </div>
        </Reveal>
      )}
    </div>
  );
}

function CrewCard({
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
  const Icon = iconForRole(stage.role);
  const cliManaged = stage.substrate === "cli";
  // `!stage.tools` covers both null (archetype default = all) and a legacy row
  // that never carried the column.
  const granted = (toolId: string) => cliManaged || !stage.tools || stage.tools.includes(toolId);
  const looping = stage.loopTargetPosition !== null;

  return (
    <div
      className="octo-rise-in flex w-[210px] shrink-0 flex-col gap-2.5 rounded-lg border border-octo-hairline bg-octo-panel-2 px-3.5 py-3"
      style={{ animationDelay: `calc(${Math.min(index, 8)} * var(--stagger-step))` }}
    >
      <div className="flex items-center gap-2">
        <span className="text-octo-sage" title={stage.role.replace(/_/g, " ")}>
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1 truncate font-serif text-[14px] text-octo-ivory" title={stageTitle(stage)}>
          {stageTitle(stage)}
        </span>
        <span className="font-mono text-[10px] text-octo-mute">{index + 1}</span>
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
        {stage.effort && !cliManaged && (
          <span
            className="rounded-sm bg-[var(--brass-ghost)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-brass"
            title="Reasoning effort for this stage"
          >
            {stage.effort}
          </span>
        )}
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
