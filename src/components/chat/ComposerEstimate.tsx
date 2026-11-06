import { formatPerMessageCost, formatTokenCount } from "../../lib/cost";

const NBSP = " ";
/** Same font and tracking in every state: the slot's `ch` width depends on them. */
const SLOT =
  "octo-estimate octo-tabular font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute";

/** The composer's per-message estimate, `≈ $0.02 · 3k tokens`, in a fixed
 *  slot (design-system S1/S2): one nowrap, tabular line whose width is set in
 *  `ch` by the bar's width, not by the figures, so it never wraps and never
 *  grows the bar as the estimate changes. The slot exists in every state; with
 *  nothing to estimate it is empty.
 *
 *  As the control bar (`.octo-composerbar`) narrows, the slot sheds on its own
 *  demotion ladder (styles.css): the word "tokens" first, then the count. The
 *  cost is the floor, and the full line stays in the tooltip.
 *
 *  The separators are no-break spaces: a rung is its own box, and a plain
 *  leading space would be dropped at its edge. */
export function ComposerEstimate({
  cost,
  tokens,
  modelName,
}: {
  cost: number | null;
  tokens: number;
  modelName: string;
}) {
  if (cost === null) {
    return <span className={SLOT} aria-hidden data-testid="composer-estimate" />;
  }
  const costText = formatPerMessageCost(cost);
  const countText = formatTokenCount(tokens);
  return (
    <span
      className={SLOT}
      title={`${costText} · ${countText} tokens. Estimate for ${modelName}; assumes 30% output ratio`}
      data-testid="composer-estimate"
      data-tour="talk-composer-estimate"
    >
      <span className="text-octo-brass">{costText}</span>
      <span className="octo-estimate-rung octo-estimate-count">
        <span className="opacity-50">{`${NBSP}·${NBSP}`}</span>
        {countText}
        <span className="octo-estimate-rung octo-estimate-unit">{`${NBSP}tokens`}</span>
      </span>
    </span>
  );
}
