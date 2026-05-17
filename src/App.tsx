import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { NewProjectFlow } from "./components/NewProjectFlow";
import { WorkspaceRail } from "./components/WorkspaceRail";
import { ContextHeader } from "./components/ContextHeader";
import { ModeSwitcher } from "./components/ModeSwitcher";
import { Companion } from "./components/Companion";
import { WorkspaceCustomizeMenu } from "./components/WorkspaceCustomizeMenu";
import { WorkspaceCreator } from "./components/WorkspaceCreator";
import { ChatView } from "./components/ChatView";
import { ChangesPanel } from "./components/ChangesPanel";
import { TerminalPane } from "./components/TerminalPane";
import { CommandPalette } from "./components/CommandPalette";
import { ToastContainer } from "./components/Toasts";
import { BrassRule } from "./components/BrassRule";
import { Settings } from "./components/Settings";
import { useProjectStore } from "./stores/projectStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useThemeStore } from "./stores/themeStore";
import { useTokenStore } from "./stores/tokenStore";
import type { SettingsTab } from "./lib/settingsTabs";
import { resolveMonogram } from "./lib/monogram";
import { type WorkspaceMode } from "./lib/modes";
import { ipc } from "./lib/ipc";
import type { GitStatus, TintName } from "./lib/types";

interface ChatRef {
  id: string;
  title: string;
  meta: string;
}

interface TerminalRef {
  id: string;
  label: string;
  meta: string;
  sessionId: string | null;
}

type AppView = "project" | "new-project";

