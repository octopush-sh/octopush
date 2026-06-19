import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { XTERM_FONT_FAMILY, XTERM_THEME } from "../../lib/xtermTheme";

interface ShellOutputEvent {
  threadId: string;
  callId: string;
  chunk: string;
}

interface Props {
  /** Correlates this view to its live process; only matching output is written. */
  callId: string;
  /** Output already seen during the promotion window, painted on mount. */
  initial?: string;
  className?: string;
}

/**
 * A read-mostly xterm.js surface for a TALK live process. Renders the `initial`
 * snapshot, then appends `chat://shell-output` chunks for its `callId` (raw,
 * with ANSI — xterm draws the colors). Stdin/interactivity is intentionally out
 * of scope here (kill is driven from the panel header); full TTY arrives later.
 */
export function TerminalView({ callId, initial, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep the latest callId reachable from the once-registered listener without
  // re-subscribing (and re-mounting xterm) on every render.
  const callIdRef = useRef(callId);
  callIdRef.current = callId;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: XTERM_FONT_FAMILY,
      fontSize: 12,
      lineHeight: 1.3,
      theme: XTERM_THEME,
      cursorBlink: false,
      disableStdin: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const safeFit = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          /* container briefly 0×0 during mount/hide */
        }
      }
    };
    safeFit();
    if (initial) term.write(initial);

    const ro = new ResizeObserver(safeFit);
    ro.observe(el);

    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<ShellOutputEvent>("chat://shell-output", (ev) => {
      if (ev.payload.callId === callIdRef.current) term.write(ev.payload.chunk);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
      ro.disconnect();
      term.dispose();
    };
    // Mount once per callId; `initial` is captured at mount intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId]);

  return <div ref={containerRef} className={className} />;
}
