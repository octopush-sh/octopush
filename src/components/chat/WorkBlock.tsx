// The model's work in a Talk turn — its narration and its tool calls — hung on
// ONE hairline as quiet ledger rows (src/lib/talkWork.ts groups them). The
// director's ask sits on the panel surface and the answer is flush; the work
// between them is the quietest register of the three, mute and sage, no brass.
import { memo, useRef, useState } from "react";
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
  /** The turn this work belongs to is still streaming: no round folds yet,
   *  so a round growing past five calls never swaps rows out from under the
   *  reader. Rounds fold when the turn ends. */
  live?: boolean;

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

export const WorkBlock = memo(function WorkBlock({
  entries,
  calls,
  live = false,
  workspacePath,
  onOpenInEditor,
  onRunInTerminal,
}: Props) {
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
            live={live}
            workspacePath={workspacePath}
            onOpenInEditor={onOpenInEditor}
            onRunInTerminal={onRunInTerminal}
          />
        ),
      )}
    </article>
  );
});

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
  live,
  workspacePath,
  onOpenInEditor,
  onRunInTerminal,
}: {
  tools: Array<{ id: number; tool: ToolExecution }>;
  live: boolean;
  workspacePath?: string;
  onOpenInEditor?: (path: string) => void;
  onRunInTerminal?: (command: string) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const label = toolCallCount(tools.length);
  // A long round folds into one summary row, but only once its turn has
  // ended: while it streams, a round crossing five calls stays as it is.
  const foldable = tools.length > ROUND_FOLD_AT && !live;
  const [open, setOpen] = useState(false);
  // The moment a round becomes foldable (its turn just ended) it folds,
  // unless the reader is in it: a focused row keeps the round open, so focus
  // never drops to the page. Derived during render, before the commit that
  // would make the rows inert.
  const [wasFoldable, setWasFoldable] = useState(foldable);
  if (foldable !== wasFoldable) {
    setWasFoldable(foldable);
    if (foldable && typeof document !== "undefined" && groupRef.current?.contains(document.activeElement)) {
      setOpen(true);
    }
  }
  const summary = foldable ? roundSummary(tools.map((t) => t.tool)) : [];
  const plain = summary.map((p) => `${p.verb} ${p.objects.join(", ")}`).join(" · ");

  // ONE tree for every size: the rows always live under the same Reveal with
  // stable keys, so a round growing from five to six calls (or folding when
  // its turn ends) never remounts them. An opened row stays open and a
  // focused one keeps focus. The summary button is the only thing that
  // comes and goes, and it fades in.
  return (
    <div ref={groupRef} role="group" aria-label={label} className="flex flex-col">
      {foldable && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-tour={tourId("talk-work-fold")}
          title={open ? `Fold the ${label}` : `Show the ${label}: ${plain}`}
          className="octo-fade-in -ml-1.5 flex h-6 min-w-0 items-center gap-2.5 rounded px-1.5 text-left text-octo-mute transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)] hover:bg-[var(--brass-faint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-octo-brass"
        >
          <ChevronRight
            size={12}
            strokeWidth={1.75}
            aria-hidden
            className="shrink-0 transition-transform duration-[var(--dur-quick)] ease-[var(--ease-octo)]"
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
      )}
      {/* The Reveal clips its content, so it reaches 6px into the hairline's
          gutter and gives it back as padding: the rows' hover wash, which
          pulls left by the same 6px, is never cut. */}
      <Reveal open={!foldable || open} className="-ml-1.5">
        <div className="flex flex-col pl-1.5">
          {tools.map(({ id, tool }) => (
            <ToolCallCard
              key={`tool-${id}`}
              tool={tool}
              workspacePath={workspacePath}
              onOpenInEditor={onOpenInEditor}
              onRunInTerminal={onRunInTerminal}
            />
          ))}
        </div>
      </Reveal>
    </div>
  );
}
