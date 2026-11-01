import { useEffect, useRef, useCallback, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import { copyToClipboard } from "../lib/clipboard";
import { attachOsc52Clipboard } from "../lib/osc52";
import type {
  PtyAttentionEvent,
  PtyDataEvent,
  PtyExitEvent,
  PtyForegroundEvent,
  PtyReattachedEvent,
} from "../lib/types";
import { useAttentionStore } from "../stores/attentionStore";
import { useTerminalsStore } from "../stores/terminalsStore";
import { XTERM_FONT_FAMILY, getXtermTheme } from "../lib/xtermTheme";
import { legacyAltArrowSequence } from "../lib/xtermAltArrow";
import { isMac } from "../lib/platform";
import { describeSpawnFailure, spawnErrorDetail } from "../lib/spawnFailure";
import { Reveal } from "./primitives/Reveal";

// Terminal zoom bounds. The font size is session-local (not persisted): each
// pane opens at ZOOM_DEFAULT and resets on remount.
const ZOOM_MIN = 8;
const ZOOM_MAX = 28;
const ZOOM_DEFAULT = 13;

// How long a foreground "idle" lingers before the rail bar stops marching, so a
// brief mid-task quiet gap doesn't flicker it off. A re-busy within the window
// cancels the pending idle.
const BUSY_OFF_LINGER_MS = 1500;

interface Props {
  /** Stable terminal record id — used as React key; never changes for this tab. */
  terminalId: string;
  /** The owning workspace id — used to surface attention pings on the rail
   *  when a BEL fires in a hidden terminal. */
  workspaceId: string;
  /** Filesystem path of the workspace root, used when spawning the PTY. */
  workspacePath: string;
  /** Human label shown in the session name. */
  label: string;
  visible: boolean;
  /** Incremented by parent when layout changes (sidebar/tokens/split toggle). */
  layoutVersion?: number;
  /** Called once the PTY session has been successfully spawned. */
  onSpawn?: () => void;
  /** Called when spawn-or-attach is rejected (no shell, sandbox denial,
   *  daemon down). The pane shows its own error state with a retry. */
  onSpawnError?: () => void;
  /** Called when the PTY process exits. */
  onExit?: () => void;
  /**
   * Called when this terminal is successfully reattached to a surviving daemon
   * session (i.e. after an Octopush restart).  The parent uses this to mark
   * the terminal as `restored` in the store so the Companion can show the badge.
   */
  onReattach?: () => void;
  /**
   * Called when the user clicks a file-path link rendered in the terminal
   * output. Receives the raw matched path (may be relative to the workspace
   * or absolute). The parent typically routes this through Review → Editor.
   */
  onOpenFile?: (path: string) => void;
}

export function TerminalPane({
  terminalId,
  workspaceId,
  workspacePath,
  label,
  visible,
  layoutVersion,
  onSpawn,
  onSpawnError,
  onExit,
  onReattach,
  onOpenFile,
}: Props) {
  // The raw error of the last rejected spawn, or null while the session is
  // fine. Drives the "Session didn't start" state over the canvas.
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  // Re-runs the spawn-or-attach of the mounted terminal ("Try the shell again").
  const spawnRef = useRef<() => void>(() => {});
  // Ref so the link provider (registered once on mount) always reads the
  // latest callback without re-registering on every prop change.
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  // Keep the latest `visible` flag accessible inside the BEL handler,
  // which is registered once and would otherwise capture the mount-time
  // value.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  // Outer wrapper — stable size, observed by ResizeObserver.
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Inner container — where xterm attaches its DOM.
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Current terminal font size (zoom level). Session-local, not persisted.
  const fontSizeRef = useRef(ZOOM_DEFAULT);
  // Track last known size to avoid no-op resize IPC calls.
  const lastSizeRef = useRef<{ rows: number; cols: number }>({ rows: 0, cols: 0 });
  // The PTY session id — for TerminalPane this is always equal to `terminalId`
  // because we use the DB terminal record id as the PTY id end-to-end.
  const ptySessionIdRef = useRef<string | null>(null);
  // Pending "stop marching" timer for the rail processing bar (linger debounce).
  const busyOffTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Stable ref wrappers so effect cleanup sees up-to-date callbacks.
  const onSpawnRef = useRef(onSpawn);
  const onSpawnErrorRef = useRef(onSpawnError);
  const onExitRef = useRef(onExit);
  const onReattachRef = useRef(onReattach);
  onSpawnRef.current = onSpawn;
  onSpawnErrorRef.current = onSpawnError;
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
      fontFamily: XTERM_FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.3,
      theme: getXtermTheme(),
      allowProposedApi: true,
      scrollback: 10000,
      // When a program owns the mouse (Claude Code's fullscreen renderer,
      // tmux with mouse on, vim `mouse=a`) a plain drag goes to the program
      // and xterm makes no selection of its own. On macOS xterm offers NO
      // modifier to override that unless this is on — Shift only works on
      // other platforms (xterm's SelectionService.shouldForceSelection) — so
      // Option-drag is the escape hatch back to a native selection and the
      // clipboard bridge below. Cost: Option-click no longer reaches a
      // mouse-mode program. Plain clicks, and mouse-mode-off shells, are
      // untouched.
      macOptionClickForcesSelection: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    fontSizeRef.current = ZOOM_DEFAULT;

    // Follow Octopush theme switches: themeStore.applyThemeToDom fires
    // `octo:theme` after writing the new tokens to :root. xterm can't read
    // `var(--…)` directly, so rebuild its theme from the live tokens (see
    // lib/xtermTheme.ts · getXtermTheme) and assign it in place — no remount.
    const onThemeChange = () => {
      term.options.theme = getXtermTheme();
    };
    window.addEventListener("octo:theme", onThemeChange);

    // ── Zoom ──────────────────────────────────────────────────────────
    // xterm has no built-in zoom: changing `fontSize` then refitting is the
    // whole mechanism. `syncSize` recomputes rows/cols and notifies the PTY,
    // so the inner app reflows to the new geometry.
    const applyFontSize = (next: number) => {
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next)));
      if (clamped === term.options.fontSize) return;
      fontSizeRef.current = clamped;
      term.options.fontSize = clamped;
      syncSize();
    };

    // ── Clipboard bridge ──────────────────────────────────────────────
    // xterm paints its OWN selection (not a native DOM range), so the
    // browser's Cmd-C and right-click "copy" never see the selected text —
    // Cmd-C copies nothing and right-click copies only the word under the
    // pointer. Bridge `term.getSelection()` to the system clipboard on
    // Cmd-C / Ctrl-Shift-C and on right-click-with-a-selection.
    if (typeof term.attachCustomKeyEventHandler === "function") {
      term.attachCustomKeyEventHandler((e) => {
        // Option+Left/Right word jumps — xterm 6 no longer rewrites these
        // itself (see lib/xtermAltArrow.ts). `input(…, true)` goes out through
        // onData → PTY exactly like a typed key.
        const altArrow = legacyAltArrowSequence(e, isMac());
        if (altArrow) {
          term.input(altArrow, true);
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
        // Zoom: Cmd/Ctrl with +, -, or 0. `+` is Shift+= on most layouts, so
        // we don't exclude Shift here. Handled keys are not forwarded to the PTY.
        if (e.type === "keydown" && (e.metaKey || e.ctrlKey) && !e.altKey) {
          if (e.key === "=" || e.key === "+") {
            applyFontSize(fontSizeRef.current + 1);
            e.preventDefault();
            return false;
          }
          if (e.key === "-" || e.key === "_") {
            applyFontSize(fontSizeRef.current - 1);
            e.preventDefault();
            return false;
          }
          if (e.key === "0") {
            applyFontSize(ZOOM_DEFAULT);
            e.preventDefault();
            return false;
          }
        }
        if (
          e.type === "keydown" &&
          (e.key === "c" || e.key === "C") &&
          (e.metaKey || (e.ctrlKey && e.shiftKey))
        ) {
          const sel = term.getSelection();
          if (sel) {
            void copyToClipboard(sel); // implicit copy — silent on success
            e.preventDefault();
            return false; // handled — don't forward Cmd-C to the PTY
          }
        }
        return true;
      });
    }
    const copyEl = containerRef.current;
    const onContextMenu = (e: MouseEvent) => {
      const sel = term.getSelection?.();
      if (sel) {
        void copyToClipboard(sel); // implicit copy — silent on success
        e.preventDefault(); // suppress the native "copy word under cursor"
      }
    };
    copyEl.addEventListener("contextmenu", onContextMenu);

    // ── OSC 52: a program copies to the clipboard ──────────────────────
    // `ESC ] 52 ; Pc ; Pd ST` lets a program in the PTY set the system
    // clipboard — Claude Code's fullscreen renderer (copy-on-select over SSH,
    // and OSC-52-only in some builds), tmux `set-clipboard`, neovim, helix.
    // xterm drops it unless something registers for it. The mechanics —
    // write-only, UTF-8 decoding, the history gate, the pacing — live in
    // lib/osc52.ts; the backend tags replayed scrollback on `pty://data` so
    // history can never reach the clipboard. This pane only sets the policy.
    const osc52 = attachOsc52Clipboard(term, {
      // Only the pane the user is looking at, in a focused window: a hidden
      // workspace, or an Octopush sitting behind another app, must not swap
      // the clipboard under them.
      canCopy: () => visibleRef.current && document.hasFocus(),
      // Announced, unlike the user's own Cmd-C: nothing was pressed in
      // Octopush, so the toast is how they learn their clipboard changed.
      copy: (text) => void copyToClipboard(text, "Copied from the terminal"),
    });

    // Option+click, mouse-mode aware. xterm's alt-click-moves-cursor (on by
    // default) turns a quick Option+click into a burst of arrow-key presses
    // that walk the cursor to the clicked cell — handy at a prompt, but with
    // `macOptionClickForcesSelection` the same mouseup path now also runs
    // while a program tracks the mouse, where those arrows would land in the
    // program (Claude Code's composer, vim) as real keystrokes. xterm reads
    // the option at mouseup, so decide per gesture: on only while no program
    // has mouse tracking on.
    const onMouseDownCapture = () => {
      term.options.altClickMovesCursor = term.modes.mouseTrackingMode === "none";
    };
    copyEl.addEventListener("mousedown", onMouseDownCapture, true);

    // Ctrl + mouse wheel zoom. `passive: false` so we can preventDefault and
    // stop the browser's own pinch-zoom from firing underneath.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyFontSize(fontSizeRef.current + (e.deltaY < 0 ? 1 : -1));
    };
    copyEl.addEventListener("wheel", onWheel, { passive: false });

    // File-path link provider — scans each rendered terminal line for
    // path-shaped tokens (anything with at least one slash + a short
    // extension) and turns them into clickable links. Excludes URL
    // fragments (the WebLinksAddon already handles those).
    //
    // Pattern intent:
    //   - optional `./` or `../` prefix
    //   - one or more `<chunk>/` segments
    //   - a final `<chunk>.<ext>` token
    //   - optional `:line` or `:line:col` suffix (Vite/TS error format)
    const filePathRegex =
      /(?<![\w/:])(?:\.{1,2}\/)?(?:[\w@.\-]+\/)+[\w@.\-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g;

    // Some test environments stub Terminal without `registerLinkProvider`;
    // skip the link-provider registration there.
    if (typeof term.registerLinkProvider === "function") {
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        if (!text) {
          callback([]);
          return;
        }
        const links: Array<{
          range: {
            start: { x: number; y: number };
            end: { x: number; y: number };
          };
          text: string;
          activate: (_e: MouseEvent, txt: string) => void;
          hover?: () => void;
          leave?: () => void;
        }> = [];
        let match: RegExpExecArray | null;
        filePathRegex.lastIndex = 0;
        while ((match = filePathRegex.exec(text)) !== null) {
          const startCol = match.index + 1;
          const endCol = startCol + match[0].length - 1;
          links.push({
            range: {
              start: { x: startCol, y: bufferLineNumber },
              end: { x: endCol, y: bufferLineNumber },
            },
            text: match[0],
            activate: (_e, txt) => {
              // Strip any `:line[:col]` suffix — the editor opens at top
              // for now; jumping to a line is a future enhancement.
              const pathOnly = txt.replace(/:\d+(?::\d+)?$/, "");
              onOpenFileRef.current?.(pathOnly);
            },
          });
        }
        callback(links);
      },
    });
    }

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
      // `replay` marks scrollback the daemon is showing again after a
      // reattach; the OSC 52 gate must not act on it.
      osc52.write(new Uint8Array(ev.payload.bytes), ev.payload.replay === true);
    }).then((u) => {
      unlistenData = u;
    });

    // Daemon-driven attention: when the daemon decides the PTY went
    // idle after a meaningful burst, it emits `pty://attention`.
    // We forward it to the attention store unless this pane is the
    // one the user is currently looking at.
    let unlistenAttention: UnlistenFn | undefined;
    listen<PtyAttentionEvent>("pty://attention", (ev) => {
      if (ev.payload.sessionId !== ptySessionIdRef.current) return;
      if (visibleRef.current) return;
      // Carry the terminal id so the Run rail can mark the session that rang
      // rather than the whole workspace.
      useAttentionStore
        .getState()
        .ping(workspaceIdRef.current, "terminal", terminalId);
    }).then((u) => {
      unlistenAttention = u;
    });

    // Daemon-driven foreground state: a command started or stopped running in
    // this PTY. Feeds the rail's processing bar — updated regardless of whether
    // the pane is visible, so a background workspace's bar reflects its work.
    //
    // Busy=true applies immediately; busy=false lingers briefly so a short
    // quiet gap mid-task (e.g. an agent waiting on its API between output
    // bursts) doesn't flicker the bar off and back on — a re-busy within the
    // window cancels the pending idle.
    let unlistenForeground: UnlistenFn | undefined;
    listen<PtyForegroundEvent>("pty://foreground", (ev) => {
      const ptyId = ptySessionIdRef.current;
      if (!ptyId || ev.payload.sessionId !== ptyId) return;
      if (busyOffTimerRef.current) {
        clearTimeout(busyOffTimerRef.current);
        busyOffTimerRef.current = undefined;
      }
      const wsId = workspaceIdRef.current;
      if (ev.payload.busy) {
        // `command` is the daemon's argv summary; it feeds the session's role
        // icon (lib/sessionRole.ts) and is absent when the platform can't
        // resolve one, which the store treats as "leave the role alone".
        useTerminalsStore
          .getState()
          .setBusy(wsId, ptyId, true, ev.payload.command ?? null);
      } else {
        busyOffTimerRef.current = setTimeout(() => {
          busyOffTimerRef.current = undefined;
          useTerminalsStore.getState().setBusy(wsId, ptyId, false);
        }, BUSY_OFF_LINGER_MS);
      }
    }).then((u) => {
      unlistenForeground = u;
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
      // Apps that own the screen via alt-screen + sticky status bars
      // (Claude Code, htop, vim, etc.) don't recover cleanly from a
      // replayed byte stream because xterm starts in a fresh state but
      // the replay includes mid-session cursor positioning. Trigger a
      // SIGWINCH on the PTY a short while after reattach so the inner
      // app redraws its UI from scratch. The wiggle (cols-1 → cols) is
      // necessary because the daemon only forwards a SIGWINCH when the
      // dimensions actually change.
      setTimeout(() => {
        const ptyId = ptySessionIdRef.current;
        const t = termRef.current;
        if (!ptyId || !t) return;
        const { rows, cols } = t;
        if (rows < 1 || cols < 2) return;
        ipc
          .resizeSession(ptyId, rows, Math.max(1, cols - 1))
          .then(() => ipc.resizeSession(ptyId, rows, cols))
          .catch(() => {});
      }, 600);
    }).then((u) => {
      unlistenReattached = u;
    });

    // BEL → attention ping. Only fires when this terminal is hidden,
    // otherwise it'd just nag the user about a terminal they're already
    // looking at. xterm emits onBell for every \x07 it processes.
    const bellDisp = term.onBell(() => {
      if (visibleRef.current) return;
      useAttentionStore.getState().ping(workspaceIdRef.current, "terminal", terminalId);
    });

    // Attention detection lives in the Rust daemon (see
    // `Session::check_attention`). The frontend just listens for
    // `pty://attention` events and routes them to the attention
    // store. This was moved out of the WebView in v0.1.11 because
    // five iterations of in-process heuristics couldn't beat the
    // timing drift + xterm.js buffer ambiguity + non-deterministic
    // AI output combination.

    // term → PTY
    const dataDisp = term.onData((data) => {
      const ptyId = ptySessionIdRef.current;
      if (!ptyId) return;
      ipc.writeTextToSession(ptyId, data).catch(() => {});
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

    // Success and rejection are handled side by side (not `.then().catch()`)
    // so an exception in the success path can never be reported as a spawn
    // failure. A rejection shows the designed error state over the canvas,
    // never a raw error line inside the terminal.
    const spawn = () => {
      ipc.spawnOrAttachTerminal(terminalId, workspacePath, label).then(
        () => {
          if (cancelled) return;
          setSpawnError(null);
          // onReattach is fired by the pty://reattached event listener above,
          // which the backend emits before the first data chunk.
          onSpawnRef.current?.();
          // Fit now that the PTY is alive.
          requestAnimationFrame(() => {
            if (!cancelled) syncSize();
          });
        },
        (err: unknown) => {
          if (cancelled) return;
          setSpawnError(spawnErrorDetail(err));
          onSpawnErrorRef.current?.();
        },
      );
    };
    spawnRef.current = spawn;
    spawn();

    return () => {
      cancelled = true;
      spawnRef.current = () => {};
      if (resizeTimer) clearTimeout(resizeTimer);
      dataDisp.dispose();
      resizeDisp.dispose();
      bellDisp.dispose();
      osc52.dispose();
      ro.disconnect();
      unlistenData?.();
      unlistenExit?.();
      unlistenReattached?.();
      unlistenAttention?.();
      unlistenForeground?.();
      if (busyOffTimerRef.current) clearTimeout(busyOffTimerRef.current);
      window.removeEventListener("octo:theme", onThemeChange);
      copyEl.removeEventListener("contextmenu", onContextMenu);
      copyEl.removeEventListener("mousedown", onMouseDownCapture, true);
      copyEl.removeEventListener("wheel", onWheel);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // Note: we intentionally do NOT kill the PTY here — the daemon owns it
      // and it should survive this TerminalPane unmounting (e.g. workspace
      // switch, Octopush restart).  The user explicitly kills a terminal via
      // Close action in the session rail's flyout / Companion, which calls
      // ipc.deleteTerminal.
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

  const retrySpawn = useCallback(() => {
    setSpawnError(null);
    setDetailOpen(false);
    spawnRef.current();
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full overflow-hidden"
      style={{ display: visible ? "block" : "none" }}
    >
      <div
        ref={containerRef}
        className="xterm-container h-full w-full"
      />
      {spawnError !== null && (
        <SpawnFailed
          detail={spawnError}
          detailOpen={detailOpen}
          onToggleDetail={() => setDetailOpen((o) => !o)}
          onRetry={retrySpawn}
        />
      )}
    </div>
  );
}

/** The Run canvas when a session's PTY was rejected: what happened, why, the
 *  raw error one click away, and a way to try again. */
function SpawnFailed({
  detail,
  detailOpen,
  onToggleDetail,
  onRetry,
}: {
  detail: string;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="terminal-spawn-failed"
      className="octo-fade-in absolute inset-0 flex flex-col items-center justify-center gap-4 bg-octo-bg px-8 text-center"
    >
      <div
        data-tour="run-spawn-failed"
        className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-rouge"
      >
        Session didn't start
      </div>
      <p className="max-w-md text-[13px] leading-[1.6] text-octo-sage">
        {describeSpawnFailure(detail)}
      </p>
      <div className="flex w-full max-w-md flex-col items-center gap-2">
        <button
          type="button"
          data-testid="terminal-spawn-detail-toggle"
          aria-expanded={detailOpen}
          onClick={onToggleDetail}
          className="flex items-center gap-1 rounded px-1 font-mono text-[10px] uppercase tracking-[0.12em] text-octo-mute transition hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <ChevronRight
            size={11}
            strokeWidth={1.75}
            aria-hidden
            style={{
              transform: detailOpen ? "rotate(90deg)" : "none",
              transition: "transform var(--dur-standard) var(--ease-octo)",
            }}
          />
          Technical detail
        </button>
        <Reveal open={detailOpen} className="w-full">
          <pre
            data-testid="terminal-spawn-detail"
            className="m-0 whitespace-pre-wrap break-words rounded-md border border-octo-hairline px-3 py-2 text-left font-mono text-[11px] leading-[1.5] text-octo-mute"
          >
            {detail}
          </pre>
        </Reveal>
      </div>
      <button
        type="button"
        data-tour="run-spawn-retry"
        onClick={onRetry}
        className="mt-2 rounded-lg border border-octo-border-strong px-4 py-2 font-serif text-[13px] text-octo-sage transition hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        Try the shell again
      </button>
    </div>
  );
}
