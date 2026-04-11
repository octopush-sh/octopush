import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { PtyDataEvent, PtyExitEvent } from "../lib/types";

interface Props {
  sessionId: string;
}

/**
 * A single xterm.js instance bound to the given session's PTY.
 *
 * The effect is keyed by `sessionId`, so switching sessions tears down the
 * old terminal and constructs a fresh one pinned to the new PTY. Phase 2
 * will revisit this to keep terminals alive in the background.
 */
export function TerminalPane({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      theme: {
        background: "#0a0a0b",
        foreground: "#e4e4e7",
        cursor: "#a78bfa",
        cursorAccent: "#0a0a0b",
        selectionBackground: "#3f3f46",
        black: "#18181b",
        red: "#f87171",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#a78bfa",
        cyan: "#22d3ee",
        white: "#d4d4d8",
        brightBlack: "#3f3f46",
        brightRed: "#fca5a5",
        brightGreen: "#6ee7b7",
        brightYellow: "#fcd34d",
        brightBlue: "#93c5fd",
        brightMagenta: "#c4b5fd",
        brightCyan: "#67e8f9",
        brightWhite: "#fafafa",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    // Initial fit and resize sync with the PTY.
    const doFit = () => {
      try {
        fit.fit();
        ipc.resizeSession(sessionId, term.rows, term.cols).catch(() => {});
      } catch {
        /* container not measured yet */
      }
    };
    doFit();

    const ro = new ResizeObserver(() => doFit());
    ro.observe(containerRef.current);

    // PTY → term: stream bytes from backend event bus.
    let unlistenData: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    listen<PtyDataEvent>("pty://data", (ev) => {
      if (ev.payload.sessionId !== sessionId) return;
      term.write(new Uint8Array(ev.payload.bytes));
    }).then((u) => {
      unlistenData = u;
    });

    listen<PtyExitEvent>("pty://exit", (ev) => {
      if (ev.payload.sessionId !== sessionId) return;
      term.writeln("\r\n\x1b[2;37m[session exited]\x1b[0m");
    }).then((u) => {
      unlistenExit = u;
    });

    // term → PTY: forward user keystrokes.
    const dataDisp = term.onData((data) => {
      ipc.writeTextToSession(sessionId, data).catch((err) => {
        console.error("write to pty failed", err);
      });
    });

    // Keep the remote PTY size in sync when xterm internally resizes.
    const resizeDisp = term.onResize(({ rows, cols }) => {
      ipc.resizeSession(sessionId, rows, cols).catch(() => {});
    });

    term.focus();

    return () => {
      dataDisp.dispose();
      resizeDisp.dispose();
      ro.disconnect();
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={containerRef} className="xterm-container h-full w-full" />;
}
