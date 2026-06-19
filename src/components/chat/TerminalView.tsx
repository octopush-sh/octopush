import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useChatStore } from "../../stores/chatStore";
import { XTERM_FONT_FAMILY, XTERM_THEME } from "../../lib/xtermTheme";

interface Props {
  /** Correlates this view to its live process's buffered output. */
  callId: string;
  className?: string;
}

/**
 * A read-mostly xterm.js surface for a TALK live process. Renders the buffered
 * output for its `callId` from the store (raw, with ANSI — xterm draws the
 * colors) and writes only the tail it hasn't shown yet as new chunks arrive.
 *
 * The buffer is filled by an always-on store listener, so output is never lost
 * to this panel's mount timing. Stdin/interactivity is out of scope here (kill
 * is driven from the panel header); full TTY arrives later.
 */
export function TerminalView({ callId, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // How many total bytes we've already written to xterm (monotonic, matches the
  // store's `total`), so each render writes only the unseen tail.
  const writtenRef = useRef(0);
  const output = useChatStore((s) => s.getLiveOutput(callId));

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
    termRef.current = term;
    writtenRef.current = 0;

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
    const ro = new ResizeObserver(safeFit);
    ro.observe(el);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [callId]);

  // Write the unseen tail whenever the buffer grows.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !output) return;
    const pending = output.total - writtenRef.current;
    if (pending <= 0) return;
    // `text` is capped to its tail; never slice past its start.
    const tail = output.text.slice(Math.max(0, output.text.length - pending));
    term.write(tail);
    writtenRef.current = output.total;
  }, [output]);

  return <div ref={containerRef} className={className} />;
}
