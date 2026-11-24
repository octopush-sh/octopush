// The model's work in a Talk turn — its narration and its tool calls — hung on
// ONE hairline as quiet ledger rows (src/lib/talkWork.ts groups them). The
// director's ask sits on the panel surface and the answer is flush; the work
// between them is the quietest register of the three, mute and sage, no brass.
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolExecution } from "../../stores/chatStore";
import { ROUND_FOLD_AT, toolCallCount, type WorkEntry } from "../../lib/talkWork";
import { tourId } from "../../lib/tour/ids";
import { ToolCallCard, toolLabel, summarizeTool } from "../ToolCallCard";
import { ChatMarkdown } from "./ChatMarkdown";
import { Reveal } from "../primitives/Reveal";

interface Props {
  entries: WorkEntry[];
  calls: number;
  workspacePath?: string;
  onOpenInEditor?: (path: string) => void;
  onRunInTerminal?: (command: string) => void;
}

/** A folded round's one-line summary: calls of the same kind in a row are
 *  joined, file paths shortened to their names. `grep RateLimiter · read
 *  rateLimit.ts, redis.ts · run npm test`. */
export function roundSummary(tools: ToolExecution[]): Array<{ verb: string; objects: string[] }> {
  const parts: Array<{ verb: string; objects: string[] }> = [];
  for (const t of tools) {
    const verb = toolLabel(t.toolName).toLowerCase();
    const summary = summarizeTool(t.toolName, t.toolInput ?? {});
    const isPath = t.toolName === "read_file" || t.toolName === "write_file" || t.toolName === "edit_file";
    const object = isPath ? summary.split("/").pop() || summary : summary;
    const last = parts[parts.length - 1];
    if (last && last.verb === verb) last.objects.push(object);
    else parts.push({ verb, objects: [object] });
  }
  return parts;
}

export function WorkBlock({ entries, calls, workspacePath, onOpenInEditor, onRunInTerminal }: Props) {
  return (
    <article
      data-role="work"
      data-tour={tourId("talk-work")}
      aria-label={calls > 0 ? `Work, ${toolCallCount(calls)}` : "Work"}
      className="flex flex-col gap-0.5 border-l border-octo-hairline pl-3"
    >
      {entries.map((entry) =>
        entry.kind === "narration" ? (
          <NarrationLine key={`narration-${entry.id}`} text={entry.text} onOpenInEditor={onOpenInEditor} />
        ) : (
          <ToolRound
            key={`round-${entry.id}`}
            tools={entry.tools}
            workspacePath={workspacePath}
            onOpenInEditor={onOpenInEditor}
            onRunInTerminal={onRunInTerminal}
          />
        ),
      )}
    </article>
  );
}

/**
 * The model's words before a round's tool calls — its reasoning in the
 * open ("the tests import X, so let me check…"). A quiet sage line on the
 * work block's hairline, so ten tool rounds read as a train of thought
 * instead of a black box; never the eyebrow + key-phrase treatment of an
 * answer.
 */
function NarrationLine({ text, onOpenInEditor }: { text: string; onOpenInEditor?: (path: string) => void }) {
  return (
    <div
      data-role="narration"
      className="octo-fade-in octo-selectable py-1 text-[12.5px] leading-[1.55] text-octo-sage first:pt-0"
    >
      <ChatMarkdown text={text} onOpenInEditor={onOpenInEditor} />
    </div>
  );
}

function ToolRound({
  tools,
  workspacePath,
  onOpenInEditor,
  onRunInTerminal,
}: {
  tools: Array<{ id: number; tool: ToolExecution }>;
  workspacePath?: string;
  onOpenInEditor?: (path: string) => void;
  onRunInTerminal?: (command: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = toolCallCount(tools.length);
  const rows = tools.map(({ id, tool }) => (
    <ToolCallCard
      key={`tool-${id}`}
      tool={tool}
      workspacePath={workspacePath}
      onOpenInEditor={onOpenInEditor}
      onRunInTerminal={onRunInTerminal}
    />
  ));

  if (tools.length <= ROUND_FOLD_AT) {
    return (
      <div role="group" aria-label={label} className="flex flex-col">
        {rows}
      </div>
    );
  }

  // A long round folds into one summary row; the rows stay mounted under the
  // grid-rows Reveal (inert while folded), so opening it never re-renders them.
  const summary = roundSummary(tools.map((t) => t.tool));
  const plain = summary.map((p) => `${p.verb} ${p.objects.join(", ")}`).join(" · ");
  return (
    <div role="group" aria-label={label} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-tour={tourId("talk-work-fold")}
        title={open ? `Fold the ${label}` : `Show the ${label}: ${plain}`}
        className="-ml-1.5 flex h-6 min-w-0 items-center gap-2.5 rounded px-1.5 text-left text-octo-mute transition-colors duration-[220ms] hover:bg-[var(--brass-faint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          aria-hidden
          className="shrink-0 transition-transform duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        />
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.2em]">{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-sage">
          {summary.map((p, i) => (
            <span key={i}>
              {i > 0 && <span className="text-octo-mute"> · </span>}
              <span className="text-[9px] uppercase tracking-[0.2em] text-octo-mute">{p.verb}</span>{" "}
              {p.objects.join(", ")}
            </span>
          ))}
        </span>
      </button>
      <Reveal open={open}>
        <div className="flex flex-col pt-0.5">{rows}</div>
      </Reveal>
    </div>
  );
}
