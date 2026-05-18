import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { PtyDataEvent, PtyExitEvent, PtyReattachedEvent } from "../lib/types";

interface Props {
  /** Stable terminal record id — used as React key; never changes for this tab. */
  terminalId: string;
  /** Filesystem path of the workspace root, used when spawning the PTY. */
  workspacePath: string;
  /** Human label shown in the session name. */
  label: string;
  visible: boolean;
  /** Incremented by parent when layout changes (sidebar/tokens/split toggle). */
  layoutVersion?: number;
  /** Called once the PTY session has been successfully spawned. */
  onSpawn?: () => void;
  /** Called when the PTY process exits. */
  onExit?: () => void;
  /**
   * Called when this terminal is successfully reattached to a surviving daemon
   * session (i.e. after an Octopush restart).  The parent uses this to mark
   * the terminal as `restored` in the store so the Companion can show the badge.
   */
  onReattach?: () => void;
}

export function TerminalPane({
  terminalId,
  workspacePath,
  label,
  visible,
  layoutVersion,
  onSpawn,
  onExit,
  onReattach,
}: Props) {
  // Outer wrapper — stable size, observed by ResizeObserver.
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Inner container — where xterm attaches its DOM.
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Track last known size to avoid no-op resize IPC calls.
  const lastSizeRef = useRef<{ rows: number; cols: number }>({ rows: 0, cols: 0 });
  // The PTY session id — for TerminalPane this is always equal to `terminalId`
  // because we use the DB terminal record id as the PTY id end-to-end.
  const ptySessionIdRef = useRef<string | null>(null);
  // Stable ref wrappers so effect cleanup sees up-to-date callbacks.
  const onSpawnRef = useRef(onSpawn);
  const onExitRef = useRef(onExit);
  const onReattachRef = useRef(onReattach);
  onSpawnRef.current = onSpawn;
  onExitRef.current = onExit;
  onReattachRef.current = onReattach;

  const syncSize = useCallback(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    const ptyId = ptySessionIdRef.current;
    if (!fit || !term || !ptyId) return;
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
      ipc.resizeSession(ptyId, rows, cols).catch(() => {});
    }
  }, []);

  // Create xterm + spawn PTY once on mount (keyed by terminalId).
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
        const ptyId = ptySessionIdRef.current;
        if (w && w.clientWidth > 0 && w.clientHeight > 0 && ptyId) {
          try {
            fit.fit();
          } catch {
            return;
          }
          const { rows, cols } = term;
          const last = lastSizeRef.current;
          if (rows !== last.rows || cols !== last.cols) {
            lastSizeRef.current = { rows, cols };
            ipc.resizeSession(ptyId, rows, cols).catch(() => {});
          }
        }
      }, 100); // 100ms debounce
    });
    if (wrapperRef.current) {
      ro.observe(wrapperRef.current);
    }

    // PTY → term (listens on the global event bus; filters by session id).
    let unlistenData: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let unlistenReattached: UnlistenFn | undefined;

    listen<PtyDataEvent>("pty://data", (ev) => {
      if (ev.payload.sessionId !== ptySessionIdRef.current) return;
      term.write(new Uint8Array(ev.payload.bytes));
    }).then((u) => {
      unlistenData = u;
    });

    listen<PtyExitEvent>("pty://exit", (ev) => {
      if (ev.payload.sessionId !== ptySessionIdRef.current) return;
      term.writeln("\r\n\x1b[2;37m[session exited]\x1b[0m");
      onExitRef.current?.();
    }).then((u) => {
      unlistenExit = u;
    });

    // Fired by the backend when spawn_or_attach chose the reattach path.
    listen<PtyReattachedEvent>("pty://reattached", (ev) => {
      if (ev.payload.sessionId !== ptySessionIdRef.current) return;
      onReattachRef.current?.();
    }).then((u) => {
      unlistenReattached = u;
    });

    // term → PTY
    const dataDisp = term.onData((data) => {
      const ptyId = ptySessionIdRef.current;
      if (!ptyId) return;
      ipc.writeTextToSession(ptyId, data).catch((err) => {
        console.error("write to pty failed", err);
      });
    });

    // Propagate xterm resize events to PTY (handles manual terminal resize).
    const resizeDisp = term.onResize(({ rows, cols }) => {
      const ptyId = ptySessionIdRef.current;
      if (!ptyId) return;
      const last = lastSizeRef.current;
      if (rows !== last.rows || cols !== last.cols) {
        lastSizeRef.current = { rows, cols };
        ipc.resizeSession(ptyId, rows, cols).catch(() => {});
      }
    });

    // Spawn-or-attach the PTY session.  We use the terminal record's stable id
    // as the PTY id so the daemon can find a surviving session on restart.
    let cancelled = false;
    // Register the id immediately so event listeners can match before the
    // IPC round-trip completes (rare race with very fast daemon response).
    ptySessionIdRef.current = terminalId;

    ipc
      .spawnOrAttachTerminal(terminalId, workspacePath, label)
      .then((result) => {
        if (cancelled) return;
        onSpawnRef.current?.();
        // Note: onReattach is fired by the pty://reattached event listener above,
        // which the backend emits synchronously before the first data chunk.
        if (result.mode === "Reattached") {
          // Reattach path: the pty://reattached event already fired (or will fire
          // momentarily) so onReattach will be called there.  Nothing extra needed.
        }
        // Fit now that the PTY is alive.
        requestAnimationFrame(() => {
          if (!cancelled) syncSize();
        });
      })
      .catch((err) => {
        if (!cancelled) {
          term.writeln(`\r\n\x1b[31m[failed to spawn PTY: ${String(err)}]\x1b[0m`);
        }
      });

    return () => {
      cancelled = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      dataDisp.dispose();
      resizeDisp.dispose();
      ro.disconnect();
      unlistenData?.();
      unlistenExit?.();
      unlistenReattached?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // Note: we intentionally do NOT kill the PTY here — the daemon owns it
      // and it should survive this TerminalPane unmounting (e.g. workspace
      // switch, Octopush restart).  The user explicitly kills a terminal via
      // the × button in CompanionTerminals, which calls ipc.deleteTerminal.
      ptySessionIdRef.current = null;
    };
    // terminalId is the React key — changes cause a full remount, not a re-run.
    // workspacePath + label intentionally not in deps: only used at spawn time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Refit + focus when becoming visible.
  useEffect(() => {
    if (visible) {
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

  // Refit when parent layout changes (sidebar/tokens/split toggled).
  useEffect(() => {
    if (!visible || layoutVersion === undefined) return;
    // Give the browser time to recalculate the flex layout.
    const t1 = requestAnimationFrame(() => syncSize());
    const t2 = setTimeout(() => syncSize(), 100);
    const t3 = setTimeout(() => syncSize(), 300);
    return () => {
      cancelAnimationFrame(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [layoutVersion, visible, syncSize]);

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
