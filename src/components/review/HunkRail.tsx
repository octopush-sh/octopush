import { CheckCircle, XCircle, HelpCircle } from "lucide-react";

interface Props {
  range: string;
  additions: number;
  deletions: number;
  focused: boolean;
  staged: boolean;
  onAccept: () => void;
  onReject: () => void;
  onWhy: () => void;
}

export function HunkRail({
  range,
  additions,
  deletions,
  focused,
  staged,
  onAccept,
  onReject,
  onWhy,
}: Props) {
  return (
    <div
      data-focused={focused}
      className="sticky top-0 z-10 flex items-center gap-2 border-l-2 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] backdrop-blur-sm"
      style={{
        borderLeftColor: focused ? "var(--brass-dim)" : "var(--brass-rule-dim)",
        background: focused ? "var(--brass-faint)" : "var(--onyx-40)",
        opacity: staged ? 0.55 : 1,
      }}
    >
      <span className="text-octo-mute">
        {focused ? "⟶ " : ""}
        {range}
        {staged ? " · staged ✓" : ""}
      </span>
      <span className="ml-auto flex items-center gap-2">
        {additions > 0 && (
          <span className="text-octo-verdigris">+{additions}</span>
        )}
        {deletions > 0 && (
          <span className="text-octo-rouge">−{deletions}</span>
        )}
        {!staged && (
          <>
            <button
              onClick={onWhy}
              aria-label="Why this change?"
              className="rounded px-1.5 py-0.5 text-octo-mute transition-colors hover:text-octo-sage focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              <HelpCircle size={11} className="inline" /> Why?
            </button>
            <button
              onClick={onReject}
              aria-label="Reject hunk"
              className="rounded px-1.5 py-0.5 text-octo-sage transition-colors hover:text-octo-rouge focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              <XCircle size={11} className="inline" /> Reject
            </button>
            <button
              onClick={onAccept}
              aria-label="Accept hunk"
              className="rounded px-2 py-0.5 text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass"
              style={{
                background: "var(--brass-ghost)",
                border: "1px solid var(--brass-dim)",
              }}
            >
              <CheckCircle size={11} className="inline" /> Accept
            </button>
          </>
        )}
      </span>
    </div>
  );
}
