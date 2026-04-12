import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { PtyDataEvent, PtyExitEvent } from "../lib/types";

interface Props {
  sessionId: string;
  visible: boolean;
}

export function TerminalPane({ sessionId, visible }: Props) {
  // Outer wrapper — stable size, observed by ResizeObserver.
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Inner container — where xterm attaches its DOM.
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Track last known size to avoid no-op resize IPC calls.
  const lastSizeRef = useRef<{ rows: number; cols: number }>({ rows: 0, cols: 0 });

  const syncSize = useCallback(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    // Don't fit if the container is hidden (0×0).
    const wrapper = wrapperRef.current;
    if (!wrapper || wrapper.clientWidth === 0 || wrapper.clientHeight === 0) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    const { rows, cols } = term;
    const last = lastSizeRef.current;
    // Only send resize to PTY if dimensions actually changed.
    if (rows !== last.rows || cols !== last.cols) {
      lastSizeRef.current = { rows, cols };
      ipc.resizeSession(sessionId, rows, cols).catch(() => {});
    }
  }, [sessionId]);

  // Create terminal once on mount.
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
    termRef.current = term;
    fitRef.current = fit;

    // Debounced ResizeObserver — observe the WRAPPER (stable outer box),
    // not the xterm container (whose dimensions shift as content flows).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const w = wrapperRef.current;
        if (w && w.clientWidth > 0 && w.clientHeight > 0) {
          try {
            fit.fit();
          } catch {
            return;
          }
          const { rows, cols } = term;
          const last = lastSizeRef.current;
          if (rows !== last.rows || cols !== last.cols) {
            lastSizeRef.current = { rows, cols };
            ipc.resizeSession(sessionId, rows, cols).catch(() => {});
          }
        }
      }, 100); // 100ms debounce
    });
    if (wrapperRef.current) {
      ro.observe(wrapperRef.current);
    }

    // PTY → term
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

    // term → PTY
    const dataDisp = term.onData((data) => {
      ipc.writeTextToSession(sessionId, data).catch((err) => {
        console.error("write to pty failed", err);
      });
    });

    // Only sync size on explicit xterm resize events (not on every write).
    const resizeDisp = term.onResize(({ rows, cols }) => {
      const last = lastSizeRef.current;
      if (rows !== last.rows || cols !== last.cols) {
        lastSizeRef.current = { rows, cols };
        ipc.resizeSession(sessionId, rows, cols).catch(() => {});
      }
    });

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      dataDisp.dispose();
      resizeDisp.dispose();
      ro.disconnect();
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // Refit + focus when becoming visible.
  useEffect(() => {
    if (visible) {
      // Multiple attempts to ensure the container has layout dimensions.
      // requestAnimationFrame alone isn't enough when CSS transitions are involved.
      const t1 = requestAnimationFrame(() => syncSize());
      const t2 = setTimeout(() => {
        syncSize();
        termRef.current?.focus();
      }, 50);
      const t3 = setTimeout(() => syncSize(), 200);
      return () => {
        cancelAnimationFrame(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    }
  }, [visible, syncSize]);

  return (
    <div
      ref={wrapperRef}
      className="h-full w-full overflow-hidden"
      style={{ display: visible ? "block" : "none" }}
    >
      <div
        ref={containerRef}
        className="xterm-container h-full w-full"
      />
    </div>
  );
}
