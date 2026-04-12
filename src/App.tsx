import { useEffect, useState } from "react";
import { SessionSidebar } from "./components/SessionSidebar";
import { TerminalPane } from "./components/TerminalPane";
import { TokenDashboard } from "./components/TokenDashboard";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { ModelSwitcher, ModelSwitcherButton } from "./components/ModelSwitcher";
import { useSessionStore } from "./stores/sessionStore";

function App() {
  const { sessions, activeId, refresh } = useSessionStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showTokens, setShowTokens] = useState(false);
  const [showModelSwitcher, setShowModelSwitcher] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
      }
      if (mod && e.shiftKey && (e.key === "M" || e.key === "m")) {
        e.preventDefault();
        setShowModelSwitcher((v) => !v);
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
      <SessionSidebar onNewSession={() => setDialogOpen(true)} />

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
          <div className="flex-1 overflow-hidden">
            {aliveSessions.length === 0 && !active ? (
              <EmptyMain onNewSession={() => setDialogOpen(true)} />
            ) : (
              aliveSessions.map((s) => (
                <TerminalPane
                  key={s.id}
                  sessionId={s.id}
                  visible={s.id === activeId}
                />
              ))
            )}
          </div>

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
