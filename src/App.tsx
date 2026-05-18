import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { NewProjectFlow } from "./components/NewProjectFlow";
import { WorkspaceRail } from "./components/WorkspaceRail";
import { ContextHeader } from "./components/ContextHeader";
import { ModeSwitcher } from "./components/ModeSwitcher";
import { Companion } from "./components/Companion";
import { WorkspaceCustomizeMenu } from "./components/WorkspaceCustomizeMenu";
import { WorkspaceCreator } from "./components/WorkspaceCreator";
import { WorkspaceContextMenu } from "./components/WorkspaceContextMenu";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { ChatView } from "./components/ChatView";
import { ChangesPanel } from "./components/ChangesPanel";
import { EditorPane } from "./components/EditorPane";
import { EditorTabs } from "./components/EditorTabs";
import { useEditorStore } from "./stores/editorStore";
import { TerminalPane } from "./components/TerminalPane";
import { CommandPalette } from "./components/CommandPalette";
import { ToastContainer, pushToast } from "./components/Toasts";
import { Settings } from "./components/Settings";
import { useProjectStore } from "./stores/projectStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useThemeStore } from "./stores/themeStore";
import { useTokenStore } from "./stores/tokenStore";
import { useTerminalsStore } from "./stores/terminalsStore";
import { useChatStore } from "./stores/chatStore";
import { listen } from "@tauri-apps/api/event";
import type { ModelWithProvider } from "./lib/types";
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
  const refreshTokens = useTokenStore((s) => s.refresh);
  const {
    workspaces,
    activeId: activeWorkspaceId,
    load: loadWorkspaces,
    updateCustomization,
    select: selectWorkspace,
    remove: removeWorkspace,
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

  // Project store — for switcher
  const recentProjects = useProjectStore((s) => s.recent);
  const loadRecentProjects = useProjectStore((s) => s.loadRecent);
  const openProject = useProjectStore((s) => s.open);

  // Overlay/menu state
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const [showCreator, setShowCreator] = useState(false);
  const [customizingWorkspaceId, setCustomizingWorkspaceId] = useState<string | null>(null);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  // When the user opens NewProjectFlow from the switcher (not from the welcome
  // screen), we render it as an overlay on top of the current project — the
  // !project early-return path doesn't fire and the create/clone form needs to
  // live somewhere else.
  const [showAddProject, setShowAddProject] = useState(false);
  // Context menu: which workspace and where
  const [contextMenu, setContextMenu] = useState<{ workspaceId: string; x: number; y: number } | null>(null);
  // Pending delete confirmation
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  // Inline workspace creator shown from the empty-project state.
  const [showInlineCreator, setShowInlineCreator] = useState(false);

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

  // ── Startup toast: count restored terminal sessions ──
  // We only fire this once per Octopush lifetime, not on every re-render.
  const restoredToastFiredRef = useRef(false);
  useEffect(() => {
    if (restoredToastFiredRef.current) return;
    const allTerminals = Object.values(terminalsByWs).flat();
    const restoredCount = allTerminals.filter((t) => t.restored).length;
    if (restoredCount > 0) {
      restoredToastFiredRef.current = true;
      pushToast({
        level: "info",
        title: `Restored ${restoredCount} terminal session${restoredCount > 1 ? "s" : ""}`,
        body: "Continuing from before Octopush restarted.",
      });
    }
  }, [terminalsByWs]);

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

  // Refresh tokens immediately when a chat turn finishes — the backend has
  // just persisted the final assistant message with its token counts, so the
  // Companion's tokens row should reflect that without waiting for the 30s
  // poll tick.
  useEffect(() => {
    const unlistenPromise = listen<{ done: boolean }>("chat://stream", (ev) => {
      if (ev.payload.done) refreshTokens();
    });
    return () => {
      unlistenPromise.then((u) => u());
    };
  }, [refreshTokens]);

  // ── Project switch → load workspaces, reset view ──
  useEffect(() => {
    if (project) {
      setAppView("project");
      setShowCreator(false);
      // Close the "Add project" overlay automatically once the new project
      // becomes active (NewProjectFlow's create/clone success sets it).
      setShowAddProject(false);
      // Reset the inline-creator flag so a freshly switched-to project
      // shows the empty state, not the creator from the previous project.
      setShowInlineCreator(false);
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

  // ── Refresh git status + diff on workspace change AND on a 3s interval ──
  // The interval is necessary because the agentic loop in Talk mode can mutate
  // files in the worktree without any UI event we can hook into. Without
  // polling, the Review panel would show stale "Nothing to review" until the
  // user toggled workspaces. 3s is the sweet spot — fast enough to feel live,
  // not so often that we hammer git on huge repos.
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    const path = ws?.worktreePath ?? project?.path;
    if (!path) {
      setGitStatus(null);
      setGitDiff("");
      return;
    }
    let cancelled = false;
    const refresh = () => {
      Promise.all([
        ipc.getGitStatus(path),
        ipc.getGitDiff(path).catch(() => ""),
      ]).then(([s, d]) => {
        if (!cancelled) {
          setGitStatus(s);
          setGitDiff(d);
        }
      }).catch(() => {});
    };
    refresh();
    const id = setInterval(refresh, 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
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

  // Count tool calls live from the active chat's messages — chatStore is
  // updated on every `chat://message-added` event the backend emits, so the
  // counter ticks up in real time as the agent invokes tools.
  const activeChatMessages = useChatStore((s) =>
    s.getMessages(activeChatId ?? ""),
  );
  const liveToolCalls = useMemo(
    () => activeChatMessages.filter((m) => m.role === "tool").length,
    [activeChatMessages],
  );

  const activeModel = useChatStore((s) => s.model);

  // Load the model registry once so we can resolve max_context for the
  // active model. Cheap call; the result is stable across the app lifetime.
  const [modelCatalog, setModelCatalog] = useState<ModelWithProvider[]>([]);
  useEffect(() => {
    ipc.listModels().then(setModelCatalog).catch(() => {});
  }, []);

  const activeModelMaxContext = useMemo(() => {
    const found = modelCatalog.find((m) => m.model.id === activeModel);
    return found?.model.maxContext ?? 200_000;
  }, [modelCatalog, activeModel]);

  // Context window usage of the most recent assistant turn in the active
  // chat. Numerator = inputTokens of the latest assistant message (that's
  // exactly what filled the model's prompt for the next response).
  // Denominator = max_context of the active model. This lets the user see
  // how close they are to the conversation memory ceiling.
  const lastTurnInputTokens = useMemo(() => {
    for (let i = activeChatMessages.length - 1; i >= 0; i--) {
      const m = activeChatMessages[i];
      if (m.role === "assistant" && m.inputTokens != null) {
        return m.inputTokens;
      }
    }
    return 0;
  }, [activeChatMessages]);

  const companionContextProps = useMemo(() => {
    return {
      tokensUsed: lastTurnInputTokens,
      tokensLimit: activeModelMaxContext,
      unstaged: gitStatus?.changedFiles.length ?? 0,
      toolCalls: liveToolCalls,
    };
  }, [gitStatus, lastTurnInputTokens, activeModelMaxContext, liveToolCalls]);

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

  // ── Workspace delete handler ──
  const handleDeleteWorkspace = useCallback(async () => {
    if (!deletingWorkspaceId || !project) return;
    const ws = workspaces.find((w) => w.id === deletingWorkspaceId);
    if (!ws) {
      setDeletingWorkspaceId(null);
      return;
    }
    const wsName = ws.name;
    try {
      await removeWorkspace(ws.id, project.path, ws.branch, ws.worktreePath ?? null);
      // After removal, auto-select the first remaining workspace if active became null.
      const remaining = useWorkspaceStore.getState().workspaces;
      if (!useWorkspaceStore.getState().activeId && remaining.length > 0) {
        selectWorkspace(remaining[0].id);
      }
      pushToast({ level: "success", title: `Deleted workspace "${wsName}"` });
    } catch (err) {
      pushToast({ level: "error", title: "Delete failed", body: String(err) });
    } finally {
      setDeletingWorkspaceId(null);
    }
  }, [deletingWorkspaceId, project, workspaces, removeWorkspace, selectWorkspace]);

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
        onContextMenu={(workspaceId, x, y) => setContextMenu({ workspaceId, x, y })}
        onNewWorkspace={() => setShowCreator(true)}
      />

      <main className="flex min-w-0 flex-1 overflow-hidden">
        {/* LEFT COLUMN — always mounted so the canvas (and the TerminalPanes
            inside the Run mode panel) survive any moment when there's no
            active workspace, e.g. just after creating a fresh project that
            has zero workspaces yet. Previously a top-level
            {activeWorkspace ? <shell> : <EmptyState>} conditional was
            unmounting every running PTY whenever the user crossed that
            boundary. */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden pb-4">
          {activeWorkspace && (
            <ContextHeader
              projectName={project.name}
              onOpenProjectSwitcher={() => {
                loadRecentProjects();
                setShowProjectSwitcher(true);
              }}
              workspaceName={activeWorkspace.name}
              branch={activeWorkspace.branch}
              gitStatus={gitStatus}
            />
          )}

          <div className="relative min-w-0 flex-1 overflow-hidden">
            {/* Talk panel — chat for the active workspace. */}
            <div
              className="absolute inset-0 transition-opacity duration-200 ease-out"
              style={{
                opacity: activeWorkspace && activeMode === "talk" ? 1 : 0,
                pointerEvents:
                  activeWorkspace && activeMode === "talk" ? "auto" : "none",
                visibility:
                  activeWorkspace && activeMode === "talk" ? "visible" : "hidden",
              }}
            >
              {activeWorkspace && (
                <ChatView
                  workspaceId={activeChatId!}
                  workspacePath={activeWorkspace.worktreePath || project.path}
                  onOpenSettings={() => setSettingsTab("general")}
                />
              )}
            </div>

            {/* Run panel — TerminalPanes for ALL (workspace, terminal) pairs
                in the store are mounted here unconditionally. Individual
                panes hide via display:none when not the active one, but the
                container itself is never gated by activeWorkspace, so PTYs
                survive project switches and new-project creation. */}
            <div
              className="absolute inset-0 transition-opacity duration-200 ease-out"
              style={{
                opacity: activeMode === "run" ? 1 : 0,
                pointerEvents: activeMode === "run" ? "auto" : "none",
                visibility: activeMode === "run" ? "visible" : "hidden",
              }}
            >
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
                        !!activeWorkspaceId &&
                        t.workspaceId === activeWorkspaceId &&
                        t.id === activeTerminalId
                      }
                      layoutVersion={layoutVersion}
                      onSpawn={() => markRunning(t.workspaceId, t.id, true)}
                      onExit={() => markRunning(t.workspaceId, t.id, false)}
                      onReattach={() => {
                        // Mark as running (it already was, but be explicit).
                        markRunning(t.workspaceId, t.id, true);
                      }}
                    />
                  );
                })}
                {activeWorkspace && terminals.length === 0 && (
                  <RunEmptyState
                    onStart={() => {
                      createTerminal(activeWorkspaceId!, "Main").catch(console.error);
                    }}
                  />
                )}
              </div>
            </div>

            {/* Review panel — only meaningful with an active workspace. */}
            <div
              className="absolute inset-0 transition-opacity duration-200 ease-out"
              style={{
                opacity: activeWorkspace && activeMode === "review" ? 1 : 0,
                pointerEvents:
                  activeWorkspace && activeMode === "review" ? "auto" : "none",
                visibility:
                  activeWorkspace && activeMode === "review" ? "visible" : "hidden",
              }}
            >
              {activeWorkspace && (
                <div className="flex h-full min-h-0">
                  {(gitStatus?.changedFiles.length ?? 0) > 0 && (
                    <div className="w-[320px] shrink-0 border-r border-octo-hairline">
                      <ChangesPanel
                        projectPath={activeWorkspace.worktreePath || project.path}
                        diff={gitDiff}
                      />
                    </div>
                  )}
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <EditorTabs workspaceId={activeWorkspaceId!} />
                    <EditorPane
                      workspaceId={activeWorkspaceId!}
                      workspacePath={activeWorkspace.worktreePath || project.path}
                      diffText={gitDiff}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Workspace creator overlay (from the rail "+" button). */}
            {showCreator && (
              <div className="absolute inset-0 z-50 bg-octo-bg">
                <WorkspaceCreator
                  projectId={project.id}
                  projectPath={project.path}
                  onCreated={() => setShowCreator(false)}
                  onCancel={() => setShowCreator(false)}
                />
              </div>
            )}

            {/* Empty-project layer — overlays the canvas when there is no
                active workspace. The shell underneath stays mounted so any
                running terminals from other projects keep their PTYs and
                scrollback intact. */}
            {!activeWorkspace && (
              <div className="absolute inset-0 z-40 bg-octo-bg">
                {showInlineCreator ? (
                  <WorkspaceCreator
                    projectId={project.id}
                    projectPath={project.path}
                    onCreated={() => setShowInlineCreator(false)}
                    onCancel={() => setShowInlineCreator(false)}
                  />
                ) : (
                  <EmptyProjectState
                    projectName={project.name}
                    onCreateWorkspace={() => setShowInlineCreator(true)}
                    onSwitchProject={() => {
                      loadRecentProjects();
                      setShowProjectSwitcher(true);
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN — ModeSwitcher + Companion always mounted. When
            there's no active workspace the panel just shows empty/default
            data; the structure is preserved. */}
        <div className="flex w-[312px] shrink-0 flex-col gap-3 p-4 pl-0">
          <ModeSwitcher mode={activeMode} onChange={setMode} />
          <Companion
            mode={activeMode}
            workspaceId={activeWorkspaceId}
            contextProps={companionContextProps}
            historyProps={companionHistoryProps}
            fileTree={fileTreeProps}
          />
        </div>
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

      {/* Workspace context menu (right-click on monogram) */}
      {contextMenu && (() => {
        const ws = workspaces.find((w) => w.id === contextMenu.workspaceId);
        return ws ? (
          <WorkspaceContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            workspaceName={ws.name}
            onCustomize={() => {
              setContextMenu(null);
              setCustomizingWorkspaceId(contextMenu.workspaceId);
            }}
            onDelete={() => {
              setContextMenu(null);
              setDeletingWorkspaceId(contextMenu.workspaceId);
            }}
            onClose={() => setContextMenu(null)}
          />
        ) : null;
      })()}

      {/* Delete confirmation modal */}
      {deletingWorkspaceId && (() => {
        const ws = workspaces.find((w) => w.id === deletingWorkspaceId);
        return ws ? (
          <ConfirmDialog
            title={`Delete "${ws.name}"?`}
            body={`This will remove the worktree and branch from disk. This cannot be undone.`}
            destructiveLabel="Delete workspace"
            onConfirm={handleDeleteWorkspace}
            onCancel={() => setDeletingWorkspaceId(null)}
          />
        ) : null;
      })()}

      {/* Project switcher sheet — overlaid without unmounting the canvas */}
      {showAddProject && (
        <div className="absolute inset-0 z-50 bg-octo-bg">
          <NewProjectFlow
            onBack={() => setShowAddProject(false)}
          />
        </div>
      )}

      {showProjectSwitcher && project && (
        <div className="absolute inset-0 z-50">
          <ProjectSwitcher
            activeProjectId={project.id}
            projects={recentProjects}
            onSelect={(p) => {
              openProject(p.path);
              setShowProjectSwitcher(false);
            }}
            onAddProject={() => {
              setShowProjectSwitcher(false);
              setShowAddProject(true);
            }}
            onClose={() => setShowProjectSwitcher(false)}
          />
        </div>
      )}

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

function EmptyProjectState({
  projectName,
  onCreateWorkspace,
  onSwitchProject,
}: {
  projectName: string;
  onCreateWorkspace: () => void;
  onSwitchProject: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Project
      </div>
      <div className="font-serif italic text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        {projectName}
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        No workspaces here yet. Workspaces are isolated git worktrees — one per task you're working on.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={onCreateWorkspace}
          className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          Create a workspace
        </button>
        <button
          type="button"
          onClick={onSwitchProject}
          className="rounded-md px-3 py-2 text-[12px] text-octo-mute transition hover:text-octo-sage"
        >
          Switch project
        </button>
      </div>
    </div>
  );
}

export default App;
