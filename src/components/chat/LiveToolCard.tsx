import { useEffect, useRef, useState } from "react";
import type { LiveTool } from "../../stores/chatStore";
import { toolLabel, summarizeTool } from "../ToolCallCard";
import { prefersReducedMotion } from "../../lib/motion";

interface Props {
  tool: LiveTool;
}

/**
 * The running state of a tool call — shown between `chat://tool-start` and the
 * resolved `ToolCallCard`. Renders the same `§ LABEL summary` chrome with a
 * live elapsed timer in a fixed-width slot (stability S1/S2: no reflow), a
 * pulsing brass dot while running, and a verdict glyph once `done`.
 *
 * Renders in the timeline shell (outside react-markdown), so it uses design
 * tokens directly — unlike ToolCallCard, which must inline hex.
 */
export function LiveToolCard({ tool }: Props) {
  const label = toolLabel(tool.toolName);
  const summary = summarizeTool(tool.toolName, tool.toolInput);

  // Elapsed timer ticks from mount. Once done, freeze on the reported duration.
  const mountRef = useRef<number>(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (tool.done) return;
    if (prefersReducedMotion()) return;
    const start = performance.now();
    mountRef.current = start;
    const id = setInterval(() => setElapsedMs(performance.now() - start), 200);
    return () => clearInterval(id);
  }, [tool.done]);

  const shownMs = tool.done && tool.durationMs != null ? tool.durationMs : elapsedMs;

  return (
    <div
      className="octo-rise-in flex w-full items-center gap-2.5 rounded-md border px-3 py-2"
      style={{
        borderColor: tool.done && !tool.ok ? "var(--color-octo-rouge)" : "var(--brass-dim)",
        background: "var(--brass-ghost)",
      }}
      aria-live="polite"
    >
      {/* Status dot — pulsing brass while running, verdict color when done. */}
      <span
        aria-hidden
        className={tool.done ? "" : "animate-pulse"}
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          flexShrink: 0,
          background: tool.done
            ? tool.ok
              ? "var(--color-octo-verdigris)"
              : "var(--color-octo-rouge)"
            : "var(--color-octo-brass)",
        }}
      />
      <span
        aria-hidden
        className="shrink-0 font-serif text-[13px] text-octo-brass"
      >
        §
      </span>
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-sage">
        {summary}
      </span>
      {/* Fixed-width meta slot — never reflows the row as the timer ticks. */}
      <span className="octo-tabular shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
        {tool.done ? (tool.ok ? "done" : "failed") : "running"} · {formatElapsed(shownMs)}
      </span>
    </div>
  );
}

/** Compact mm:ss.s / s.s elapsed format with a stable character width. */
function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}:${String(rem).padStart(2, "0")}`;
}
