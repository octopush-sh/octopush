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
import { EditorPane } from "./components/EditorPane";
import { EditorTabs } from "./components/EditorTabs";
import { useEditorStore } from "./stores/editorStore";
import { TerminalPane } from "./components/TerminalPane";
import { CommandPalette } from "./components/CommandPalette";
import { ToastContainer } from "./components/Toasts";
import { BrassRule } from "./components/BrassRule";
import { Settings } from "./components/Settings";
import { useProjectStore } from "./stores/projectStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useThemeStore } from "./stores/themeStore";
import { useTokenStore } from "./stores/tokenStore";
import { useTerminalsStore } from "./stores/terminalsStore";
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

  // Per-workspace state — modes, chats.
  const [modePerWorkspace, setModePerWorkspace] = useState<Record<string, WorkspaceMode>>({});
  const [chatsPerWorkspace, setChatsPerWorkspace] = useState<Record<string, ChatRef[]>>({});
  const [activeChatPerWorkspace, setActiveChatPerWorkspace] = useState<Record<string, string>>({});

  // Terminal store selectors.
  // Important: always call the store's getTerminals/getActiveId selectors with
  // a non-null key — those return stable references (EMPTY_TERMINALS constant
  // or null) when the workspace is unknown. Using an inline `[]` fallback here
  // would create a fresh array each render and trigger an infinite re-render
  // loop (React error #185), the same trap that bit chatStore historically.
  const terminals = useTerminalsStore((s) => s.getTerminals(activeWorkspaceId ?? ""));
  const activeTerminalId = useTerminalsStore((s) => s.getActiveId(activeWorkspaceId ?? ""));
  const terminalsByWs = useTerminalsStore((s) => s.terminalsByWs);
  const loadTerminals = useTerminalsStore((s) => s.loadTerminals);
  const createTerminal = useTerminalsStore((s) => s.createTerminal);
  const markRunning = useTerminalsStore((s) => s.markRunning);
  const setActiveTerminal = useTerminalsStore((s) => s.setActive);

  // Flat list of every (workspace, terminal) pair so the Run panel can mount
  // every TerminalPane simultaneously. This is the only way to keep PTYs and
  // their xterm scrollback alive across workspace switches — if we only
  // rendered the active workspace's panes, switching would unmount the
  // previous workspace's panes and their cleanup would kill the PTYs.
  const allTerminalRefs = useMemo(() => {
    return Object.entries(terminalsByWs).flatMap(([wsId, ts]) =>
      ts.map((t) => ({ workspaceId: wsId, ...t })),
    );
  }, [terminalsByWs]);

  // Overlay/menu state
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const [showCreator, setShowCreator] = useState(false);
  const [customizingWorkspaceId, setCustomizingWorkspaceId] = useState<string | null>(null);

  // Git status + diff (refreshed on workspace change)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitDiff, setGitDiff] = useState<string>("");

  // Layout version (forces TerminalPane fit-resize when sidebar/companion toggle)
  const layoutVersionRef = useRef(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const bumpLayout = useCallback(() => {
    layoutVersionRef.current += 1;
    setLayoutVersion(layoutVersionRef.current);
  }, []);

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
    // Hydrate terminals from DB; auto-create "Main" if the workspace is empty.
    loadTerminals(activeWorkspaceId).then(() => {
      const list = useTerminalsStore.getState().getTerminals(activeWorkspaceId);
      if (list.length === 0) {
        createTerminal(activeWorkspaceId, "Main").catch(console.error);
      }
    }).catch(console.error);
  }, [activeWorkspaceId, loadTerminals, createTerminal]);

  // ── Refresh git status + diff on workspace change ──
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    const path = ws?.worktreePath ?? project?.path;
    if (!path) {
      setGitStatus(null);
      setGitDiff("");
      return;
    }
    let cancelled = false;
    Promise.all([
      ipc.getGitStatus(path),
      ipc.getGitDiff(path).catch(() => ""),
    ]).then(([s, d]) => {
      if (!cancelled) {
        setGitStatus(s);
        setGitDiff(d);
      }
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

      // ⌘⌥1..9 → cycle within-workspace terminals (must check altKey to avoid
      // colliding with ⌘1..9 workspace shortcuts above).
      if (mod && e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        if (activeWorkspaceId) {
          const list = useTerminalsStore.getState().getTerminals(activeWorkspaceId);
          const idx = parseInt(e.key, 10) - 1;
          const target = list[idx];
          if (target) {
            setActiveTerminal(activeWorkspaceId, target.id);
          }
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaces, selectWorkspace, setMode, project, bumpLayout, activeWorkspaceId, setActiveTerminal]);

  // ── Computed values ──
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const activeChatId = activeWorkspaceId
    ? activeChatPerWorkspace[activeWorkspaceId] ?? activeWorkspaceId
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

  const openFileInEditor = useEditorStore((s) => s.openFile);

  const fileTreeProps = useMemo(() => {
    if (!activeWorkspace) return undefined;
    const rootPath = activeWorkspace.worktreePath || project!.path;
    return {
      rootPath,
      rootLabel: activeWorkspace.name,
      changedPaths: new Set(
        (gitStatus?.changedFiles ?? []).map((f) => `${rootPath}/${f.path}`),
      ),
      onFileClick: (p: string) => openFileInEditor(activeWorkspace.id, p).catch(console.error),
    };
  }, [activeWorkspace, project, gitStatus, openFileInEditor]);

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
                      {/* Mount-once panes — one per (workspace, terminal) pair
                          across the entire store. Visibility is toggled via
                          display:block/none so xterm never unmounts and PTYs
                          stay alive across workspace AND mode switches. */}
                      <div className="relative h-full w-full">
                        {allTerminalRefs.map((t) => {
                          const ws = workspaces.find((w) => w.id === t.workspaceId);
                          const wsPath = ws?.worktreePath || project.path;
                          return (
                            <TerminalPane
                              key={t.id}
                              terminalId={t.id}
                              workspacePath={wsPath}
                              label={t.label}
                              visible={
                                activeMode === "run" &&
                                t.workspaceId === activeWorkspaceId &&
                                t.id === activeTerminalId
                              }
                              layoutVersion={layoutVersion}
                              onSpawn={() => markRunning(t.workspaceId, t.id, true)}
                              onExit={() => markRunning(t.workspaceId, t.id, false)}
                            />
                          );
                        })}
                        {terminals.length === 0 && (
                          <RunEmptyState
                            onStart={() => {
                              createTerminal(activeWorkspaceId!, "Main").catch(console.error);
                            }}
                          />
                        )}
                      </div>
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
                        <div className="flex h-full min-h-0">
                          {/* Left: Changes panel (fixed width) */}
                          <div className="w-[320px] shrink-0 border-r border-octo-hairline">
                            <ChangesPanel
                              projectPath={activeWorkspace.worktreePath || project.path}
                              diff={gitDiff}
                            />
                          </div>
                          {/* Middle: Editor canvas */}
                          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                            <EditorTabs workspaceId={activeWorkspaceId!} />
                            <EditorPane
                              workspaceId={activeWorkspaceId!}
                              workspacePath={activeWorkspace.worktreePath || project.path}
                              diffText={gitDiff}
                            />
                          </div>
                        </div>
                      ) : (
                        <ReviewEmptyState />
                      )}
                    </div>
                  </>
                )}
              </div>

              <Companion
                mode={activeMode}
                workspaceId={activeWorkspaceId}
                contextProps={companionContextProps}
                historyProps={companionHistoryProps}
                fileTree={fileTreeProps}
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
