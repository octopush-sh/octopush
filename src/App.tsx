import { useEffect, useState } from "react";
import { SessionSidebar } from "./components/SessionSidebar";
import { TerminalPane } from "./components/TerminalPane";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { useSessionStore } from "./stores/sessionStore";

function App() {
  const { sessions, activeId, refresh } = useSessionStore();
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
        e.preventDefault();
        setDialogOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className="flex h-screen w-screen bg-octo-bg text-zinc-100">
      <SessionSidebar onNewSession={() => setDialogOpen(true)} />

      <main className="flex flex-1 flex-col">
        {active ? (
          <>
            <Titlebar name={active.name} model={active.agent.model} />
            <div className="flex-1 overflow-hidden">
              <TerminalPane key={active.id} sessionId={active.id} />
            </div>
          </>
        ) : (
          <EmptyMain onNewSession={() => setDialogOpen(true)} />
        )}
      </main>

      <NewSessionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}

function Titlebar({ name, model }: { name: string; model: string }) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center justify-between border-b border-octo-border bg-octo-panel/80 px-4 pl-20"
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono font-medium">{name}</span>
        <span className="text-zinc-600">•</span>
        <span className="text-xs text-zinc-500">{model}</span>
      </div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">
        Phase 1 — Foundation
      </div>
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
