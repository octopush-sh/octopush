import type { AiFinding } from "../../lib/aiReview";

const DOT: Record<AiFinding["severity"], string> = {
  high: "var(--brass-dim)",
  medium: "var(--color-octo-sage)",
  low: "var(--color-octo-mute)",
};

export function AiFindingCard({
  finding,
  onJump,
}: {
  finding: AiFinding;
  onJump: (file: string, line: number | null) => void;
}) {
  return (
    <div
      className="octo-rise-in border-l-2 px-2 py-1.5"
      style={{ borderLeftColor: finding.severity === "high" ? "var(--brass-dim)" : "var(--brass-rule-dim)" }}
      data-severity={finding.severity}
    >
      <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
        <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full" style={{ background: DOT[finding.severity] }} />
        <span>{finding.category} · {finding.severity}</span>
      </div>
      <div className="mt-0.5 text-[12px] text-octo-ivory">{finding.title}</div>
      {finding.detail && <div className="text-[11px] leading-[1.5] text-octo-sage">{finding.detail}</div>}
      {finding.file && (
        <button
          onClick={() => onJump(finding.file!, finding.line)}
          className="mt-0.5 font-mono text-[10px] text-octo-brass hover:underline focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          {finding.file}{finding.line != null ? `:${finding.line}` : ""} ⟶
        </button>
      )}
    </div>
  );
}