function App() {
  const project = useProjectStore((s) => s.current);
  const loadTheme = useThemeStore((s) => s.load);
  const tokenReport = useTokenStore((s) => s.report);
  const refreshTokens = useTokenStore((s) => s.refresh);
  const {
    workspaces,
    activeId: activeWorkspaceId,
    load: loadWorkspaces,
    updateCustomization,
    select: selectWorkspace,
  } = useWorkspaceStore();

  const [appView, setAppView] = useState<AppView>("project");

  // Per-workspace state — modes, chats, terminals.
  const [modePerWorkspace, setModePerWorkspace] = useState<Record<string, WorkspaceMode>>({});
  const [chatsPerWorkspace, setChatsPerWorkspace] = useState<Record<string, ChatRef[]>>({});
  const [terminalsPerWorkspace, setTerminalsPerWorkspace] = useState<Record<string, TerminalRef[]>>({});
  const [activeChatPerWorkspace, setActiveChatPerWorkspace] = useState<Record<string, string>>({});
  const [activeTerminalPerWorkspace, setActiveTerminalPerWorkspace] = useState<Record<string, string>>({});

  // Overlay/menu state
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const [showCreator, setShowCreator] = useState(false);
  const [customizingWorkspaceId, setCustomizingWorkspaceId] = useState<string | null>(null);

  // Git status (refreshed on workspace change)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);

  // Layout version (forces TerminalPane fit-resize when sidebar/companion toggle)
  const layoutVersionRef = useRef(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const bumpLayout = useCallback(() => {
    layoutVersionRef.current += 1;
    setLayoutVersion(layoutVersionRef.current);
  }, []);

  const creatingTerminalRef = useRef<Set<string>>(new Set());

  // ── Theme load ──
  useEffect(() => {
    loadTheme();
  }, [loadTheme]);

  // Refresh token usage periodically so the Companion + Settings · Usage
  // stay current. 30s is enough for a workspace-level glance.
  useEffect(() => {
    refreshTokens();
    const id = setInterval(refreshTokens, 30_000);
    return () => clearInterval(id);
  }, [refreshTokens]);

  // ── Project switch → load workspaces, reset view ──
  useEffect(() => {
    if (project) {
      setAppView("project");
      setShowCreator(false);
      loadWorkspaces(project.id);
    } else {
      setShowCreator(false);
    }
  }, [project, loadWorkspaces]);

  // ── Initialize per-workspace state when a new workspace becomes active ──
  useEffect(() => {
    if (!activeWorkspaceId) return;
    setChatsPerWorkspace((prev) => {
      if (prev[activeWorkspaceId]) return prev;
      const initial: ChatRef = {
        id: activeWorkspaceId, // first chat uses workspace id as conversationId
        title: "Conversation",
        meta: "NOW",
      };
      return { ...prev, [activeWorkspaceId]: [initial] };
    });
    setActiveChatPerWorkspace((prev) =>
      prev[activeWorkspaceId] ? prev : { ...prev, [activeWorkspaceId]: activeWorkspaceId },
    );
    setTerminalsPerWorkspace((prev) => {
      if (prev[activeWorkspaceId]) return prev;
      const initial: TerminalRef = {
        id: `term-${activeWorkspaceId}-1`,
        label: "Main",
        meta: "READY",
        sessionId: null,
      };
      return { ...prev, [activeWorkspaceId]: [initial] };
    });
    setActiveTerminalPerWorkspace((prev) =>
      prev[activeWorkspaceId]
        ? prev
        : { ...prev, [activeWorkspaceId]: `term-${activeWorkspaceId}-1` },
    );
  }, [activeWorkspaceId]);

  // ── Refresh git status on workspace change ──
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    const path = ws?.worktreePath ?? project?.path;
    if (!path) {
      setGitStatus(null);
      return;
    }
    let cancelled = false;
    ipc.getGitStatus(path).then((s) => {
      if (!cancelled) setGitStatus(s);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, workspaces, project]);

  // ── Mode helpers ──
  const activeMode: WorkspaceMode =
    (activeWorkspaceId && modePerWorkspace[activeWorkspaceId]) || "talk";

  const setMode = useCallback(
    (next: WorkspaceMode) => {
      if (!activeWorkspaceId) return;
      setModePerWorkspace((p) => ({ ...p, [activeWorkspaceId]: next }));
    },
    [activeWorkspaceId],
  );

  // ── Lazily create a PTY session for the active terminal when entering Run mode ──
  const ensureTerminal = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const list = terminalsPerWorkspace[activeWorkspaceId] ?? [];
    const activeTid = activeTerminalPerWorkspace[activeWorkspaceId];
    const term = list.find((t) => t.id === activeTid);
    if (!term || term.sessionId) return;
    if (creatingTerminalRef.current.has(term.id)) return;
    creatingTerminalRef.current.add(term.id);
    try {
      const ws = workspaces.find((w) => w.id === activeWorkspaceId);
      if (!ws || !project) return;
      const session = await ipc.createSession({
        name: `${ws.name} - ${term.label}`,
        projectRoot: ws.worktreePath || project.path,
      });
      setTerminalsPerWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: (prev[activeWorkspaceId] ?? []).map((t) =>
          t.id === term.id ? { ...t, sessionId: session.id } : t,
        ),
      }));
    } finally {
      creatingTerminalRef.current.delete(term.id);
    }
  }, [activeWorkspaceId, terminalsPerWorkspace, activeTerminalPerWorkspace, workspaces, project]);

  useEffect(() => {
    if (activeMode === "run") {
      ensureTerminal();
    }
  }, [activeMode, ensureTerminal]);

  // ── Chat / terminal handlers wired to Companion ──
  const handleNewChat = useCallback(() => {
    if (!activeWorkspaceId) return;
    const newId = crypto.randomUUID();
    const list = chatsPerWorkspace[activeWorkspaceId] ?? [];
    const chat: ChatRef = {
      id: newId,
      title: `Conversation ${list.length + 1}`,
      meta: "NOW",
    };
    setChatsPerWorkspace((p) => ({ ...p, [activeWorkspaceId]: [chat, ...list] }));
    setActiveChatPerWorkspace((p) => ({ ...p, [activeWorkspaceId]: newId }));
  }, [activeWorkspaceId, chatsPerWorkspace]);

  const handleSelectChat = useCallback(
    (id: string) => {
      if (!activeWorkspaceId) return;
      setActiveChatPerWorkspace((p) => ({ ...p, [activeWorkspaceId]: id }));
    },
    [activeWorkspaceId],
  );

  const handleNewTerminal = useCallback(() => {
    if (!activeWorkspaceId) return;
    const list = terminalsPerWorkspace[activeWorkspaceId] ?? [];
    const term: TerminalRef = {
      id: `term-${activeWorkspaceId}-${list.length + 1}`,
      label: `Terminal ${list.length + 1}`,
      meta: "READY",
      sessionId: null,
    };
    setTerminalsPerWorkspace((p) => ({ ...p, [activeWorkspaceId]: [...list, term] }));
    setActiveTerminalPerWorkspace((p) => ({ ...p, [activeWorkspaceId]: term.id }));
  }, [activeWorkspaceId, terminalsPerWorkspace]);

  const handleSelectTerminal = useCallback(
    (id: string) => {
      if (!activeWorkspaceId) return;
      setActiveTerminalPerWorkspace((p) => ({ ...p, [activeWorkspaceId]: id }));
    },
    [activeWorkspaceId],
  );

  // ── Keyboard shortcuts (spec §3.6) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // ⌘1..⌘9 → switch workspace N
      if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        const ws = workspaces[idx];
        if (ws) {
          e.preventDefault();
          selectWorkspace(ws.id);
        }
        return;
      }

      // ⌘⇧1/2/3 → switch mode
      if (mod && e.shiftKey && ["1", "2", "3", "!", "@", "#"].includes(e.key)) {
        const key = e.key === "!" ? "1" : e.key === "@" ? "2" : e.key === "#" ? "3" : e.key;
        const mode: WorkspaceMode | null =
          key === "1" ? "talk" : key === "2" ? "run" : key === "3" ? "review" : null;
        if (mode) {
          e.preventDefault();
          setMode(mode);
        }
        return;
      }

      // ⌘N → new workspace
      if (mod && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        if (project) setShowCreator(true);
        return;
      }

      // ⌘K → command palette
      if (mod && !e.shiftKey && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
        return;
      }

      // ⌘\ → toggle companion (no-op for now; pending true companion visibility state)
      if (mod && e.key === "\\") {
        e.preventDefault();
        bumpLayout();
        return;
      }

      // ⌘, → Settings (General tab)
      if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsTab("general");
        return;
      }

      // ⌘⇧T → Settings · Usage
      if (mod && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        setSettingsTab("usage");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaces, selectWorkspace, setMode, project, bumpLayout]);

  // ── Computed values ──
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const activeChatId = activeWorkspaceId
    ? activeChatPerWorkspace[activeWorkspaceId] ?? activeWorkspaceId
    : null;
  const activeTerminal = activeWorkspaceId
    ? (terminalsPerWorkspace[activeWorkspaceId] ?? []).find(
        (t) => t.id === activeTerminalPerWorkspace[activeWorkspaceId],
      ) ?? null
    : null;

  const companionContextProps = useMemo(() => {
    const tokensUsed =
      (tokenReport?.totalInput ?? 0) + (tokenReport?.totalOutput ?? 0);
    return {
      tokensUsed,
      tokensLimit: 200_000,
      filesInFlight: gitStatus?.changedFiles.length ?? 0,
      toolCalls: 0,
    };
  }, [gitStatus, tokenReport]);

  const companionHistoryProps = useMemo(
    () => ({
      chats: activeWorkspaceId ? chatsPerWorkspace[activeWorkspaceId] ?? [] : [],
      activeChatId,
      onSelectChat: handleSelectChat,
      onNewChat: handleNewChat,
    }),
    [activeWorkspaceId, chatsPerWorkspace, activeChatId, handleSelectChat, handleNewChat],
  );

  const companionTerminalsProps = useMemo(
    () => ({
      terminals: activeWorkspaceId ? terminalsPerWorkspace[activeWorkspaceId] ?? [] : [],
      activeTerminalId: activeWorkspaceId
        ? activeTerminalPerWorkspace[activeWorkspaceId] ?? null
        : null,
      onSelectTerminal: handleSelectTerminal,
      onNewTerminal: handleNewTerminal,
    }),
    [
      activeWorkspaceId,
      terminalsPerWorkspace,
      activeTerminalPerWorkspace,
      handleSelectTerminal,
      handleNewTerminal,
    ],
  );

  const companionChangedProps = useMemo(
    () => ({ changedFiles: gitStatus?.changedFiles ?? [] }),
    [gitStatus],
  );

  // ── Customize menu submit ──
  const handleCustomizeSubmit = useCallback(
    async (glyph: string | null, tint: TintName | null) => {
      if (!customizingWorkspaceId) return;
      try {
        await updateCustomization(customizingWorkspaceId, glyph, tint);
      } catch (err) {
        console.error("Failed to update workspace customization:", err);
      } finally {
        setCustomizingWorkspaceId(null);
      }
    },
    [customizingWorkspaceId, updateCustomization],
  );

  // ── Render: pre-project views ──
  if (!project) {
    if (appView === "new-project") {
      return (
        <div className="flex h-screen w-screen bg-octo-bg text-octo-ivory">
          <NewProjectFlow onBack={() => setAppView("project")} />
          <ToastContainer />
        </div>
      );
    }
    return (
      <div className="flex h-screen w-screen bg-octo-bg text-octo-ivory">
        <WelcomeScreen onNewProject={() => setAppView("new-project")} />
        <ToastContainer />
      </div>
    );
  }

  // ── Render: workspace shell ──
  const customizingWorkspace = workspaces.find((w) => w.id === customizingWorkspaceId) ?? null;

  return (
    <div className="flex h-screen w-screen bg-octo-bg text-octo-ivory">
      <WorkspaceRail
        workspaces={workspaces}
        activeId={activeWorkspaceId}
        onSelect={(id) => selectWorkspace(id)}
        onCustomize={(id) => setCustomizingWorkspaceId(id)}
        onNewWorkspace={() => setShowCreator(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {activeWorkspace ? (
          <>
            <div className="flex items-start">
              <div className="min-w-0 flex-1">
                <ContextHeader
                  workspaceName={activeWorkspace.name}
                  branch={activeWorkspace.branch}
                  gitStatus={gitStatus}
                />
              </div>
              <ModeSwitcher mode={activeMode} onChange={setMode} />
            </div>

            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="relative min-w-0 flex-1 overflow-hidden">
                {showCreator && (
                  <WorkspaceCreator
                    projectId={project.id}
                    projectPath={project.path}
                    onCreated={() => setShowCreator(false)}
                    onCancel={() => setShowCreator(false)}
                  />
                )}
                {!showCreator && (
                  <>
                    <div
                      className="absolute inset-0 transition-opacity duration-200 ease-out"
                      style={{
                        opacity: activeMode === "talk" ? 1 : 0,
                        pointerEvents: activeMode === "talk" ? "auto" : "none",
                        visibility: activeMode === "talk" ? "visible" : "hidden",
                      }}
                    >
                      <ChatView
                        workspaceId={activeChatId!}
                        workspacePath={activeWorkspace.worktreePath || project.path}
                        onOpenSettings={() => setSettingsTab("general")}
                      />
                    </div>

                    <div
                      className="absolute inset-0 transition-opacity duration-200 ease-out"
                      style={{
                        opacity: activeMode === "run" ? 1 : 0,
                        pointerEvents: activeMode === "run" ? "auto" : "none",
                        visibility: activeMode === "run" ? "visible" : "hidden",
                      }}
                    >
                      {activeTerminal?.sessionId ? (
                        <TerminalPane
                          sessionId={activeTerminal.sessionId}
                          visible={activeMode === "run"}
                          layoutVersion={layoutVersion}
                        />
                      ) : (
                        <RunEmptyState onStart={ensureTerminal} />
                      )}
                    </div>

                    <div
                      className="absolute inset-0 transition-opacity duration-200 ease-out"
                      style={{
                        opacity: activeMode === "review" ? 1 : 0,
                        pointerEvents: activeMode === "review" ? "auto" : "none",
                        visibility: activeMode === "review" ? "visible" : "hidden",
                      }}
                    >
                      {(gitStatus?.changedFiles.length ?? 0) > 0 ? (
                        <ChangesPanel projectPath={activeWorkspace.worktreePath || project.path} />
                      ) : (
                        <ReviewEmptyState />
                      )}
                    </div>
                  </>
                )}
              </div>

              <Companion
                mode={activeMode}
                contextProps={companionContextProps}
                historyProps={companionHistoryProps}
                terminalsProps={companionTerminalsProps}
                changedProps={companionChangedProps}
              />
            </div>
          </>
        ) : (
          <WorkspaceCreator
            projectId={project.id}
            projectPath={project.path}
            onCreated={() => setShowCreator(false)}
            onCancel={() => setShowCreator(false)}
          />
        )}
      </main>

      {customizingWorkspace && (
        <div
          className="absolute inset-0 z-30 flex items-start justify-start bg-black/30 p-2"
          onClick={() => setCustomizingWorkspaceId(null)}
          role="dialog"
          aria-modal="true"
        >
          <div onClick={(e) => e.stopPropagation()} className="ml-14 mt-12">
            <WorkspaceCustomizeMenu
              initialGlyph={customizingWorkspace.glyph}
              initialTint={customizingWorkspace.tint}
              defaultGlyph={resolveMonogram({ ...customizingWorkspace, glyph: null, tint: null }).glyph}
              onSubmit={handleCustomizeSubmit}
              onCancel={() => setCustomizingWorkspaceId(null)}
            />
          </div>
        </div>
      )}

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        onNewSession={() => {
          setShowPalette(false);
          setShowCreator(true);
        }}
        onToggleTokens={() => setSettingsTab("usage")}
      />

      <Settings
        open={settingsTab !== null}
        initialTab={settingsTab ?? "general"}
        onClose={() => setSettingsTab(null)}
      />

      <ToastContainer />
    </div>
  );
}

function RunEmptyState({ onStart }: { onStart: () => Promise<void> | void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Run
      </div>
      <div className="font-serif italic text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Start a new terminal.
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        A terminal opens in the workspace's worktree directory. You can keep multiple terminals open and switch via the Companion panel.
      </p>
      <button
        type="button"
        onClick={() => onStart()}
        className="mt-2 rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition"
        style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
      >
        Open terminal
      </button>
    </div>
  );
}

function ReviewEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Review
      </div>
      <div className="font-serif italic text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Nothing to review yet.
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        When the workspace has uncommitted changes, the diff appears here.
      </p>
      <BrassRule className="mt-2 w-7" />
    </div>
  );
}

export default App;
