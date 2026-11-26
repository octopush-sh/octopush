import { useId, useState } from "react";
import { formatTokenCount } from "../../lib/cost";
import { blockBody, type SentContextBlock } from "../../lib/sentContext";
import { quoteToken } from "../../lib/talkContext";
import { tourId } from "../../lib/tour/ids";
import { Reveal } from "../primitives/Reveal";
import { ICON, WHAT } from "./ContextChips";

/** Past this many lines a block opens capped at 256px, with "Show full block". */
const CAPPED_LINES = 15;

const CHIP = "flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors";

/**
 * The `@` context an ask was sent with (#1150), under the ask: the composer's
 * chips, kept. A chip opens its block in place on the grid-rows `Reveal`, as
 * the model received it, in a mono `<pre>` capped at 256px; a block left out
 * (a possible secret, or one that couldn't be read) is a muted chip saying
 * why, with nothing to open.
 */
export function SentContext({ content, blocks }: { content: string; blocks: SentContextBlock[] }) {
  const [open, setOpen] = useState<number | null>(null);
  // The block last opened stays in the region while it closes.
  const [shown, setShown] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const regionId = useId();

  function toggle(i: number) {
    setOpen(open === i ? null : i);
    if (open !== i) {
      setShown(i);
      setFull(false);
    }
  }

  const body = shown != null ? blockBody(content, blocks[shown]) : "";
  const long = body.split("\n").length > CAPPED_LINES;

  return (
    <div className="mt-2" data-tour={tourId("talk-turn-context")}>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Context sent with this message">
        {blocks.map((b, i) => {
          const Icon = ICON[b.kind];
          const what = `${WHAT[b.kind]} · @${quoteToken(b.token)}`;
          if (b.notIncluded) {
            const why = `Not included: ${b.notIncluded}`;
            return (
              <span
                key={b.token}
                role="img"
                title={`${why} · @${quoteToken(b.token)}`}
                aria-label={`${b.label}, ${why}`}
                className={`${CHIP} border-dashed border-octo-hairline text-octo-mute opacity-70`}
              >
                <Icon size={11} aria-hidden />
                <span className="max-w-[12rem] truncate">{b.label}</span>
              </span>
            );
          }
          const isOpen = open === i;
          return (
            <button
              key={b.token}
              type="button"
              onClick={() => toggle(i)}
              aria-expanded={isOpen}
              aria-controls={regionId}
              title={`${what} · ≈ ${formatTokenCount(b.tokens)} tokens · ${isOpen ? "Hide" : "Show"} the block`}
              className={`${CHIP} bg-octo-bg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
                isOpen ? "border-octo-brass-dim text-octo-brass" : "border-octo-hairline text-octo-sage hover:text-octo-ivory"
              }`}
            >
              <Icon size={11} className={isOpen ? "" : "text-octo-mute"} aria-hidden />
              <span className="max-w-[12rem] truncate">{b.label}</span>
              <span className="octo-tabular text-octo-mute">≈ {formatTokenCount(b.tokens)}</span>
            </button>
          );
        })}
      </div>
      <Reveal open={open !== null}>
        <div id={regionId} role="region" aria-label={shown != null ? `@${quoteToken(blocks[shown].token)} as sent` : undefined}>
          <pre
            key={shown ?? -1}
            className={`octo-fade-in octo-selectable mt-2 overflow-auto rounded-md border border-octo-hairline bg-octo-bg px-3 py-2 font-mono text-[11px] leading-[1.5] text-octo-sage ${
              full ? "" : "max-h-[256px]"
            }`}
          >
            {body}
          </pre>
          {long && (
            <button
              type="button"
              onClick={() => setFull((f) => !f)}
              className="mt-1 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute transition-colors hover:text-octo-brass"
            >
              {full ? "Show less" : "Show full block"}
            </button>
          )}
        </div>
      </Reveal>
    </div>
  );
}
