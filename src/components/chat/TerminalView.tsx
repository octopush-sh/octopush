import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useChatStore } from "../../stores/chatStore";
import { ipc } from "../../lib/ipc";
import { XTERM_FONT_FAMILY, XTERM_THEME } from "../../lib/xtermTheme";

interface Props {
  /** Correlates this view to its live process's buffered output. */
  callId: string;
  /** Thread whose shell the keystrokes/resize target (interactive stdin). */
  threadId: string;
  className?: string;
}

/**
 * A read-mostly xterm.js surface for a TALK live process. Renders the buffered
 * output for its `callId` from the store (raw, with ANSI — xterm draws the
 * colors) and writes only the tail it hasn't shown yet as new chunks arrive.
 *
 * The buffer is filled by an always-on store listener, so output is never lost
 * to this panel's mount timing. Keystrokes are forwarded to the live process's
 * stdin and the PTY is resized to the panel, so REPLs / TUIs / prompts work.
 */
export function TerminalView({ callId, threadId, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // How many total bytes we've already written to xterm (monotonic, matches the
  // store's `total`), so each render writes only the unseen tail.
  const writtenRef = useRef(0);
  // Latest threadId, read by the once-registered handlers without re-mounting.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const output = useChatStore((s) => s.getLiveOutput(callId));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: XTERM_FONT_FAMILY,
      fontSize: 12,
      lineHeight: 1.3,
      theme: XTERM_THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    writtenRef.current = 0;

    // Forward keystrokes to the live process's stdin (REPLs / TUIs / prompts).
    // Guard against the brief window after the process exits but before the panel
    // unmounts: don't inject stray keys into the now-idle shell prompt.
    const onData = term.onData((data) => {
      if (!useChatStore.getState().liveProcessByThread[threadIdRef.current]) return;
      void ipc.sendShellInput(threadIdRef.current, data).catch(() => {});
    });

    let lastSize = { rows: 0, cols: 0 };
    const safeFit = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          return; /* container briefly 0×0 during mount/hide */
        }
        // Tell the PTY the new geometry so TUIs reflow.
        if (term.rows !== lastSize.rows || term.cols !== lastSize.cols) {
          lastSize = { rows: term.rows, cols: term.cols };
          void ipc.resizeShell(threadIdRef.current, term.rows, term.cols).catch(() => {});
        }
      }
    };
    safeFit();
    const ro = new ResizeObserver(safeFit);
    ro.observe(el);

    return () => {
      onData.dispose();
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
