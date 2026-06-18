import { clsx } from "clsx";
import { useLayoutEffect, useRef, useState } from "react";
import { MODES, MODE_LABELS, MODE_SHORTCUTS, type WorkspaceMode } from "../lib/modes";
import { useAttentionStore } from "../stores/attentionStore";

interface Props {
  mode: WorkspaceMode;
  onChange: (next: WorkspaceMode) => void;
  /** When set, an attention flag for this workspace will pulse the
   *  Run or Talk tab (whichever corresponds to the flag's kind), so
   *  the user knows to switch modes *within* the workspace they're
   *  already in. Without this, an in-workspace alert would be
   *  silently swallowed by the cross-workspace monogram filter. */
  workspaceId?: string;
}

export function ModeSwitcher({ mode, onChange, workspaceId }: Props) {
  const flag = useAttentionStore((s) =>
    workspaceId ? s.flagsByWs[workspaceId] : undefined,
  );
  // Map the flag's kind to the mode tab that should pulse. We only
  // pulse when the user is in a DIFFERENT mode than the one needing
  // attention — otherwise the alert and the user are already on the
  // same surface and the pulse is just noise.
  const flagMode: WorkspaceMode | null =
    flag?.kind === "chat" ? "talk" : flag?.kind === "terminal" ? "run" : null;
  const shouldPulse = (m: WorkspaceMode) => flagMode === m && mode !== m;

  // Buttons are content-width with an even gap, so the whitespace between any
  // two labels is constant (fixed-width buttons made the gaps look uneven as
  // the labels lengthened). The active indicator is measured from the live
  // button geometry — so it glides AND resizes to each label, and stays correct
  // when the companion is resized or web fonts finish loading.
  const groupRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef(new Map<WorkspaceMode, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = btnRefs.current.get(mode);
      if (!el) return;
      setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined" && groupRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(groupRef.current);
    }
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [mode]);

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label="Workspace mode"
      // No own border/bg: the group sits inside Companion's already-bordered
      // header on the same panel surface — the gliding brass-ghost indicator
      // alone marks the active mode.
      className="relative inline-flex items-center gap-0.5"
    >
      {/* Gliding brass indicator — measured to the active button's box. */}
      {indicator && (
        <div
          aria-hidden
          className="absolute inset-y-0 rounded-md transition-[transform,width] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
          style={{
            left: 0,
            width: `${indicator.width}px`,
            transform: `translateX(${indicator.left}px)`,
            background: "var(--brass-ghost)",
            border: "1px solid var(--brass-dim)",
          }}
        />
      )}
      {MODES.map((m) => {
        const active = m === mode;
        const pulse = shouldPulse(m);
        return (
          <button
            key={m}
            ref={(el) => {
              if (el) btnRefs.current.set(m, el);
              else btnRefs.current.delete(m);
            }}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={active}
            title={
              pulse
                ? `${MODE_LABELS[m]} needs your attention`
                : `${MODE_LABELS[m]} (${MODE_SHORTCUTS[m]})`
            }
            className={clsx(
              // Label color glides on the same clock as the indicator (280ms)
              // so the brass handoff and the rect arrive together.
              "relative z-10 whitespace-nowrap rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]",
              active ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage",
              pulse && "animate-attention-pulse !text-octo-brass",
            )}
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
