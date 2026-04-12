import { useEffect, useRef, useState } from "react";
import { SessionSidebar } from "./components/SessionSidebar";
import { TerminalPane } from "./components/TerminalPane";
import { TokenDashboard } from "./components/TokenDashboard";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { ModelSwitcher, ModelSwitcherButton } from "./components/ModelSwitcher";
import { CommandPalette } from "./components/CommandPalette";
import { ToastContainer } from "./components/Toasts";
import { useSessionStore } from "./stores/sessionStore";
import { useThemeStore } from "./stores/themeStore";

function App() {
  const { sessions, activeId, refresh } = useSessionStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showTokens, setShowTokens] = useState(false);
  const [showModelSwitcher, setShowModelSwitcher] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  /** ID of the second session shown in split view (null = no split). */
  const [splitId, setSplitId] = useState<string | null>(null);
  /** Increments on any layout change that affects terminal container size. */
  const layoutVersionRef = useRef(0);
  const [layoutVersion, setLayoutVersion] = useState(0);

  const bumpLayout = () => {
    layoutVersionRef.current += 1;
    setLayoutVersion(layoutVersionRef.current);
  };

  const loadTheme = useThemeStore((s) => s.load);

  useEffect(() => {
    refresh();
    loadTheme();
  }, [refresh, loadTheme]);

  // Global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key === "t") {
        e.preventDefault();
        setDialogOpen(true);
      }
      if (mod && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        setShowTokens((v) => !v);
        bumpLayout();
      }
      if (mod && e.shiftKey && (e.key === "M" || e.key === "m")) {
        e.preventDefault();
        setShowModelSwitcher((v) => !v);
      }
      if (mod && !e.shiftKey && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
      if (mod && !e.shiftKey && e.key === "d") {
        e.preventDefault();
        bumpLayout();
        setSplitId((prev) => {
          if (prev) return null; // toggle off
          const { sessions: ss, activeId: aid } = useSessionStore.getState();
          const others = ss.filter(
            (s) =>
              s.id !== aid &&
              (s.status === "active" || s.status === "idle"),
          );
          return others.length > 0 ? others[0].id : null;
        });
      }
      // ⌘W — close/kill active session
      if (mod && !e.shiftKey && e.key === "w") {
        e.preventDefault();
        const { activeId: aid, kill: killFn, sessions: ss, select: selFn } =
          useSessionStore.getState();
        if (aid) {
          killFn(aid).then(() => {
            const remaining = ss.filter((s) => s.id !== aid);
            selFn(remaining.length > 0 ? remaining[0].id : null);
          });
        }
      }
      // ⌘1-9 — switch to session by index
      if (mod && !e.shiftKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        const { sessions: ss, select: selFn } = useSessionStore.getState();
        if (idx < ss.length) {
          selFn(ss[idx].id);
        }
      }
      // ⌘\ — toggle sidebar
      if (mod && e.key === "\\") {
        e.preventDefault();
        setShowSidebar((v) => !v);
        bumpLayout();
      }
      // Ctrl+Tab — next session
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const { sessions: ss, activeId: aid, select: selFn } =
          useSessionStore.getState();
        if (ss.length > 1 && aid) {
          const idx = ss.findIndex((s) => s.id === aid);
          const next = (idx + 1) % ss.length;
          selFn(ss[next].id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  const aliveSessions = sessions.filter(
    (s) => s.status === "active" || s.status === "idle",
  );

  return (
    <div className="flex h-screen w-screen bg-octo-bg text-zinc-100">
      {showSidebar && (
        <SessionSidebar onNewSession={() => setDialogOpen(true)} />
      )}

      <main className="relative flex flex-1 flex-col">
        {active ? (
          <Titlebar
            name={active.name}
            model={active.agent.model}
            showTokens={showTokens}
            onToggleTokens={() => setShowTokens((v) => !v)}
            onToggleModel={() => setShowModelSwitcher((v) => !v)}
          />
        ) : null}

        <div className="relative flex flex-1 overflow-hidden">
          {aliveSessions.length === 0 && !active ? (
            <div className="min-w-0 flex-1">
              <EmptyMain onNewSession={() => setDialogOpen(true)} />
            </div>
          ) : (
            <div className="flex min-w-0 flex-1">
              {/* Primary pane */}
              <div className="min-w-0 flex-1 overflow-hidden">
                {aliveSessions.map((s) => (
                  <TerminalPane
                    key={s.id}
                    sessionId={s.id}
                    visible={s.id === activeId}
                    layoutVersion={layoutVersion}
                  />
                ))}
              </div>

              {/* Split pane — visible when ⌘D active */}
              {splitId && (
                <>
                  <div className="w-px shrink-0 bg-octo-border" />
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <TerminalPane
                      key={`split-${splitId}`}
                      sessionId={splitId}
                      visible
                      layoutVersion={layoutVersion}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Token dashboard — fixed width, shrinks the terminal area */}
          {showTokens && <TokenDashboard />}
        </div>

        {/* Model switcher dropdown */}
        <ModelSwitcher
          open={showModelSwitcher}
          onClose={() => setShowModelSwitcher(false)}
        />
      </main>

      <NewSessionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        onNewSession={() => {
          setShowPalette(false);
          setDialogOpen(true);
        }}
        onToggleTokens={() => setShowTokens((v) => !v)}
      />

      <ToastContainer />
    </div>
  );
}

function Titlebar({
  name,
  model,
  showTokens,
  onToggleTokens,
  onToggleModel,
}: {
  name: string;
  model: string;
  showTokens: boolean;
  onToggleTokens: () => void;
  onToggleModel: () => void;
}) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center justify-between border-b border-octo-border bg-octo-panel/80 px-4 pl-20"
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono font-medium">{name}</span>
        <span className="text-zinc-600">•</span>
        <ModelSwitcherButton model={model} onClick={onToggleModel} />
      </div>
      <button
        onClick={onToggleTokens}
        className={`rounded-md px-2 py-1 text-[10px] uppercase tracking-wider transition ${
          showTokens
            ? "bg-octo-accent/20 text-octo-accent"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
        title="Toggle token dashboard (⌘⇧T)"
      >
        Tokens
      </button>
    </header>
  );
}

function EmptyMain({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-full flex-col items-center justify-center gap-4 text-center"
    >
      <div className="text-6xl">🐙</div>
      <div className="text-xl font-semibold tracking-tight">Octopus sh</div>
      <div className="max-w-md text-sm text-zinc-400">
        Eight arms. Zero wasted tokens.
        <br />
        Create a session to spin up an isolated PTY with its own model and
        context.
      </div>
      <button
        onClick={onNewSession}
        className="mt-2 rounded-md border border-octo-accent/40 bg-octo-accent/10 px-4 py-2 text-sm font-medium text-octo-accent transition hover:bg-octo-accent/20"
      >
        + New session  <span className="ml-2 text-[10px] text-zinc-500">⌘T</span>
      </button>
    </div>
  );
}

export default App;
