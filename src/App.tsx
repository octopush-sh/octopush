import { useEffect, useRef, useState, useCallback } from "react";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { NewProjectFlow } from "./components/NewProjectFlow";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { WorkspaceBar } from "./components/WorkspaceBar";
import type { WorkspaceTab } from "./components/WorkspaceBar";
import { WorkspaceCreator } from "./components/WorkspaceCreator";
import { ChatView } from "./components/ChatView";
import { ChangesPanel } from "./components/ChangesPanel";
import { TerminalPane } from "./components/TerminalPane";
import { TokenDashboard } from "./components/TokenDashboard";
import { CommandPalette } from "./components/CommandPalette";
import { ToastContainer } from "./components/Toasts";
import { SettingsDialog } from "./components/SettingsDialog";
import { useProjectStore } from "./stores/projectStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useThemeStore } from "./stores/themeStore";
import { ipc } from "./lib/ipc";

type AppView = "welcome" | "new-project" | "terminal" | "chat" | "changes";

function App() {
  const project = useProjectStore((s) => s.current);
  const loadTheme = useThemeStore((s) => s.load);
  const { workspaces, activeId: activeWorkspaceId, load: loadWorkspaces } = useWorkspaceStore();

  const [view, _setView] = useState<AppView>("welcome");
  const [viewPerWorkspace, setViewPerWorkspace] = useState<Record<string, string>>({});
  const [showSidebar, setShowSidebar] = useState(true);

  // Multi-tab state
  const [tabsPerWorkspace, setTabsPerWorkspace] = useState<Record<string, WorkspaceTab[]>>({});
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Wrapper that tracks per-workspace view
  const setView = useCallback((v: AppView) => {
    _setView(v);
    const wsId = useWorkspaceStore.getState().activeId;
    if (wsId && v !== "welcome" && v !== "new-project") {
      setViewPerWorkspace((prev) => ({ ...prev, [wsId]: v }));
    }
  }, []);
  const [showTokens, setShowTokens] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showCreator, setShowCreator] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const creatingSessionRef = useRef<Set<string>>(new Set());

  const layoutVersionRef = useRef(0);
  const [layoutVersion, setLayoutVersion] = useState(0);

  const bumpLayout = useCallback(() => {
    layoutVersionRef.current += 1;
    setLayoutVersion(layoutVersionRef.current);
  }, []);

  // Ensure tabs exist for a workspace, returns current tabs
  const ensureTabs = useCallback((wsId: string): WorkspaceTab[] => {
    const existing = tabsPerWorkspace[wsId];
    if (existing && existing.length > 0) return existing;
    const initial: WorkspaceTab[] = [
      { id: `chat-${wsId}`, type: "chat", label: "Chat", conversationId: wsId },
    ];
    setTabsPerWorkspace((prev) => ({ ...prev, [wsId]: initial }));
    return initial;
  }, [tabsPerWorkspace]);

  // Load theme on startup
  useEffect(() => {
    loadTheme();
  }, [loadTheme]);

  // When project becomes non-null, switch to hub and load workspaces
  useEffect(() => {
    if (project) {
      setView("chat");
      setShowCreator(false);
      loadWorkspaces(project.id);
    } else {
      setView("welcome");
      setShowCreator(false);
    }
  }, [project, loadWorkspaces]);

  // When active workspace changes (sidebar click), restore last view or default to chat
  const prevWorkspaceRef = useRef(activeWorkspaceId);
  useEffect(() => {
    if (activeWorkspaceId && activeWorkspaceId !== prevWorkspaceRef.current) {
      const tabs = ensureTabs(activeWorkspaceId);
      const lastView = viewPerWorkspace[activeWorkspaceId] as AppView || "chat";
      _setView(lastView);
      // Find a tab matching the last view, or fall back to first tab
      if (lastView === "chat" || lastView === "terminal") {
        const matchingTab = tabs.find((t) => t.type === lastView);
        setActiveTabId(matchingTab?.id || tabs[0]?.id || null);
      }
      setShowCreator(false);
    }
    prevWorkspaceRef.current = activeWorkspaceId;
  }, [activeWorkspaceId, viewPerWorkspace]);

  // Ensure terminal session for a tab
  const ensureTerminalForTab = useCallback(async (tab: WorkspaceTab) => {
    if (tab.sessionId) return;
    if (!activeWorkspaceId) return;
    if (creatingSessionRef.current.has(tab.id)) return;

    creatingSessionRef.current.add(tab.id);
    try {
      const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === activeWorkspaceId);
      const proj = useProjectStore.getState().current;
      if (!ws || !proj) return;

      const session = await ipc.createSession({
        name: `${ws.name} - ${tab.label}`,
        projectRoot: ws.worktreePath || proj.path,
      });
      setTabsPerWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId!]: (prev[activeWorkspaceId!] || []).map((t) =>
          t.id === tab.id ? { ...t, sessionId: session.id } : t
        ),
      }));
    } finally {
      creatingSessionRef.current.delete(tab.id);
    }
  }, [activeWorkspaceId]);

  // Tab actions
  const addChatTab = useCallback(() => {
    if (!activeWorkspaceId) return;
    const newId = `chat-${Date.now()}`;
    const convId = crypto.randomUUID ? crypto.randomUUID() : `conv-${Date.now()}`;
    const existing = tabsPerWorkspace[activeWorkspaceId] || [];
    const chatCount = existing.filter((t) => t.type === "chat").length;
    const tab: WorkspaceTab = {
      id: newId,
      type: "chat",
      label: `Chat ${chatCount + 1}`,
      conversationId: convId,
    };
    setTabsPerWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: [...(prev[activeWorkspaceId] || []), tab],
    }));
    setActiveTabId(newId);
    setView("chat");
  }, [activeWorkspaceId, tabsPerWorkspace, setView]);

  const addTerminalTab = useCallback(() => {
    if (!activeWorkspaceId) return;
    const newId = `term-${Date.now()}`;
    const existing = tabsPerWorkspace[activeWorkspaceId] || [];
    const termCount = existing.filter((t) => t.type === "terminal").length;
    const tab: WorkspaceTab = {
      id: newId,
      type: "terminal",
      label: `Terminal ${termCount + 1}`,
    };
    setTabsPerWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: [...(prev[activeWorkspaceId] || []), tab],
    }));
    setActiveTabId(newId);
    setView("terminal");
  }, [activeWorkspaceId, tabsPerWorkspace, setView]);

  const closeTab = useCallback((tabId: string) => {
    if (!activeWorkspaceId) return;
    const tabs = tabsPerWorkspace[activeWorkspaceId] || [];
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Don't close the last tab of a type
    const sameType = tabs.filter((t) => t.type === tab.type);
    if (sameType.length <= 1) return;
    const newTabs = tabs.filter((t) => t.id !== tabId);
    setTabsPerWorkspace((prev) => ({ ...prev, [activeWorkspaceId]: newTabs }));
    // If closing the active tab, switch to another of the same type
    if (activeTabId === tabId) {
      const next = newTabs.find((t) => t.type === tab.type);
      if (next) {
        setActiveTabId(next.id);
      }
    }
  }, [activeWorkspaceId, tabsPerWorkspace, activeTabId]);

  const selectTab = useCallback((tabId: string) => {
    const tabs = tabsPerWorkspace[activeWorkspaceId || ""] || [];
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      setActiveTabId(tabId);
      setView(tab.type);
      // If it's a terminal tab without a session, create one
      if (tab.type === "terminal" && !tab.sessionId) {
        ensureTerminalForTab(tab);
      }
    }
  }, [activeWorkspaceId, tabsPerWorkspace, setView, ensureTerminalForTab]);

  // Handle switching to terminal view (for keyboard shortcut)
  const openTerminal = useCallback(() => {
    if (!activeWorkspaceId) return;
    setShowCreator(false);
    const tabs = tabsPerWorkspace[activeWorkspaceId] || ensureTabs(activeWorkspaceId);
    const termTab = tabs.find((t) => t.type === "terminal");
    if (termTab) {
      setActiveTabId(termTab.id);
      setView("terminal");
      if (!termTab.sessionId) {
        ensureTerminalForTab(termTab);
      }
    } else {
      // No terminal tabs exist yet, create one
      addTerminalTab();
    }
  }, [activeWorkspaceId, tabsPerWorkspace, ensureTabs, setView, ensureTerminalForTab, addTerminalTab]);

  const openChat = useCallback(() => {
    if (!activeWorkspaceId) return;
    setShowCreator(false);
    const tabs = tabsPerWorkspace[activeWorkspaceId] || ensureTabs(activeWorkspaceId);
    const chatTab = tabs.find((t) => t.type === "chat");
    if (chatTab) {
      setActiveTabId(chatTab.id);
      setView("chat");
    }
  }, [activeWorkspaceId, tabsPerWorkspace, ensureTabs, setView]);

  const openChanges = useCallback(() => {
    setView("changes");
    setShowCreator(false);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Command+T → open terminal (if in project)
      if (mod && !e.shiftKey && e.key === "t") {
        e.preventDefault();
        if (project && activeWorkspaceId) {
          openTerminal();
        }
      }

      // Command+Shift+C → open chat
      if (mod && e.shiftKey && (e.key === "C" || e.key === "c")) {
        e.preventDefault();
        if (project && activeWorkspaceId) {
          openChat();
        }
      }

      // Command+Shift+G → open changes
      if (mod && e.shiftKey && (e.key === "G" || e.key === "g")) {
        e.preventDefault();
        if (project) {
          openChanges();
        }
      }

      // Command+N → show workspace creator
      if (mod && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        if (project) {
          setShowCreator(true);
        }
      }

      // Command+K → command palette
      if (mod && !e.shiftKey && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }

      // Command+\ → toggle sidebar
      if (mod && e.key === "\\") {
        e.preventDefault();
        setShowSidebar((v) => !v);
        bumpLayout();
      }

      // Command+Shift+T → toggle token dashboard
      if (mod && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        setShowTokens((v) => !v);
        bumpLayout();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project, activeWorkspaceId, openTerminal, openChat, openChanges, bumpLayout]);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  // Current workspace tabs
  const currentTabs = activeWorkspaceId ? (tabsPerWorkspace[activeWorkspaceId] || ensureTabs(activeWorkspaceId)) : [];

  // Delete workspace handler
  const handleDeleteWorkspace = useCallback(async () => {
    if (!activeWorkspace || !project) return;
    const ok = window.confirm(
      `Delete workspace "${activeWorkspace.name}" (${activeWorkspace.branch})?\n\nThis will delete the branch and worktree. Cannot be undone.`
    );
    if (!ok) return;
    const { remove, workspaces: wsList, select } = useWorkspaceStore.getState();
    await remove(activeWorkspace.id, project.path, activeWorkspace.branch, activeWorkspace.worktreePath ?? null);
    // Select next workspace if available
    const remaining = wsList.filter((w) => w.id !== activeWorkspace.id);
    if (remaining.length > 0) {
      select(remaining[0].id);
    } else {
      setShowCreator(true);
    }
  }, [activeWorkspace, project]);

  // Full-screen views (no sidebar)
  if (!project) {
    if (view === "new-project") {
      return (
        <div className="flex h-screen w-screen bg-octo-bg text-zinc-100">
          <NewProjectFlow onBack={() => setView("welcome")} />
          <ToastContainer />
        </div>
      );
    }

    return (
      <div className="flex h-screen w-screen bg-octo-bg text-zinc-100">
        <WelcomeScreen onNewProject={() => setView("new-project")} />
        <ToastContainer />
      </div>
    );
  }

  // Project is open — sidebar + main content layout
  function renderMainContent() {
    if (showCreator && project) {
      return (
        <WorkspaceCreator
          projectId={project.id}
          projectPath={project.path}
          onCreated={() => {
            setShowCreator(false);
            setView("chat");
          }}
          onCancel={() => setShowCreator(false)}
        />
      );
    }

    if (!activeWorkspace) {
      // No workspaces yet — prompt to create one
      return (
        <WorkspaceCreator
          projectId={project!.id}
          projectPath={project!.path}
          onCreated={() => {
            setShowCreator(false);
            setView("chat");
          }}
          onCancel={() => setShowCreator(false)}
        />
      );
    }

    switch (view) {
      case "terminal": {
        // Check if the active terminal tab has a session yet
        const termTab = currentTabs.find((t) => t.id === activeTabId && t.type === "terminal");
        if (termTab && !termTab.sessionId) {
          return (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              Starting terminal...
            </div>
          );
        }
        // Terminal is rendered persistently below, this returns null so the persistent div shows through
        return null;
      }

      case "chat": {
        const chatTab = currentTabs.find((t) => t.id === activeTabId && t.type === "chat");
        if (chatTab?.conversationId) {
          return (
            <ChatView
              workspaceId={chatTab.conversationId}
              workspacePath={activeWorkspace?.worktreePath || project?.path || ""}
              onOpenSettings={() => setShowSettings(true)}
            />
          );
        }
        return (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Select a workspace to start chatting
          </div>
        );
      }

      case "changes":
        if (project) {
          return <ChangesPanel projectPath={project.path} />;
        }
        return null;

      default:
        return null;
    }
  }

  return (
    <div className="flex h-screen w-screen bg-octo-bg text-zinc-100">
      {showSidebar && (
        <ProjectSidebar
          onNewWorkspace={() => setShowCreator(true)}
        />
      )}

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {activeWorkspace && (
          <WorkspaceBar
            tabs={currentTabs}
            activeTabId={activeTabId}
            activeView={view}
            onSelectTab={selectTab}
            onAddChat={addChatTab}
            onAddTerminal={addTerminalTab}
            onCloseTab={closeTab}
            onViewChange={(v) => {
              setView(v);
              setShowCreator(false);
              // When switching category, select the active tab within that category
              if (v !== "changes" && activeWorkspaceId) {
                const tabs = tabsPerWorkspace[activeWorkspaceId] || [];
                const currentActive = tabs.find(t => t.id === activeTabId);
                if (!currentActive || currentActive.type !== v) {
                  const firstOfType = tabs.find(t => t.type === v);
                  if (firstOfType) setActiveTabId(firstOfType.id);
                }
              }
            }}
            onDeleteWorkspace={handleDeleteWorkspace}
            workspaceName={activeWorkspace.name}
            branch={activeWorkspace.branch}
          />
        )}

        <div className="relative flex min-w-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            {renderMainContent()}

            {/* Terminal tabs — always rendered for persistence, shown/hidden via CSS */}
            {currentTabs
              .filter((t) => t.type === "terminal" && t.sessionId)
              .map((tab) => (
                <div
                  key={tab.id}
                  style={{
                    display: activeTabId === tab.id && view === "terminal" ? "block" : "none",
                    width: "100%",
                    height: "100%",
                  }}
                >
                  <TerminalPane
                    sessionId={tab.sessionId!}
                    visible={activeTabId === tab.id && view === "terminal"}
                    layoutVersion={layoutVersion}
                  />
                </div>
              ))}
          </div>

          {showTokens && <TokenDashboard />}
        </div>
      </main>

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        onNewSession={() => {
          setShowPalette(false);
          setShowCreator(true);
        }}
        onToggleTokens={() => setShowTokens((v) => !v)}
      />

      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
      />

      <ToastContainer />
    </div>
  );
}

export default App;
