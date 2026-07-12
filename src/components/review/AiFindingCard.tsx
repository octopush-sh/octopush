import { PenLine } from "lucide-react";
import type { AiFinding } from "../../lib/aiReview";

/** Severity speaks through color, not brass: rouge = high, warning = medium,
 *  mute = low. Brass stays reserved for the jump glyph and active states. */
const SEVERITY_COLOR: Record<AiFinding["severity"], string> = {
  high: "var(--color-octo-rouge)",
  medium: "var(--color-octo-warning)",
  low: "var(--color-octo-mute)",
};

export function AiFindingCard({
  finding,
  onJump,
  onEdit,
}: {
  finding: AiFinding;
  /** Navigate to the finding's location in the diff (scroll + highlight). */
  onJump: (file: string, line: number | null) => void;
  /** Optional: open the file in the editor at the line, to fix it directly.
   *  When omitted (e.g. the unit test), only the jump affordance renders. */
  onEdit?: (file: string, line: number | null) => void;
}) {
  const color = SEVERITY_COLOR[finding.severity];
  return (
    <div
      className="octo-rise-in rounded-r-sm border-l-2 px-2 py-1.5 transition-colors hover:bg-[var(--brass-faint)]"
      style={{ borderLeftColor: color }}
      data-severity={finding.severity}
    >
      <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
        {/* The dot carries the severity; no text label. */}
        <span
          role="img"
          aria-label={`severity: ${finding.severity}`}
          title={`severity: ${finding.severity}`}
          className="inline-block h-[6px] w-[6px] rounded-full"
          style={{ background: color }}
        />
        <span>{finding.category}</span>
      </div>
      <div className="mt-0.5 text-[12px] text-octo-ivory">{finding.title}</div>
      {finding.detail && <div className="text-[11px] leading-[1.5] text-octo-sage">{finding.detail}</div>}
      {finding.file && (
        <div className="mt-0.5 flex items-center gap-3">
          <button
            onClick={() => onJump(finding.file!, finding.line)}
            className="font-mono text-[10px] text-octo-brass hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            {finding.file}{finding.line != null ? `:${finding.line}` : ""}
          </button>
          {onEdit && (
            <button
              onClick={() => onEdit(finding.file!, finding.line)}
              aria-label="Open in editor"
              title="Open in editor to fix"
              className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.12em] text-octo-mute transition-colors hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              <PenLine size={11} /> Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}
