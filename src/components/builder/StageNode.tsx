import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { X, AlertTriangle } from "lucide-react";
import { archetypeFor, stageLabel, TOOLS, type StageNode as StageNodeT } from "./graph";
import { ARTIFACT_ICON } from "./icons";
import { useBuilder } from "./BuilderContext";

/** A short, human model id: drop the provider prefix and date suffix noise. */
function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function StageNodeImpl({ id, data, selected }: NodeProps<StageNodeT>) {
  const a = archetypeFor(data.role);
  const Icon = ARTIFACT_ICON[a.artifact];
  const { validation, onRemove, canRemove } = useBuilder();
  const issue = validation[id];

  // Ring priority: error > selected > warning > resting.
  const ring = issue?.error
    ? "border-octo-rouge"
    : selected
      ? "border-[var(--brass-dim)] shadow-[0_0_0_3px_var(--brass-ghost)]"
      : issue?.warning
        ? "border-octo-warning"
        : "border-octo-hairline";

  // The CLI agent manages its own tools, so the allowlist doesn't apply there —
  // show it as "managed" rather than implying a restriction we don't enforce.
  const cliManaged = data.substrate === "cli";
  const granted = (toolId: string) => cliManaged || data.tools === null || data.tools.includes(toolId);
  const toolSummary = cliManaged
    ? "Managed by the CLI agent"
    : data.tools === null
      ? "All tools"
      : TOOLS.filter((t) => granted(t.id)).map((t) => t.label).join(" · ") || "No tools";

  return (
    <div
      className={`group octo-rise-in relative w-[228px] rounded-lg border bg-octo-panel-2 px-3 py-2.5 transition-[border-color,box-shadow] duration-[180ms] ${ring}`}
    >
      {/* Inputs arrive at the top; the stage's output leaves from the bottom. */}
      <Handle type="target" position={Position.Top} className="octo-flow-handle" title="Inputs from upstream stages" />
      <Handle type="source" position={Position.Bottom} className="octo-flow-handle" title="Feeds downstream stages" />

      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-octo-brass">
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-[14px] leading-tight text-octo-ivory" title={stageLabel(data)}>
            {stageLabel(data)}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-octo-mute">
            {a.label.toLowerCase()} · {shortModel(data.agentModel)}
          </p>
        </div>
        {canRemove && (
          <button
            type="button"
            aria-label={`Remove ${stageLabel(data)}`}
            title="Remove stage"
            // nodrag keeps a click on the X from starting a node drag.
            className="nodrag pointer-events-auto -mr-1 -mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-octo-mute opacity-0 transition-[color,opacity] duration-[150ms] hover:text-octo-rouge focus:opacity-100 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(id);
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        {/* Substrate chip */}
        <span
          className={`rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ${
            data.substrate === "cli"
              ? "bg-[var(--state-purple-ghost)] text-octo-state-purple"
              : "bg-[var(--state-blue-ghost)] text-octo-state-blue"
          }`}
        >
          {data.substrate}
        </span>
        {/* Tool dots */}
        <span className="flex items-center gap-1" title={`Tools: ${toolSummary}`}>
          {TOOLS.map((t) => (
            <span
              key={t.id}
              className={`h-1.5 w-1.5 rounded-full ${granted(t.id) ? "bg-octo-brass" : "border border-octo-hairline"}`}
            />
          ))}
        </span>
        {/* Gate marker */}
        {data.checkpoint && (
          <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.18em] text-octo-brass" title="Pauses for your approval">
            ⟜ gate
          </span>
        )}
        {/* Validation marker (when there's no gate sharing the right slot) */}
        {!data.checkpoint && issue?.warning && !issue.error && (
          <span className="ml-auto text-octo-warning" title={issue.warning}>
            <AlertTriangle size={11} strokeWidth={1.75} />
          </span>
        )}
      </div>
    </div>
  );
}

export const StageNode = memo(StageNodeImpl);
