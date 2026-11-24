import { useEffect, useMemo, useState } from "react";
import type { LiveTool } from "../../stores/chatStore";
import { toolLabel, summarizeTool } from "../ToolCallCard";
import { formatDuration } from "../../lib/duration";
import { prefersReducedMotion } from "../../lib/motion";
import { iconForTool } from "../../lib/roleIcons";

interface Props {
  tool: LiveTool;
}

/**
 * The running state of a tool call — shown between `chat://tool-start` and the
 * resolved `ToolCallCard`. A ledger row like the resolved one (tool icon · LABEL ·
 * summary, mute and sage) on the work hairline, with a live elapsed timer in a
 * fixed-width slot (stability S1/S2: no reflow) and a status dot sitting ON the
 * hairline: pulsing brass while running, its verdict once `done`. So a running
 * call settles into its resolved row in place instead of jumping from a card.
 *
 * Renders in the timeline shell (outside react-markdown), so it uses design
 * tokens directly — unlike ToolCallCard, which must inline hex.
 */
export function LiveToolCard({ tool }: Props) {
  const label = toolLabel(tool.toolName);
  const summary = summarizeTool(tool.toolName, tool.toolInput);
  const ToolIcon = iconForTool(tool.toolName);

  // Elapsed measures from the backend's real start timestamp (not card mount),
  // so a slow first paint doesn't under-report. While running we tick a `now`
  // clock; reduced-motion skips the interval but the value is still computed
  // from startedAt at every render (so it's never stuck at 0).
  const startMs = useMemo(() => {
    const t = Date.parse(tool.startedAt);
    return Number.isNaN(t) ? null : t;
  }, [tool.startedAt]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (tool.done || prefersReducedMotion()) return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [tool.done]);

  const shownMs =
    tool.done && tool.durationMs != null
      ? tool.durationMs
      : startMs != null
        ? Math.max(0, nowMs - startMs)
        : 0;

  const failed = tool.done && !tool.ok;
  return (
    <div className="octo-rise-in relative flex h-6 w-full items-center gap-2.5" aria-live="polite">
      {/* Status dot ON the work hairline (the row's parent draws it 12px to
          the left): pulsing brass while running, verdict colour when done. */}
      <span
        aria-hidden
        className={`absolute left-[-15.5px] top-1/2 -translate-y-1/2 ${tool.done ? "" : "animate-pulse"}`}
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: tool.done
            ? tool.ok
              ? "var(--color-octo-verdigris)"
              : "var(--color-octo-rouge)"
            : "var(--color-octo-brass)",
        }}
      />
      <span title={tool.toolName} className="shrink-0 text-octo-mute">
        <ToolIcon size={12} strokeWidth={1.75} />
      </span>
      <span className="min-w-12 shrink-0 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-sage">
        {summary}
      </span>
      {/* Fixed-width meta slot — never reflows the row as the timer ticks. A
          failure reads in rouge (the full error lands in the resolved row that
          replaces this one a beat later). */}
      <span
        className="octo-tabular shrink-0 font-mono text-[9px] uppercase tracking-[0.15em]"
        style={{ color: failed ? "var(--color-octo-rouge)" : "var(--color-octo-mute)" }}
      >
        {tool.done ? (tool.ok ? "done" : "failed") : "running"} · {formatDuration(shownMs)}
      </span>
    </div>
  );
}
