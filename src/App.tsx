import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { NewProjectFlow } from "./components/NewProjectFlow";
import { WorkspaceRail } from "./components/WorkspaceRail";
import { PerfMonitorBar } from "./components/PerfMonitorBar";
import { AppTopBar } from "./components/AppTopBar";
import { useScratchpadStore } from "./stores/scratchpadStore";
import { usePerfStore } from "./stores/perfStore";
import { ContextHeader } from "./components/ContextHeader";
import { Companion } from "./components/Companion";
import { WorkspaceCustomizeMenu } from "./components/WorkspaceCustomizeMenu";
import { MissionCreator } from "./components/MissionCreator";
import { WorkspaceContextMenu } from "./components/WorkspaceContextMenu";
import { RenameDialog } from "./components/RenameDialog";
import { ProjectContextMenu } from "./components/ProjectContextMenu";
import { ProjectCustomizeMenu } from "./components/ProjectCustomizeMenu";
import { ArchivedWorkspacesModal } from "./components/ArchivedWorkspacesModal";
import { ModalShell } from "./components/ModalShell";
import { JiraTicketPickerModal } from "./components/JiraTicketPickerModal";
import { JiraProjectKeyModal } from "./components/JiraProjectKeyModal";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { formatBytes } from "./lib/formatBytes";
import { BacklogRowContextMenu } from "./components/BacklogRowContextMenu";
import { ProjectPickerModal } from "./components/ProjectPickerModal";
import { ExistingWorkspaceAlertModal } from "./components/ExistingWorkspaceAlertModal";
import { EmptyProjectState } from "./components/EmptyProjectState";
import { ChatView } from "./components/ChatView";
import { ReviewSidebar } from "./components/ReviewSidebar";
import { EditorWithPreview } from "./components/editor/EditorWithPreview";
import { EditorTabs } from "./components/EditorTabs";
import { ReviewCanvas, type ReviewViewMode } from "./components/ReviewCanvas";
import { DirectCanvas } from "./components/DirectCanvas";
import { ModeOverlay } from "./components/ModeOverlay";
import { useReviewPrefs } from "./stores/reviewPrefsStore";
import { useWorkspacePrefs } from "./stores/workspacePrefsStore";
import { CanvasSplit } from "./components/CanvasSplit";
import { useEditorStore } from "./stores/editorStore";
import { useAttentionStore } from "./stores/attentionStore";
import { focus as focusGlobal } from "./lib/focus";
import { TerminalPane } from "./components/TerminalPane";
import { CommandPalette } from "./components/CommandPalette";
import { WorkspaceSearchPalette } from "./components/WorkspaceSearchPalette";
import { ToastContainer, pushToast } from "./components/Toasts";
import { UpgradeSheet } from "./components/UpgradeSheet";
import { HistorySheet } from "./components/HistorySheet";
import { MissionControl } from "./components/MissionControl";
import { LogbookRoom } from "./components/LogbookRoom";
import { FirstRunInvite } from "./components/FirstRunInvite";
import { useFirstRunStore, crewProviderReady } from "./stores/firstRunStore";
import { initCrewNotifications } from "./lib/crewNotifications";
import { useHistoryStore } from "./stores/historyStore";
import { useEntitlementStore } from "./stores/entitlementStore";
import { UpdateNotifier } from "./components/UpdateNotifier";
import { Settings } from "./components/Settings";
import { useProjectStore } from "./stores/projectStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useMissionsStore } from "./stores/missionsStore";
import { useThemeStore } from "./stores/themeStore";
import { useTokenStore } from "./stores/tokenStore";
import { useTerminalsStore } from "./stores/terminalsStore";
import { useChatStore } from "./stores/chatStore";
import { useRunsStore } from "./stores/runsStore";
import { usePipelineStore } from "./stores/pipelineStore";
import { useRolesStore } from "./stores/rolesStore";
import { useShallow } from "zustand/react/shallow";
import { hasActiveDirectRun } from "./lib/runningWorkspaces";
import { useBudgetsStore } from "./stores/budgetsStore";
import type { ProjectGroup } from "./components/WorkspaceRail";
import { listen } from "@tauri-apps/api/event";
import { deriveChatTitle, deriveChatMeta, formatRelTime } from "./lib/chatTitle";
import type { ModelWithProvider } from "./lib/types";
import type { SettingsTab } from "./lib/settingsTabs";
import { resolveMonogram } from "./lib/monogram";
import { type WorkspaceMode } from "./lib/modes";
import { ipc } from "./lib/ipc";
import { copyToClipboard } from "./lib/clipboard";
import { conversationToMarkdown } from "./lib/exportConversation";
import type { GitStatus, Pr, TintName, Issue, ProjectInfo } from "./lib/types";
import { useIssuesStore } from "./stores/issuesStore";
import { detectIssueKey, detectIssueKeyForProject } from "./lib/detectIssueKey";
import { revealDiffTarget, stripDiffPrefix } from "./lib/diffJump";


type AppView = "project" | "new-project";

// Workspace ids whose terminal hydration is currently in flight. Guards the
// "auto-create Main when empty" branch against double-creation: StrictMode's
// double-effect (and fast A→B→A switches) can resolve two loadTerminals()
// calls that BOTH see an empty list and both create. Module-level so the
// guard survives remounts of <App>.
const terminalInitInFlight = new Set<string>();

function App() {
  const project = useProjectStore((s) => s.current);
  const loadTheme = useThemeStore((s) => s.load);
  const refreshTokens = useTokenStore((s) => s.refresh);
  // Narrow per-field selectors (codebase norm) — a bare `useStore()` call
  // subscribes App to EVERY store change and re-renders the whole shell.
  const loadBudgets = useBudgetsStore((s) => s.loadAll);
  const refreshAllSpend = useBudgetsStore((s) => s.refreshAllSpend);
  const budgets = useBudgetsStore((s) => s.budgets);
  const spend = useBudgetsStore((s) => s.spend);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeId);
  const loadWorkspaces = useWorkspaceStore((s) => s.load);
  const loadAllWorkspaces = useWorkspaceStore((s) => s.loadAllWorkspaces);
  const updateCustomization = useWorkspaceStore((s) => s.updateCustomization);
  const selectWorkspace = useWorkspaceStore((s) => s.select);
  const rememberActiveForProject = useWorkspaceStore((s) => s.rememberActiveForProject);
  const healActiveForProject = useWorkspaceStore((s) => s.healActiveForProject);
  const removeWorkspace = useWorkspaceStore((s) => s.remove);
  const workspacesByProjectId = useWorkspaceStore((s) => s.workspacesByProjectId);
  const lastActiveByProject = useWorkspaceStore((s) => s.lastActiveByProject);
  const pruneProject = useWorkspaceStore((s) => s.pruneProject);
  const gitSummaryByWs = useWorkspaceStore((s) => s.gitSummaryByWs);
  const loadGitSummaries = useWorkspaceStore((s) => s.loadGitSummaries);
  const prByWs = useWorkspaceStore((s) => s.prByWs);
  const loadProjectPrs = useWorkspaceStore((s) => s.loadProjectPrs);
  // The active mission's intent, derived from the active workspace (missions are
  // 1:1 with code workspaces). Drives the ContextHeader intent chip.
  const activeMissionIntent = useMissionsStore((s) =>
    activeWorkspaceId ? s.missionByWorkspaceId[activeWorkspaceId]?.intent ?? null : null,
  );
  // Drives the ContextHeader sandbox (Shield) glyph.
  const activeMissionExecIsolation = useMissionsStore((s) =>
    activeWorkspaceId ? s.missionByWorkspaceId[activeWorkspaceId]?.execIsolation ?? null : null,
  );

  // Per-workspace "actively processing" signal for the rail's marching bar.
  // Each selector derives the SET of workspaces with live activity and is
  // shallow-compared, so a DIRECT run's frequent cost ticks (which mutate
  // runsByWs) don't re-render the shell unless the running set actually changes.
  //
  // RUN/terminal uses `TerminalState.busy` — the daemon's foreground signal
  // ("a non-shell command owns the PTY"), NOT `running` (= shell session alive,
  // which would mark the bar forever for any open terminal).
  const chatRunningIds = useChatStore(
    useShallow((s) => Object.keys(s.streamingByWs).filter((id) => s.streamingByWs[id])),
  );
  const directRunningIds = useRunsStore(
    useShallow((s) => Object.keys(s.runsByWs).filter((id) => hasActiveDirectRun(s.runsByWs[id]))),
  );
  const loadActiveRuns = useRunsStore((s) => s.loadActiveRuns);
  // Hydrate the global runs tray on launch — surfaces background (running/paused)
  // runs in workspaces not opened this session. Live events keep it fresh after.
  useEffect(() => {
    void loadActiveRuns();
    // One-shot first-run invite eligibility (all-time backend count; the
    // persisted dismissed flag short-circuits inside the store).
    void useFirstRunStore.getState().checkEligibility();
    // Crew notifications — a native ping when a crew gates/finishes while
    // the window is unfocused (the fleet's unattended-operation contract).
    initCrewNotifications();
  }, [loadActiveRuns]);

  // Cross-machine run history (Pro-real Part B / B1): once the user is Pro with
  // `history.sync`, backfill this machine's runs + pull the full history so the
  // History sheet opens populated. Runs when the entitlement flips to granted
  // (on load, or right after an upgrade). Best-effort/silent for everyone else.
  const historySyncEntitled = useEntitlementStore((s) =>
    s.entitlement.features.includes("history.sync"),
  );
  useEffect(() => {
    if (historySyncEntitled) void useHistoryStore.getState().syncOnLaunch();
  }, [historySyncEntitled]);

  // Library sync (Pro): once entitled, heal-push the whole custom library,
  // pull + merge the other machines' edits (per-item LWW), and refresh the
  // stores that render it. Best-effort and silent — offline just means the
  // library syncs on a later launch.
  const librarySyncEntitled = useEntitlementStore((s) =>
    s.entitlement.features.includes("library.sync"),
  );
  useEffect(() => {
    if (!librarySyncEntitled) return;
    void (async () => {
      try {
        await ipc.librarySyncPushAll();
        const applied = await ipc.librarySyncPull();
        if (applied > 0) {
          await usePipelineStore.getState().load();
          await useRolesStore.getState().load();
        }
      } catch {
        // Offline / transient — the local library is untouched.
      }
    })();
  }, [librarySyncEntitled]);
  const terminalBusyIds = useTerminalsStore(
    useShallow((s) =>
      Object.keys(s.terminalsByWs).filter((id) => (s.terminalsByWs[id] ?? []).some((t) => t.busy)),
    ),
  );
  // Workspaces with a live `$`-direct process (promoted long command) — these
  // clear streamingByWs the moment they promote, so the rail would otherwise
  // show idle while a dev server / build streams in the pinned terminal.
  const shellLiveIds = useChatStore(
    useShallow((s) => [...new Set(Object.values(s.liveProcessByThread).map((p) => p.workspaceId))]),
  );
  const runningByWs = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const id of chatRunningIds) out[id] = true;
    for (const id of directRunningIds) out[id] = true;
    for (const id of terminalBusyIds) out[id] = true;
    for (const id of shellLiveIds) out[id] = true;
    return out;
  }, [chatRunningIds, directRunningIds, terminalBusyIds, shellLiveIds]);

  const [appView, setAppView] = useState<AppView>("project");

  // Per-workspace state — modes. (Conversation threads now live in chatStore:
  // threadsByWs / activeThreadByWs, persisted in the DB via real chat_threads.)
  const [modePerWorkspace, setModePerWorkspace] = useState<Record<string, WorkspaceMode>>({});

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
  const closedProjects = useProjectStore((s) => s.closed);
  const loadClosedProjects = useProjectStore((s) => s.loadClosed);
  const closeProjectAction = useProjectStore((s) => s.closeProject);
  const reopenProjectAction = useProjectStore((s) => s.reopenProject);
  const setProjectPinnedAction = useProjectStore((s) => s.setPinned);
  const setProjectOrderAction = useProjectStore((s) => s.setOrder);
  const openProject = useProjectStore((s) => s.open);
  const getLastOpenedPath = useProjectStore((s) => s.getLastOpenedPath);
  const saveLastOpenedPath = useProjectStore((s) => s.saveLastOpenedPath);

  // Helper to find a project by ID
  const getProjectById = useCallback((projectId: string) => {
    if (project?.id === projectId) return project;
    return recentProjects.find(p => p.id === projectId) ?? null;
  }, [project, recentProjects]);

  // ── Companion resize ─────────────────────────────────────────────
  // The Companion's width persists in localStorage so a workspace's
  // back-and-forth Talk → Run keeps the user's chosen width. Min/max
  // bounds keep the layout sane: < 280 starves the active-ticket meta
  // line; > 600 starves the canvas.
  const COMPANION_DEFAULT_WIDTH = 312;
  const COMPANION_MIN_WIDTH = 280;
  const COMPANION_MAX_WIDTH = 600;
  // Collapsed, the companion shrinks to a slim strip (like the rail) that
  // still carries the mode switcher — trading panel content for canvas room.
  const COMPANION_COLLAPSED_WIDTH = 56;
  const [isCompanionCollapsed, setIsCompanionCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("companionCollapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("companionCollapsed", isCompanionCollapsed ? "1" : "0");
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }, [isCompanionCollapsed]);
  const [companionWidth, setCompanionWidth] = useState<number>(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("companionWidth") : null;
    const parsed = stored ? parseInt(stored, 10) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.max(COMPANION_MIN_WIDTH, Math.min(COMPANION_MAX_WIDTH, parsed));
    }
    return COMPANION_DEFAULT_WIDTH;
  });
  const [companionResizing, setCompanionResizing] = useState(false);
  useEffect(() => {
    localStorage.setItem("companionWidth", String(companionWidth));
  }, [companionWidth]);
  function startCompanionResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = companionWidth;
    setCompanionResizing(true);
    const onMove = (ev: MouseEvent) => {
      // Companion is on the right; moving the cursor LEFT widens it.
      const dx = startX - ev.clientX;
      const next = Math.max(
        COMPANION_MIN_WIDTH,
        Math.min(COMPANION_MAX_WIDTH, startWidth + dx),
      );
      setCompanionWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setCompanionResizing(false);
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  function resetCompanionWidth() {
    setCompanionWidth(COMPANION_DEFAULT_WIDTH);
  }

  // Scratchpad toggle exposed to AppTopBar (and any future top-level call site).
  const toggleScratchpad = useScratchpadStore((s) => s.toggleOpen);

  // Workspace rail collapsed state. State is owned here so the collapse
  // toggle can live in the footer (PerfMonitorBar) while still driving the
  // rail's width — see WorkspaceRail.isCollapsed and PerfMonitorBar.onToggleRail.
  const [isRailCollapsed, setIsRailCollapsed] = useState(false);

  // Overlay/menu state
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [missionControlOpen, setMissionControlOpen] = useState(false);
  const [logbookOpen, setLogbookOpen] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchMode, setSearchMode] = useState<"files" | "text">("files");
  const [showCreator, setShowCreator] = useState(false);
  const [creatorProjectId, setCreatorProjectId] = useState<string | null>(null);
  const [customizingWorkspaceId, setCustomizingWorkspaceId] = useState<string | null>(null);
  const [renamingWorkspace, setRenamingWorkspace] = useState<{ id: string; name: string } | null>(null);
  // When the user opens NewProjectFlow from the switcher (not from the welcome
  // screen), we render it as an overlay on top of the current project — the
  // !project early-return path doesn't fire and the create/clone form needs to
  // live somewhere else.
  const [showAddProject, setShowAddProject] = useState(false);
  // Context menu: which workspace and where
  const [contextMenu, setContextMenu] = useState<{ workspaceId: string; x: number; y: number } | null>(null);
  // Jira ticket picker modal (from workspace context menu)
  const [jiraTicketPickerOpen, setJiraTicketPickerOpen] = useState<{ workspaceId: string; mode: "link" | "change" } | null>(null);
  // Jira project key editor modal (from project context menu)
  const [jiraProjectKeyEditorOpen, setJiraProjectKeyEditorOpen] = useState<{ projectId: string } | null>(null);
  // Pending delete confirmation
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  // Inline workspace creator shown from the empty-project state.
  const [showInlineCreator, setShowInlineCreator] = useState(false);
  // Project customization state
  const [showProjectCustomizer, setShowProjectCustomizer] = useState(false);
  const [customizingProjectId, setCustomizingProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [archivedForProject, setArchivedForProject] = useState<{ id: string; name: string; path: string } | null>(null);
  // Counter to trigger re-renders when project customizations change
  const [projectCustomizationsVersion, setProjectCustomizationsVersion] = useState(0);

  // ── Backlog ticket → create workspace orchestration ──
  const [backlogTicketMenu, setBacklogTicketMenu] = useState<{ issue: Issue; x: number; y: number } | null>(null);
  const [existingWsAlert, setExistingWsAlert] = useState<{ ticketKey: string; summary: string; existingName: string } | null>(null);
  const [projectPickerForTicket, setProjectPickerForTicket] = useState<{ ticketKey: string; summary: string; candidates: ProjectInfo[] } | null>(null);
  const [creatorForTicket, setCreatorForTicket] = useState<{ projectId: string; projectPath: string; initialTask: string; linkIssueKeyOnCreate: string } | null>(null);

  // Git status + diff (refreshed on workspace change)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitDiff, setGitDiff] = useState<string>("");
  // Per-workspace cache of the most recently fetched open PR (or null when
  // there isn't one). Keyed by workspace id so switching back to a
  // workspace doesn't flicker until the next refresh.
  const [openPrByWs, setOpenPrByWs] = useState<Record<string, Pr | null>>({});

  // Layout version (forces TerminalPane fit-resize when sidebar/companion toggle)
  const layoutVersionRef = useRef(0);
  const gitSigRef = useRef<string>("");
  const gitDiffRef = useRef<string>("");
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

  // ── Load budgets on startup ──
  useEffect(() => {
    loadBudgets();
  }, [loadBudgets]);

  // ── Startup: load recent projects and restore last opened project ──
  const startupFiredRef = useRef(false);
  useEffect(() => {
    if (startupFiredRef.current) return;
    startupFiredRef.current = true;

    (async () => {
      await loadRecentProjects();
      void loadClosedProjects();
      // Check if we have projects stored and no current project
      const state = useProjectStore.getState();
      if (!state.current && state.recent.length > 0) {
        // Try to restore last opened project
        const lastPath = getLastOpenedPath();
        if (lastPath) {
          try {
            await openProject(lastPath);
          } catch {
            // If last project can't be opened, leave the welcome screen
          }
        }
      }
    })();
  }, [loadRecentProjects, loadClosedProjects, openProject, getLastOpenedPath]);

  // One-time migration of legacy localStorage.projectCustomizations into the
  // backend, so renames/tints survive a localStorage clear. Idempotent and
  // guarded by a persisted flag.
  const customizationsMigratedRef = useRef(false);
  useEffect(() => {
    if (customizationsMigratedRef.current) return;
    customizationsMigratedRef.current = true;
    if (localStorage.getItem("projectCustomizationsMigrated") === "1") return;
    (async () => {
      try {
        const customizations = JSON.parse(localStorage.getItem("projectCustomizations") || "{}");
        const entries = Object.entries(customizations) as Array<[string, { name?: string; tint?: string }]>;
        for (const [id, c] of entries) {
          if (c && (c.name || c.tint)) {
            await ipc.updateProjectCustomization(id, c.name ?? null, c.tint ?? null);
          }
        }
        localStorage.setItem("projectCustomizationsMigrated", "1");
        if (entries.length > 0) await loadRecentProjects();
      } catch {
        /* non-critical */
      }
    })();
  }, [loadRecentProjects]);

  // Performance monitor polling — runs for the whole app lifetime.
  useEffect(() => {
    usePerfStore.getState().start();
    return () => usePerfStore.getState().stop();
  }, []);

  // Refresh token usage periodically so the Companion + Settings · Usage
  // stay current. 30s is enough for a workspace-level glance.
  useEffect(() => {
    refreshTokens();
    const id = setInterval(refreshTokens, 30_000);
    return () => clearInterval(id);
  }, [refreshTokens]);

  // Refresh tokens + budget spend immediately when a chat turn finishes.
  useEffect(() => {
    const unlistenPromise = listen<{ done: boolean }>("chat://stream", async (ev) => {
      if (ev.payload.done) {
        refreshTokens();
        await refreshAllSpend();
        // Check threshold crossings after refreshing spend
        const state = useBudgetsStore.getState();
        for (const b of state.budgets) {
          const key = `${b.scopeType}:${b.scopeId}:${b.period}`;
          const snap = state.spend[key];
          if (!snap || b.limitUsd <= 0) continue;
          const pct = (snap.costUsd / b.limitUsd) * 100;
          const scopeLabel = b.scopeType === "global"
            ? "global"
            : b.scopeType === "project"
            ? `project`
            : `workspace`;

          for (const threshold of [50, 80, 100] as const) {
            if (pct >= threshold) {
              const tKey = `${key}:${threshold}`;
              if (!state.notifiedThresholds.has(tKey)) {
                useBudgetsStore.setState((s) => ({
                  notifiedThresholds: new Set([...s.notifiedThresholds, tKey]),
                }));
                if (threshold === 100) {
                  pushToast({
                    level: "error",
                    title: `Budget cap hit — Send blocked`,
                    body: `${scopeLabel} ${b.period} budget: $${snap.costUsd.toFixed(2)} / $${b.limitUsd.toFixed(2)}`,
                  });
                } else if (threshold === 80) {
                  pushToast({
                    level: "warning",
                    title: `80% of ${scopeLabel} budget used`,
                    body: `${b.period}: $${snap.costUsd.toFixed(2)} / $${b.limitUsd.toFixed(2)}`,
                  });
                } else {
                  pushToast({
                    level: "info",
                    title: `50% of ${scopeLabel} budget used`,
                    body: `${b.period}: $${snap.costUsd.toFixed(2)} / $${b.limitUsd.toFixed(2)}`,
                  });
                }
              }
            }
          }
        }
      }
    });
    return () => {
      unlistenPromise.then((u) => u());
    };
  }, [refreshTokens, refreshAllSpend]);

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
      // Refresh the recent-projects list so a freshly created/opened project is
      // present in the rail's stable (creation-ordered) list, not only via the
      // active-project fallback.
      loadRecentProjects();
      // Persist this project as last opened
      saveLastOpenedPath(project.path);
    } else {
      setShowCreator(false);
    }
  }, [project, loadWorkspaces, loadRecentProjects, saveLastOpenedPath]);

  // ── Load all workspaces from all projects for the rail ──
  useEffect(() => {
    if (!project || recentProjects.length === 0) return;

    const projectIds = new Set<string>();
    projectIds.add(project.id);
    recentProjects.forEach((p) => projectIds.add(p.id));

    const ids = Array.from(projectIds);
    loadAllWorkspaces(ids);
    void useMissionsStore.getState().loadAll(ids);
    const pathById = new Map<string, string>();
    recentProjects.forEach((p) => pathById.set(p.id, p.path));
    if (project) pathById.set(project.id, project.path);
    ids.forEach((id) => {
      void loadGitSummaries(id);
      const p = pathById.get(id);
      if (p) void loadProjectPrs(id, p);
    });
  }, [project, recentProjects, loadAllWorkspaces, loadGitSummaries, loadProjectPrs]);

  // Refresh externally-authored data when the window regains focus — calm,
  // event-driven (no polling). octopush-mcp is a separate process writing to
  // the same SQLite store; it cannot emit Tauri events, so anything it authors
  // while you're in another app (workspaces via `create_workspace`, pipelines
  // via `create_pipeline`, draft runs via `create_run`) would otherwise sit
  // invisible behind session-cached lists until a full reload. Each refetch is
  // a background replace that never clobbers UI state: the launcher repairs
  // its own selection against the new list, and run rows are keyed by id.
  useEffect(() => {
    const onFocus = () => {
      const byId = new Map<string, string>();
      if (project) byId.set(project.id, project.path);
      recentProjects.forEach((p) => byId.set(p.id, p.path));
      void loadAllWorkspaces([...byId.keys()]);
      void useMissionsStore.getState().loadAll([...byId.keys()]);
      byId.forEach((path, id) => {
        void loadGitSummaries(id);
        void loadProjectPrs(id, path);
      });
      // Pipelines (the ensemble picker) + the active workspace's runs list —
      // both read via getState at fire time, so the listener neither
      // re-registers per workspace switch nor closes over stale state. The
      // background flag keeps the refetch passive: the runs list refreshes,
      // but the viewed canvas is never reassigned under the user.
      void usePipelineStore.getState().load();
      const wsId = useWorkspaceStore.getState().activeId;
      if (wsId) void useRunsStore.getState().loadRuns(wsId, { background: true });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [project, recentProjects, loadAllWorkspaces, loadGitSummaries, loadProjectPrs]);

  // ── Initialize per-workspace state when a new workspace becomes active ──
  useEffect(() => {
    if (!activeWorkspaceId) return;
    // Chat threads are hydrated lazily by the Talk canvas (chatStore.loadHistory
    // ensures a default thread exists), so no seeding is needed here.
    // Hydrate terminals from DB; auto-create "Main" if the workspace is empty.
    // The in-flight guard prevents two concurrent resolutions from both seeing
    // an empty list and creating duplicate "Main" terminals.
    if (terminalInitInFlight.has(activeWorkspaceId)) return;
    terminalInitInFlight.add(activeWorkspaceId);
    loadTerminals(activeWorkspaceId)
      .then(() => {
        const list = useTerminalsStore.getState().getTerminals(activeWorkspaceId);
        if (list.length === 0) {
          // Return the promise so the guard stays held until creation lands.
          return createTerminal(activeWorkspaceId, "Main");
        }
      })
      .catch(console.error)
      .finally(() => terminalInitInFlight.delete(activeWorkspaceId));
  }, [activeWorkspaceId, loadTerminals, createTerminal]);

  // ── Refresh git status + diff on workspace change AND on a 3s interval ──
  // The interval is necessary because the agentic loop in Talk mode can mutate
  // files in the worktree without any UI event we can hook into. Without
  // polling, the Review panel would show stale "Nothing to review" until the
  // user toggled workspaces. 3s is the sweet spot — fast enough to feel live,
  // not so often that we hammer git on huge repos.
  // ── Mode helpers ──
  // The fallback for a workspace with no explicit mode this session is the
  // user-configured default (Settings → General → Workspace defaults), not a
  // hardcoded "talk". Applies to freshly created workspaces and any workspace
  // after an app restart, since mode isn't persisted per-workspace.
  const defaultMode = useWorkspacePrefs((s) => s.defaultMode);
  const activeMode: WorkspaceMode =
    (activeWorkspaceId && modePerWorkspace[activeWorkspaceId]) || defaultMode;

  // Review whitespace pref — when it flips, the review diff is re-fetched
  // (the effect below depends on it) so the canvas honours the toggle.
  const ignoreWs = useReviewPrefs((s) => s.ignoreWhitespace);

  // Reset the git snapshot the moment the workspace identity changes — the
  // refresh below is async, and without this the review surfaces (and the AI
  // review panel) would keep running against the PREVIOUS workspace's diff
  // while the new fetch is in flight. Keyed on the id only, so mode/pref
  // changes within a workspace don't blank the canvas.
  useEffect(() => {
    setGitStatus(null);
    setGitDiff("");
    gitSigRef.current = "";
    gitDiffRef.current = "";
  }, [activeWorkspaceId]);

  useEffect(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    const path = ws?.worktreePath ?? project?.path;
    if (!path) {
      setGitStatus(null);
      setGitDiff("");
      gitSigRef.current = "";
      gitDiffRef.current = "";
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        // The diff is only consumed by the review panel (ChangesPanel /
        // ReviewCanvas / EditorPane), which is hidden outside review mode, so
        // skip the (non-trivial) diff build in talk/run. Entering review
        // re-runs this effect (activeMode is a dep), fetching the diff then.
        const needDiff = activeMode === "review";
        const [s, d] = await Promise.all([
          ipc.getGitStatus(path),
          needDiff ? ipc.getGitDiff(path, ignoreWs).catch(() => "") : Promise.resolve(""),
        ]);
        if (cancelled) return;
        // Status change-detection (file metadata). hasUpstream is intentionally
        // omitted — no App-level gitStatus consumer reads it (ChangesPanel keeps
        // its own git status). The diff is compared separately, by content.
        const sig =
          `${s?.branch ?? ""}|${s?.ahead ?? 0}|${s?.behind ?? 0}|` +
          `${(s?.changedFiles ?? []).map((f) => `${f.path}:${f.status}:${f.staged ? 1 : 0}:${f.unstaged ? 1 : 0}`).join(",")}`;
        if (sig !== gitSigRef.current) {
          gitSigRef.current = sig;
          setGitStatus(s);
        }
        if (d !== gitDiffRef.current) {
          gitDiffRef.current = d;
          setGitDiff(d);
        }
      } catch {
        /* non-fatal */
      }
    };
    refresh(); // immediate on workspace/mode change
    // Live polling only where file changes matter (run/review); talk mode
    // refreshes on window focus instead of a tight interval.
    // Skip ticks while the window is hidden — no one is looking, and the
    // focus listener below catches up the moment the user returns.
    const id =
      activeMode !== "talk" && activeMode !== "direct"
        ? setInterval(() => {
            if (document.visibilityState !== "visible") return;
            void refresh();
          }, 3_000)
        : undefined;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeWorkspaceId, workspaces, project, activeMode, ignoreWs]);

  // ── Open-PR fetch ──
  // Fetch once per workspace switch and then every 60s. GitHub's
  // unauthenticated rate limit is 60 req/hr per IP, so a faster cadence
  // would exhaust it within a few workspace switches.
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return;
    const path = ws.worktreePath ?? project?.path;
    if (!path) return;
    let cancelled = false;
    const fetchPr = () => {
      ipc
        .findPrForBranch(path)
        .then((pr) => {
          if (!cancelled) {
            setOpenPrByWs((prev) => ({ ...prev, [ws.id]: pr }));
          }
        })
        .catch(() => {
          // Network / auth errors are non-fatal — just leave the chip hidden.
        });
    };
    fetchPr();
    const id = setInterval(fetchPr, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeWorkspaceId, workspaces, project]);

  // ── Focus → background stores ──
  // Mirror the active workspace + mode into the module-level `focus`
  // object so chatStore / TerminalPane can decide whether to fire an
  // attention chime (skip if user is already looking at it).
  //
  // We only CLEAR the workspace's attention flag when the user is on
  // the mode that actually matches the alert. If a terminal in
  // workspace A pings while the user is in A's Talk mode, the Run
  // tab pulses; clearing the flag on workspace-switch would wipe
  // that signal before the user can act on it. Once they switch to
  // Run mode the flag clears.
  useEffect(() => {
    focusGlobal.workspaceId = activeWorkspaceId ?? null;
    focusGlobal.mode = activeMode;
    if (!activeWorkspaceId) return;
    const flag = useAttentionStore.getState().flagsByWs[activeWorkspaceId];
    if (!flag) return;
    const matchingMode = flag.kind === "chat" ? "talk" : "run";
    if (activeMode === matchingMode) {
      useAttentionStore.getState().clear(activeWorkspaceId);
    }
  }, [activeWorkspaceId, activeMode]);

  const setMode = useCallback(
    (next: WorkspaceMode) => {
      if (!activeWorkspaceId) return;
      setModePerWorkspace((p) => ({ ...p, [activeWorkspaceId]: next }));
    },
    [activeWorkspaceId],
  );

  // Cross-mode action (P9): take a chat tool's shell command to RUN mode.
  // Switches to the terminal and copies the command to the clipboard so the
  // user pastes + reviews + presses Enter — deliberately a hand-off, not an
  // auto-run: it never injects into a not-yet-spawned PTY (which would silently
  // drop the text) and never auto-executes a multi-line command.
  const handleRunInTerminal = useCallback(
    (command: string) => {
      if (!activeWorkspaceId) return;
      setMode("run");
      void copyToClipboard(command, "Command copied — paste into the terminal to run");
    },
    [activeWorkspaceId, setMode],
  );

  // ── Chat / terminal handlers wired to Companion ──
  // Conversation-thread handlers delegate to chatStore, which persists threads
  // in the DB (real multi-conversation per workspace) and keeps the active
  // thread's messages loaded.
  const handleNewChat = useCallback(() => {
    if (!activeWorkspaceId) return;
    void useChatStore.getState().newThread(activeWorkspaceId).catch(console.error);
  }, [activeWorkspaceId]);

  const handleSelectChat = useCallback(
    (id: string) => {
      if (!activeWorkspaceId) return;
      void useChatStore.getState().selectThread(activeWorkspaceId, id).catch(console.error);
    },
    [activeWorkspaceId],
  );

  const handleDeleteChat = useCallback(
    (id: string) => {
      if (!activeWorkspaceId) return;
      void useChatStore.getState().deleteThread(activeWorkspaceId, id).catch(console.error);
    },
    [activeWorkspaceId],
  );

  const handleRenameChat = useCallback(
    (id: string, title: string) => {
      if (!activeWorkspaceId) return;
      void useChatStore.getState().renameThread(activeWorkspaceId, id, title).catch(console.error);
    },
    [activeWorkspaceId],
  );

  const handlePinChat = useCallback(
    (id: string, pinned: boolean) => {
      if (!activeWorkspaceId) return;
      void useChatStore.getState().pinThread(activeWorkspaceId, id, pinned).catch(console.error);
    },
    [activeWorkspaceId],
  );

  const handleExportChat = useCallback(
    (id: string) => {
      void (async () => {
        try {
          const msgs = await ipc.listChatMessages(id);
          const thread = useChatStore
            .getState()
            .getThreads(activeWorkspaceId ?? "")
            .find((t) => t.id === id);
          const md = conversationToMarkdown(thread?.title ?? "Conversation", msgs);
          await copyToClipboard(md, "Conversation copied as Markdown");
        } catch (e) {
          console.error(e);
        }
      })();
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

      // ⌘⇧D → switch to Direct mode
      if (mod && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setMode("direct");
        return;
      }

      // ⌘⇧M → Mission Control (the fleet cockpit)
      if (mod && e.shiftKey && (e.key === "M" || e.key === "m")) {
        e.preventDefault();
        setMissionControlOpen((v) => !v);
        return;
      }

      // ⌘⇧L → Logbook Room (cross-mission rollup)
      if (mod && e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        setLogbookOpen((v) => !v);
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

      // ⌘P → file finder (workspace-wide fuzzy file search)
      if (mod && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        setSearchMode("files");
        setShowSearch(true);
        return;
      }

      // ⌘⇧F → workspace-wide text search
      if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchMode("text");
        setShowSearch(true);
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
  const activeProject = recentProjects.find((p) => p.id === activeWorkspace?.projectId) ?? (project?.id === activeWorkspace?.projectId ? project : null) ?? null;

  // Gates the empty-project screen so it can never lie: `activeWorkspace`
  // resolving to null does NOT by itself mean the project has no workspaces
  // — a stale flat array or a future bug could leave `activeId` pointing at
  // nothing while `workspacesByProjectId` (what the rail itself renders
  // from) still lists them. Only that map decides genuine emptiness.
  const projectWorkspaceCount = project ? (workspacesByProjectId[project.id]?.length ?? 0) : 0;
  const hasStaleActiveState = !activeWorkspace && projectWorkspaceCount > 0;

  // Self-heal instead of ever showing "No workspaces here yet" for a project
  // that actually has workspaces (2026-07-09 incident: an MCP-created
  // workspace was visible in the rail but activeWorkspace resolved to null).
  useEffect(() => {
    if (hasStaleActiveState && project) {
      healActiveForProject(project.id);
    }
  }, [hasStaleActiveState, project, healActiveForProject]);

  // Dismiss/Escape target for the genuinely-empty screen — the nearest other
  // project that already has workspaces loaded, so the screen is always
  // leavable instead of trapping the user. No target (and no dismiss
  // affordance) when no other project has workspaces yet, e.g. a brand-new
  // install with a single empty project.
  const dismissTarget = useMemo(() => {
    if (!project) return null;
    const candidateProject = recentProjects.find(
      (p) => p.id !== project.id && (workspacesByProjectId[p.id]?.length ?? 0) > 0,
    );
    if (!candidateProject) return null;
    const candidateWorkspaces = workspacesByProjectId[candidateProject.id] ?? [];
    const remembered = lastActiveByProject[candidateProject.id];
    const workspace = candidateWorkspaces.find((w) => w.id === remembered) ?? candidateWorkspaces[0];
    return { projectPath: candidateProject.path, workspace };
  }, [project, recentProjects, workspacesByProjectId, lastActiveByProject]);

  const handleDismissEmptyState = useCallback(() => {
    if (!dismissTarget) return;
    rememberActiveForProject(dismissTarget.workspace.projectId, dismissTarget.workspace.id);
    openProject(dismissTarget.projectPath);
  }, [dismissTarget, rememberActiveForProject, openProject]);

  // Chat state in chatStore is keyed by the real workspace id (the store tracks
  // which thread is active internally). `activeChatId` is therefore the
  // workspace id; the active *thread* id (for highlighting the History row) is
  // read separately below.
  const activeChatId = activeWorkspaceId;
  const activeThreadId = useChatStore((s) => s.getActiveThread(activeWorkspaceId ?? ""));
  const workspaceThreads = useChatStore((s) => s.getThreads(activeWorkspaceId ?? ""));
  // The thread currently running a turn (for the live pulse in the chat list).
  const streamingThreadId = useChatStore((s) =>
    activeWorkspaceId ? (s.streamingThreadByWs[activeWorkspaceId] ?? null) : null,
  );
  // Active skill for the conversation — surfaced in Context "Capabilities".
  const activeSkill = useChatStore((s) =>
    activeWorkspaceId ? (s.activeSkillByWs[activeWorkspaceId] ?? null) : null,
  );
  // Connected MCP servers for the workspace — also shown under Capabilities.
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  useEffect(() => {
    const path = activeWorkspace?.worktreePath;
    if (!path) {
      setMcpServers([]);
      return;
    }
    let cancelled = false;
    ipc
      .listMcpServers(path)
      .then((s) => !cancelled && setMcpServers(s))
      .catch(() => !cancelled && setMcpServers([]));
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.worktreePath]);

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

  // Issue tracker config — load once on mount. We only need the boolean:
  // whether the tracker is configured (all three fields present).
  const [issueTrackerConfigured, setIssueTrackerConfigured] = useState(false);

  function isIssueTrackerConfigured(cfg: { baseUrl?: string; email?: string; apiToken?: string } | null | undefined): boolean {
    return !!(cfg?.baseUrl && cfg?.email && cfg?.apiToken);
  }

  useEffect(() => {
    ipc.getIssueTrackerConfig()
      .then((cfg) => setIssueTrackerConfigured(isIssueTrackerConfigured(cfg)))
      .catch(() => {});
  }, []);

  const refreshIssueTrackerConfigured = async () => {
    try {
      const cfg = await ipc.getIssueTrackerConfig();
      setIssueTrackerConfigured(isIssueTrackerConfigured(cfg));
    } catch {
      // non-fatal
    }
  };

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
      budgets,
      spend,
      activeSkill,
      mcpServers,
      onReviewClick: () => setMode("review"),
      onSettingsClick: () => setSettingsTab("usage"),
    };
  }, [
    gitStatus,
    lastTurnInputTokens,
    activeModelMaxContext,
    liveToolCalls,
    budgets,
    spend,
    activeSkill,
    mcpServers,
    setMode,
  ]);

  // Re-derive titles whenever new messages arrive — title comes from the
  // first user message, meta comes from the relative time of the latest.
  // Select ONLY the active workspace's slice: subscribing to the whole
  // messagesByWs map re-renders App on every message in ANY workspace.
  const activeWsPrimaryMessages = useChatStore((s) =>
    activeWorkspaceId ? s.messagesByWs[activeWorkspaceId] : undefined,
  );
  // Tick once per minute so "5M AGO" / "1H AGO" stay current without
  // requiring a full re-render of the chat itself.
  const [tickerNow, setTickerNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTickerNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const companionHistoryProps = useMemo(
    () => {
      // Real conversation threads from chatStore (persisted in the DB). The
      // ACTIVE thread's row derives its title + meta live from its loaded
      // messages so it's self-describing; other rows use their stored title.
      const chats = workspaceThreads.map((t) => {
        if (t.id === activeThreadId) {
          const msgs = activeWsPrimaryMessages ?? [];
          return {
            id: t.id,
            title: deriveChatTitle(msgs) || t.title,
            meta: deriveChatMeta(msgs, tickerNow),
            pinned: t.pinned,
          };
        }
        return {
          id: t.id,
          title: t.title,
          meta: formatRelTime(t.updatedAt, tickerNow),
          pinned: t.pinned,
        };
      });
      return {
        chats,
        activeChatId: activeThreadId,
        onSelectChat: handleSelectChat,
        onNewChat: handleNewChat,
        onDeleteChat: handleDeleteChat,
        onRenameChat: handleRenameChat,
        onExportChat: handleExportChat,
        onPinChat: handlePinChat,
        streamingChatId: streamingThreadId,
      };
    },
    [
      workspaceThreads,
      activeThreadId,
      handleSelectChat,
      handleNewChat,
      handleDeleteChat,
      handleRenameChat,
      handleExportChat,
      handlePinChat,
      streamingThreadId,
      activeWsPrimaryMessages,
      tickerNow,
    ],
  );

  const openFileInEditor = useEditorStore((s) => s.openFile);

  // Large-file confirm dialog state
  const [largeFile, setLargeFile] = useState<{ size: number; path: string } | null>(null);
  const largeFileResolver = useRef<((ok: boolean) => void) | null>(null);
  const focusCommitFn = useRef<(() => void) | null>(null);
  const registerFocusCommit = useCallback((fn: () => void) => { focusCommitFn.current = fn; }, []);
  const confirmLargeFile = useCallback((size: number, path: string) => {
    return new Promise<boolean>((resolve) => {
      largeFileResolver.current = resolve;
      setLargeFile({ size, path });
    });
  }, []);
  const resolveLargeFile = useCallback((ok: boolean) => {
    largeFileResolver.current?.(ok);
    largeFileResolver.current = null;
    setLargeFile(null);
  }, []);

  // Lifted from ReviewCanvas so any surface (terminal, chat link, FILES tree,
  // CHANGES rail) can deep-link straight into either the diff or the editor.
  const [reviewViewMode, setReviewViewMode] = useState<ReviewViewMode>("diff");

  /**
   * Open `path` (relative or absolute) in the Review canvas.
   *
   * @param view  "editor" → switches to the in-canvas Editor and opens the
   *              file as a tab. "diff" → switches to the Diff view and
   *              scrolls the canvas to that file's hunks.
   * @param line  Optional new-file line number (e.g. from an AI review
   *              finding, or the diff's `o` key). In diff view we scroll to
   *              the matching diff row when it's visible, falling back to
   *              the file header. In editor view the cursor lands on that
   *              line (EditorPane consumes the store's pending reveal).
   */
  const navigateToFile = useCallback(
    (path: string, view: ReviewViewMode = "editor", line?: number | null) => {
      if (!activeWorkspace) return;
      const rootPath = activeWorkspace.worktreePath || project!.path;
      // AI findings (and other callers) may pass a git `a/`/`b/`-prefixed path;
      // strip it before resolving so both the editor and diff branches agree.
      const cleaned = stripDiffPrefix(path);
      const absolute = cleaned.startsWith("/") ? cleaned : `${rootPath}/${cleaned}`;
      const relative = absolute.startsWith(rootPath + "/")
        ? absolute.slice(rootPath.length + 1)
        : cleaned;

      setMode("review");
      setReviewViewMode(view);

      if (view === "editor") {
        openFileInEditor(activeWorkspace.id, absolute, confirmLargeFile, line ?? undefined).catch((e) =>
          pushToast({
            level: "error",
            title: "Could not open file",
            body: String(e),
          }),
        );
      } else {
        // Diff view — scroll to the anchor for that file. Defer one frame so
        // the canvas has switched modes before we try to find the anchor.
        requestAnimationFrame(() => {
          if (!revealDiffTarget(relative, line ?? null)) {
            // File isn't in the current diff (committed, reverted, or the
            // model hallucinated a path) — say so instead of doing nothing.
            pushToast({
              level: "info",
              title: "Not in the current diff",
              body: path,
            });
          }
        });
      }
    },
    [activeWorkspace, project, openFileInEditor, setMode, confirmLargeFile],
  );

  // Companion provenance chips jump into the diff at the file (best-effort line).
  const handleJumpToFile = useCallback(
    (file: string, line: number | null) => navigateToFile(file, "diff", line),
    [navigateToFile],
  );

  const fileTreeProps = useMemo(() => {
    if (!activeWorkspace) return undefined;
    const rootPath = activeWorkspace.worktreePath || project!.path;
    return {
      rootPath,
      rootLabel: activeWorkspace.name,
      changedPaths: new Set(
        (gitStatus?.changedFiles ?? []).map((f) => `${rootPath}/${f.path}`),
      ),
      // FILES rail click → land in the Editor with the file open as a tab.
      onFileClick: (p: string) => navigateToFile(p, "editor"),
    };
  }, [activeWorkspace, project, gitStatus, navigateToFile]);

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
    if (!deletingWorkspaceId) return;
    // Find the workspace across ALL projects (the rail can delete any of them,
    // not just one in the active project) and resolve its owning project path.
    const entry = Object.entries(workspacesByProjectId)
      .flatMap(([pid, wss]) => wss.map((w) => ({ pid, w })))
      .find((e) => e.w.id === deletingWorkspaceId);
    if (!entry) {
      setDeletingWorkspaceId(null);
      return;
    }
    const { pid: wsProjectId, w: ws } = entry;
    const projPath =
      project?.id === wsProjectId
        ? project.path
        : recentProjects.find((p) => p.id === wsProjectId)?.path;
    if (!projPath) {
      setDeletingWorkspaceId(null);
      pushToast({ level: "error", title: "Delete failed", body: "Could not resolve the workspace's project path." });
      return;
    }
    const wsName = ws.name;
    try {
      await removeWorkspace(ws.id, projPath, ws.branch, ws.worktreePath ?? null);
      // If we removed the active workspace, fall back to the first remaining one
      // in the current project so the canvas doesn't drop to the empty state.
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
  }, [deletingWorkspaceId, project, recentProjects, workspacesByProjectId, removeWorkspace, selectWorkspace]);

  // Selecting a workspace from the rail. If it belongs to a different project,
  // switch the active project to it (the project-switch effect loads that
  // project's workspaces and, thanks to the remembered selection below,
  // activates the clicked workspace). Selecting within the current project is a
  // plain activeId change. Without this, clicking a workspace in another project
  // left the active project unchanged and `activeWorkspace` resolved to null,
  // dropping the user onto the empty "No workspaces here yet" screen.
  const handleSelectWorkspace = useCallback(
    (id: string) => {
      const entry = Object.entries(workspacesByProjectId)
        .flatMap(([pid, wss]) => wss.map((w) => ({ pid, w })))
        .find((e) => e.w.id === id);
      const targetProjectId = entry?.pid;

      if (!targetProjectId || targetProjectId === project?.id) {
        selectWorkspace(id);
        return;
      }

      const targetPath = recentProjects.find((p) => p.id === targetProjectId)?.path;
      if (!targetPath) {
        selectWorkspace(id);
        return;
      }
      // Remember the clicked workspace so loadWorkspaces() activates it after
      // the project switch, then switch projects.
      rememberActiveForProject(targetProjectId, id);
      openProject(targetPath);
    },
    [workspacesByProjectId, project, selectWorkspace, recentProjects, rememberActiveForProject, openProject],
  );

  // Jump from Mission Control to a run's workspace + its Direct surface.
  // (Mode is App-local state, so the room can't navigate on its own.)
  const handleJumpToRun = useCallback(
    (workspaceId: string) => {
      setMissionControlOpen(false);
      handleSelectWorkspace(workspaceId);
      setModePerWorkspace((p) => ({ ...p, [workspaceId]: "direct" }));
    },
    [handleSelectWorkspace],
  );

  // Mission Control attention items → the mission's Talk (chat) / Run (terminal)
  // surface. Focusing the matching workspace+mode clears the attention flag.
  const handleJumpToAttention = useCallback(
    (workspaceId: string, kind: "chat" | "terminal") => {
      setMissionControlOpen(false);
      handleSelectWorkspace(workspaceId);
      setModePerWorkspace((p) => ({ ...p, [workspaceId]: kind === "chat" ? "talk" : "run" }));
    },
    [handleSelectWorkspace],
  );

  // "Send out a crew" — close the room and land on the current workspace's
  // Direct surface (its launcher when no run is executing).
  const handleDispatchCrew = useCallback(() => {
    setMissionControlOpen(false);
    if (activeWorkspaceId) {
      setModePerWorkspace((p) => ({ ...p, [activeWorkspaceId]: "direct" }));
    }
  }, [activeWorkspaceId]);

  // First-run invite CTA: hand off to the Direct launcher with the flagship
  // crew (Feature Factory) preselected and the workspace's task as the brief —
  // one more click ("Begin the run") and the crew is working. If no provider
  // is ready, route honestly to Settings · Models instead (the invite
  // survives; Feature Factory is all-api and would otherwise fail mid-run).
  const handleSendFirstCrew = useCallback(async () => {
    // Capture the click-time workspace: the readiness check awaits two IPC
    // round-trips, and a workspace switch mid-await must not hijack the new
    // one (the prefill is also workspace-scoped as a second guard).
    const wsId = activeWorkspaceId;
    const ws = workspaces.find((w) => w.id === wsId);
    if (!wsId) return;
    if (!(await crewProviderReady())) {
      setSettingsTab("models");
      pushToast({
        level: "info",
        title: "Add your Anthropic key first",
        body: "The crew runs on Claude — one key in Settings · Models and they're ready to work.",
      });
      return;
    }
    let pipelines = usePipelineStore.getState().pipelines;
    if (pipelines.length === 0) {
      await usePipelineStore.getState().load(); // first-ever session may click before the list loads
      pipelines = usePipelineStore.getState().pipelines;
    }
    const flagship =
      pipelines.find((p) => p.pipeline.isBuiltin && p.pipeline.name === "Feature Factory") ??
      pipelines.find((p) => p.pipeline.isBuiltin);
    if (!flagship) {
      pushToast({ level: "error", title: "Couldn't load the crew's pipeline" });
      return;
    }
    useRunsStore.getState().setLauncherPrefill({
      task: ws?.task ?? "",
      pipelineId: flagship.pipeline.id,
      overrides: [],
      workspaceId: wsId,
    });
    useFirstRunStore.getState().markUsed();
    setModePerWorkspace((p) => ({ ...p, [wsId]: "direct" }));
  }, [activeWorkspaceId, workspaces]);

  // ── Project context menu handler ──
  const handleProjectContextMenu = (projectId: string, x: number, y: number) => {
    setProjectContextMenu({ projectId, x, y });
  };

  // ── Project rename handler ──
  const handleRenameProject = (projectId: string) => {
    setCustomizingProjectId(projectId);
    setShowProjectCustomizer(true);
    setProjectContextMenu(null);
  };

  // ── Project close handler (soft-close: reversible from Recently closed) ──
  const handleCloseProject = useCallback(
    async (projectId: string) => {
      try {
        await closeProjectAction(projectId); // soft-close; clears current if active (C2)
        pruneProject(projectId); // drop its workspaces from the rail map (C8)
        pushToast({
          level: "success",
          title: "Project closed",
          body: "Restore it from Recently closed.",
        });
      } catch (err) {
        pushToast({
          level: "error",
          title: "Failed to close project",
          body: String(err),
        });
      }
      setProjectContextMenu(null);
    },
    [closeProjectAction, pruneProject]
  );

  // ── Project reopen handler (from the Recently closed drawer) ──
  const handleReopenProject = useCallback(
    async (projectId: string) => {
      try {
        await reopenProjectAction(projectId);
        pushToast({ level: "success", title: "Project restored" });
      } catch (err) {
        pushToast({
          level: "error",
          title: "Failed to restore project",
          body: String(err),
        });
      }
    },
    [reopenProjectAction]
  );

  // ── Project delete handler ──
  const handleDeleteProject = (projectId: string) => {
    setDeletingProjectId(projectId);
    setProjectContextMenu(null);
  };

  // ── Project confirm delete handler ──
  const handleConfirmDeleteProject = useCallback(
    async (projectId: string) => {
      try {
        await ipc.deleteProject(projectId);
        await loadRecentProjects();
        await loadClosedProjects();
        pruneProject(projectId);

        // If current project was deleted, go to welcome screen
        if (project?.id === projectId) {
          useProjectStore.getState().close();
        }

        pushToast({
          level: "success",
          title: "Project deleted",
        });
      } catch (err) {
        pushToast({
          level: "error",
          title: "Failed to delete project",
          body: String(err),
        });
      } finally {
        setDeletingProjectId(null);
      }
    },
    [project?.id, loadRecentProjects, loadClosedProjects, pruneProject]
  );

  // ── Project customized handler ──
  const handleProjectCustomized = async (name: string, tint: string) => {
    if (!customizingProjectId) return;
    try {
      // Update localStorage
      const customizations = JSON.parse(localStorage.getItem("projectCustomizations") || "{}");
      customizations[customizingProjectId] = { name, tint };
      localStorage.setItem("projectCustomizations", JSON.stringify(customizations));

      // Trigger re-render so projectGroups recalculates with new customizations
      setProjectCustomizationsVersion((v) => v + 1);

      // Durably persist to the backend too (survives a localStorage clear).
      await ipc.updateProjectCustomization(customizingProjectId, name, tint);
      // Refresh recentProjects so name-derived surfaces (archive modal title,
      // context menus) reflect the new name immediately.
      await loadRecentProjects();
      pushToast({ level: "success", title: "Project updated" });
    } catch (err) {
      pushToast({ level: "error", title: "Failed to update project", body: String(err) });
    } finally {
      setShowProjectCustomizer(false);
      setCustomizingProjectId(null);
    }
  };

  // Stable handlers for the Companion — inline arrows defeat memoized rows
  // (WorkContextPanel's TicketRow memo relies on this identity).
  const handleBacklogTicketContextMenu = useCallback(
    (issue: Issue, x: number, y: number) => setBacklogTicketMenu({ issue, x, y }),
    [],
  );

  // ── Backlog ticket → create workspace orchestration ──
  async function continueCreateForTicket(ticketKey: string, summary: string) {
    const prefix = ticketKey.split("-")[0];
    const candidates = recentProjects.filter((p) => p.jiraProjectKey === prefix);
    if (candidates.length === 0) {
      pushToast({
        level: "error",
        title: "No project linked",
        body: `No Octopush Project is linked to "${prefix}". Right-click a project to set its Jira key.`,
      });
      return;
    }
    if (candidates.length === 1) {
      setCreatorForTicket({
        projectId: candidates[0].id,
        projectPath: candidates[0].path,
        initialTask: summary,
        linkIssueKeyOnCreate: ticketKey,
      });
      return;
    }
    setProjectPickerForTicket({ ticketKey, summary, candidates });
  }

  async function startCreateForTicket(issue: Issue) {
    setBacklogTicketMenu(null);
    const allWorkspaces = Object.values(workspacesByProjectId).flat();
    const existing = allWorkspaces.find(
      (w) => w.linkedIssueKey === issue.key || detectIssueKey(w.branch ?? "") === issue.key
    );
    if (existing) {
      setExistingWsAlert({ ticketKey: issue.key, summary: issue.summary, existingName: existing.name });
      return;
    }
    await continueCreateForTicket(issue.key, issue.summary);
  }

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
  const customizingWorkspace = (() => {
    if (!customizingWorkspaceId) return null;
    // Search across all workspaces from all projects
    for (const projectWs of Object.values(workspacesByProjectId)) {
      const ws = projectWs.find((w) => w.id === customizingWorkspaceId);
      if (ws) return ws;
    }
    return null;
  })();

  const projectGroups: ProjectGroup[] = (() => {
    // Depend on projectCustomizationsVersion to trigger recalculation when customizations change
    void projectCustomizationsVersion;

    if (!project) return [];

    // Load customizations from localStorage
    const customizations = JSON.parse(localStorage.getItem("projectCustomizations") || "{}");

    // Stable order: follow `recentProjects` (creation order from the backend),
    // and append the active project only if it isn't in that list yet (e.g. one
    // just created this session). We deliberately do NOT hoist the active
    // project to the top — selecting a workspace must never reorder the rail,
    // and newly added projects stay at the end.
    const byId: Record<string, { name: string; tint: string | null }> = {};
    recentProjects.forEach((p) => { byId[p.id] = { name: p.name, tint: p.tint }; });
    if (project) byId[project.id] = { name: project.name, tint: project.tint };

    const ordered: { id: string; name: string; tint?: string }[] = [];
    const seen = new Set<string>();
    const pushProject = (id: string, fallbackName: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const backend = byId[id];
      const custom = customizations[id];
      ordered.push({
        id,
        name: backend?.name || custom?.name || fallbackName,
        tint: backend?.tint ?? custom?.tint,
      });
    };
    recentProjects.forEach((p) => pushProject(p.id, p.name));
    pushProject(project.id, project.name);

    const jiraKeyById: Record<string, string | null> = {};
    recentProjects.forEach((p) => {
      jiraKeyById[p.id] = p.jiraProjectKey;
    });
    if (project) jiraKeyById[project.id] = project.jiraProjectKey;

    return ordered.map((p) => ({
      id: p.id,
      name: p.name,
      tint: p.tint,
      jiraProjectKey: jiraKeyById[p.id] ?? null,
      workspaces: workspacesByProjectId[p.id] || [],
    }));
  })();

  return (
    <div className="flex flex-col h-screen w-screen bg-octo-bg text-octo-ivory">
      <AppTopBar
        onOpenSettings={() => setSettingsTab("general")}
        onToggleScratchpad={toggleScratchpad}
        onOpenMissionControl={() => setMissionControlOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
      <WorkspaceRail
        projects={projectGroups}
        activeWorkspaceId={activeWorkspaceId}
        onSelect={handleSelectWorkspace}
        onCustomize={(id) => setCustomizingWorkspaceId(id)}
        onContextMenu={(workspaceId, x, y) => setContextMenu({ workspaceId, x, y })}
        onNewWorkspaceForProject={(projectId) => {
          setCreatorProjectId(projectId);
          setShowCreator(true);
        }}
        onAddProject={() => setShowAddProject(true)}
        onProjectContextMenu={handleProjectContextMenu}
        closedProjects={closedProjects}
        onReopenProject={handleReopenProject}
        gitSummaryByWs={gitSummaryByWs}
        prByWs={prByWs}
        runningByWs={runningByWs}
        isCollapsed={isRailCollapsed}
        onReorderProjects={(ids) => void setProjectOrderAction(ids)}
      />

      <main className="ml-4 flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* TOP HEADER BAND — spans the full main width and includes the mode
            switcher on its right, so the entire top of the app reads as one
            unified header card instead of two floating containers in
            separate columns. */}
        {activeWorkspace && (
          <ContextHeader
            workspaceName={activeWorkspace.name}
            branch={activeWorkspace.branch}
            gitStatus={gitStatus}
            pr={openPrByWs[activeWorkspace.id] ?? null}
            onOpenPr={(url) => ipc.openFileInSystem(url)}
            workspace={activeWorkspace}
            issueTrackerConfigured={issueTrackerConfigured}
            jiraProjectKey={activeProject?.jiraProjectKey ?? null}
            missionIntent={activeMissionIntent}
            missionExecIsolation={activeMissionExecIsolation}
          />
        )}

        {/* CONTENT ROW — columns flush under the header band. */}
        <div className="flex min-w-0 flex-1 overflow-hidden">
        {/* LEFT COLUMN — always mounted so the canvas (and the TerminalPanes
            inside the Run mode panel) survive any moment when there's no
            active workspace, e.g. just after creating a fresh project that
            has zero workspaces yet. Previously a top-level
            {activeWorkspace ? <shell> : <EmptyState>} conditional was
            unmounting every running PTY whenever the user crossed that
            boundary. */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden pb-4">
          <CanvasSplit>
            <div className="relative w-full h-full min-w-0 flex-1 overflow-hidden">
              {/* Talk panel — chat for the active workspace. */}
              <ModeOverlay active={!!activeWorkspace && activeMode === "talk"}>
                {activeWorkspace && (
                  <ChatView
                    workspaceId={activeChatId!}
                    workspacePath={activeWorkspace.worktreePath || project.path}
                    onOpenSettings={() => setSettingsTab("general")}
                    onOpenInEditor={(p) => navigateToFile(p, "editor")}
                    onRunInTerminal={handleRunInTerminal}
                  />
                )}
                {/* One-shot first-run invite — floats over the Talk canvas
                    (where every new user lands); eligibility gated inside. */}
                {activeWorkspace && <FirstRunInvite onSendCrew={() => void handleSendFirstCrew()} />}
              </ModeOverlay>

              {/* Run panel — TerminalPanes for ALL (workspace, terminal) pairs
                  in the store are mounted here unconditionally. Individual
                  panes hide via display:none when not the active one, but the
                  container itself is never gated by activeWorkspace, so PTYs
                  survive project switches and new-project creation. */}
              <ModeOverlay active={!!activeWorkspace && activeMode === "run"}>
                <div className="relative h-full w-full">
                  {allTerminalRefs.map((t) => {
                    const ws = workspaces.find((w) => w.id === t.workspaceId);
                    const wsPath = ws?.worktreePath || project.path;
                    return (
                      <TerminalPane
                        key={t.id}
                        terminalId={t.id}
                        workspaceId={t.workspaceId}
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
                        onOpenFile={(p) => navigateToFile(p, "editor")}
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
              </ModeOverlay>

              {/* Review panel — only meaningful with an active workspace. */}
              <ModeOverlay active={!!activeWorkspace && activeMode === "review"}>
                {activeWorkspace && (
                  <div className="flex h-full min-h-0">
                    {/* Left: unified, collapsible Changes + Files navigator */}
                    <ReviewSidebar
                      changedCount={gitStatus?.changedFiles.length ?? 0}
                      projectPath={activeWorkspace.worktreePath || project.path}
                      workspaceId={activeWorkspaceId!}
                      diff={gitDiff}
                      onChangesFileClick={(filePath) => navigateToFile(filePath, "diff")}
                      registerFocusCommit={registerFocusCommit}
                      fileTree={fileTreeProps ?? {
                        rootPath: activeWorkspace.worktreePath || project.path,
                        rootLabel: activeWorkspace.name,
                        changedPaths: new Set(),
                      }}
                      onChangesChange={() => {
                        // Refetch diff + status after commit / push so the
                        // canvas catches up immediately.
                        const path = activeWorkspace.worktreePath || project.path;
                        Promise.all([
                          ipc.getGitStatus(path),
                          ipc.getGitDiff(path, ignoreWs).catch(() => ""),
                        ])
                          .then(([s, d]) => {
                            setGitStatus(s);
                            setGitDiff(d);
                          })
                          .catch(() => {});
                      }}
                    />

                    {/* Centre: ReviewCanvas with Diff/Editor toggle */}
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                      <ReviewCanvas
                        workspaceId={activeWorkspaceId!}
                        workspacePath={activeWorkspace.worktreePath || project.path}
                        gitStatus={gitStatus}
                        gitDiff={gitDiff}
                        viewMode={reviewViewMode}
                        onViewModeChange={setReviewViewMode}
                        onOpenFileAtLine={(p, line) => navigateToFile(p, "editor", line)}
                        onDiffChange={() => {
                          // Re-fetch git status + diff after a hunk action
                          const path = activeWorkspace.worktreePath || project.path;
                          Promise.all([
                            ipc.getGitStatus(path),
                            ipc.getGitDiff(path, ignoreWs).catch(() => ""),
                          ])
                            .then(([s, d]) => {
                              setGitStatus(s);
                              setGitDiff(d);
                            })
                            .catch(() => {});
                        }}
                        initialTestCommand={activeWorkspace.testCommand ?? null}
                        onFocusCommit={() => focusCommitFn.current?.()}
                      >
                        {/* Editor mode content */}
                        <EditorTabs workspaceId={activeWorkspaceId!} />
                        <EditorWithPreview
                          workspaceId={activeWorkspaceId!}
                          workspacePath={activeWorkspace.worktreePath || project.path}
                          diffText={gitDiff}
                        />
                      </ReviewCanvas>
                    </div>
                  </div>
                )}
              </ModeOverlay>

              {/* Direct mode overlay */}
              <ModeOverlay active={!!activeWorkspace && activeMode === "direct"}>
                {activeWorkspace && (
                  <DirectCanvas
                    key={activeWorkspace.id}
                    active={activeMode === "direct"}
                    workspaceId={activeWorkspace.id}
                    defaultTask={activeWorkspace.task || ""}
                    linkedIssueKey={activeWorkspace.linkedIssueKey ?? null}
                    workspacePath={activeWorkspace.worktreePath || project.path}
                  />
                )}
              </ModeOverlay>
            </div>
          </CanvasSplit>

            {/* Workspace creator overlay (from the rail "+" button or project header). */}
            {showCreator && (() => {
              const targetProjectId = creatorProjectId || project.id;
              const targetProject = getProjectById(targetProjectId);
              return targetProject ? (
                <div className="absolute inset-0 z-50 bg-octo-bg octo-fade-in">
                  <MissionCreator
                    projectId={targetProject.id}
                    projectPath={targetProject.path}
                    onCreated={() => {
                      setShowCreator(false);
                      setCreatorProjectId(null);
                    }}
                    onCancel={() => {
                      setShowCreator(false);
                      setCreatorProjectId(null);
                    }}
                  />
                </div>
              ) : null;
            })()}

            {/* Empty-project layer — overlays the canvas when the project is
                genuinely empty. The LEFT COLUMN div (immediately above,
                `relative flex min-w-0 flex-1 ...`) is this layer's nearest
                positioned ancestor, so `absolute inset-0` is scoped to that
                column only — WorkspaceRail and PerfMonitorBar are siblings
                further up the tree (outside LEFT COLUMN entirely) and stay
                mounted/interactive underneath it. The shell underneath also
                stays mounted so any running terminals from other projects
                keep their PTYs and scrollback intact. While
                `hasStaleActiveState` is true (a workspace exists but
                `activeId` doesn't resolve to it yet) this deliberately
                renders nothing — the effect above self-heals and the next
                render picks up `activeWorkspace`, so the screen never lies
                about a project having no workspaces. */}
            {!activeWorkspace && !hasStaleActiveState && (
              <div className="absolute inset-0 z-40 bg-octo-bg octo-fade-in">
                {showInlineCreator ? (
                  <MissionCreator
                    projectId={project.id}
                    projectPath={project.path}
                    onCreated={() => setShowInlineCreator(false)}
                    onCancel={() => setShowInlineCreator(false)}
                  />
                ) : (
                  <EmptyProjectState
                    projectName={project.name}
                    onCreateWorkspace={() => setShowInlineCreator(true)}
                    onDismiss={dismissTarget ? handleDismissEmptyState : undefined}
                    dismissWorkspaceName={dismissTarget?.workspace.name}
                  />
                )}
              </div>
            )}
        </div>

        {/* RIGHT COLUMN — Companion always mounted. When there's no active
            workspace the panel just shows empty/default data; the structure
            is preserved. The mode switcher now lives in the unified header
            band above. Resizable via the 4px handle on the left edge:
            drag to widen/narrow, double-click to reset to default. */}
        <div
          className={`relative flex shrink-0 flex-col pt-0 transition-all duration-[220ms] ${
            isCompanionCollapsed ? "px-2 pb-4" : "p-4"
          }`}
          style={{ width: isCompanionCollapsed ? COMPANION_COLLAPSED_WIDTH : companionWidth }}
        >
          {/* The resize handle only makes sense when expanded. */}
          {!isCompanionCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Companion"
              title="Drag to resize · Double-click to reset"
              onMouseDown={startCompanionResize}
              onDoubleClick={resetCompanionWidth}
              className={`absolute left-0 top-0 bottom-0 z-10 w-[4px] cursor-col-resize transition-colors hover:bg-octo-brass ${
                companionResizing ? "bg-octo-brass" : "bg-transparent"
              }`}
            />
          )}
          <Companion
            mode={activeMode}
            workspaceId={activeWorkspaceId}
            contextProps={companionContextProps}
            historyProps={companionHistoryProps}
            workspace={activeWorkspace ?? null}
            project={activeProject ?? null}
            issueTrackerConfigured={issueTrackerConfigured}
            onBacklogTicketContextMenu={handleBacklogTicketContextMenu}
            onModeChange={setMode}
            reviewProps={
              activeWorkspace
                ? {
                    gitStatus,
                    gitDiff,
                    workspacePath: activeWorkspace.worktreePath || activeProject?.path || "",
                  }
                : null
            }
            onJumpToFile={handleJumpToFile}
            collapsed={isCompanionCollapsed}
            onToggleCollapsed={() => setIsCompanionCollapsed((v) => !v)}
            onOpenLogbook={() => setLogbookOpen(true)}
          />
        </div>
        </div>
      </main>
      </div>
      <PerfMonitorBar
        workspacePath={activeWorkspace?.worktreePath ?? project?.path}
        isRailCollapsed={isRailCollapsed}
        onToggleRail={() => setIsRailCollapsed((v) => !v)}
      />

      {customizingWorkspace && (
        <div
          className="absolute inset-0 z-30 flex items-start justify-start bg-black/30 p-2 octo-overlay-enter"
          onClick={() => setCustomizingWorkspaceId(null)}
          role="dialog"
          aria-modal="true"
        >
          <div onClick={(e) => e.stopPropagation()} className="ml-14 mt-12 octo-modal-enter">
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

      {renamingWorkspace && (
        <ModalShell onClose={() => setRenamingWorkspace(null)} ariaLabel="Rename workspace">
          <RenameDialog
            title="Rename workspace"
            label="Name"
            initialValue={renamingWorkspace.name}
            onSubmit={(name) => {
              void useWorkspaceStore.getState().rename(renamingWorkspace.id, name);
              setRenamingWorkspace(null);
            }}
            onCancel={() => setRenamingWorkspace(null)}
          />
        </ModalShell>
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

      {activeWorkspace && (
        <WorkspaceSearchPalette
          open={showSearch}
          initialMode={searchMode}
          workspacePath={activeWorkspace.worktreePath || project!.path}
          onClose={() => setShowSearch(false)}
          onOpenFile={(relativePath) => navigateToFile(relativePath, "editor")}
        />
      )}

      <Settings
        open={settingsTab !== null}
        initialTab={settingsTab ?? "general"}
        onClose={() => setSettingsTab(null)}
        onIssueTrackerConfigSaved={refreshIssueTrackerConfigured}
      />

      {/* Project context menu (right-click on project header) */}
      {projectContextMenu && (() => {
        const proj =
          recentProjects.find((p) => p.id === projectContextMenu.projectId) ??
          (project?.id === projectContextMenu.projectId ? project : null);
        if (!proj) return null;
        const projPath = proj.path;
        const copyPath = async () => {
          setProjectContextMenu(null);
          await copyToClipboard(projPath, "Path copied");
        };
        return (
          <ProjectContextMenu
            projectId={projectContextMenu.projectId}
            projectName={proj.name}
            x={projectContextMenu.x}
            y={projectContextMenu.y}
            onRevealInFinder={() => {
              setProjectContextMenu(null);
              void ipc.revealInFinder(projPath).catch((err) =>
                pushToast({ level: "error", title: "Reveal failed", body: String(err) }),
              );
            }}
            onCopyPath={() => void copyPath()}
            onOpenInEditor={() => {
              setProjectContextMenu(null);
              void ipc.openInEditor(projPath).catch((err) =>
                pushToast({ level: "error", title: "Open in editor failed", body: String(err) }),
              );
            }}
            onOpenInTerminal={() => {
              setProjectContextMenu(null);
              void ipc.openInTerminal(projPath).catch((err) =>
                pushToast({ level: "error", title: "Open in terminal failed", body: String(err) }),
              );
            }}
            onRename={() => handleRenameProject(projectContextMenu.projectId)}
            onChangeTint={() => {
              setCustomizingProjectId(projectContextMenu.projectId);
              setShowProjectCustomizer(true);
              setProjectContextMenu(null);
            }}
            onSetJiraProjectKey={() => {
              setJiraProjectKeyEditorOpen({ projectId: projectContextMenu.projectId });
              setProjectContextMenu(null);
            }}
            onViewArchived={() => {
              setArchivedForProject({ id: proj.id, name: proj.name, path: proj.path });
              setProjectContextMenu(null);
            }}
            pinned={proj.pinned}
            canMoveUp={projectGroups.findIndex((g) => g.id === projectContextMenu.projectId) > 0}
            canMoveDown={(() => {
              const i = projectGroups.findIndex((g) => g.id === projectContextMenu.projectId);
              return i >= 0 && i < projectGroups.length - 1;
            })()}
            onTogglePin={() => {
              void setProjectPinnedAction(projectContextMenu.projectId, !proj.pinned);
              setProjectContextMenu(null);
            }}
            onMoveUp={() => {
              const ids = projectGroups.map((g) => g.id);
              const i = ids.indexOf(projectContextMenu.projectId);
              if (i > 0) {
                [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                void setProjectOrderAction(ids);
              }
              setProjectContextMenu(null);
            }}
            onMoveDown={() => {
              const ids = projectGroups.map((g) => g.id);
              const i = ids.indexOf(projectContextMenu.projectId);
              if (i >= 0 && i < ids.length - 1) {
                [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
                void setProjectOrderAction(ids);
              }
              setProjectContextMenu(null);
            }}
            onClose={() => handleCloseProject(projectContextMenu.projectId)}
            onDelete={() => handleDeleteProject(projectContextMenu.projectId)}
            onDismiss={() => setProjectContextMenu(null)}
          />
        );
      })()}

      {archivedForProject && (
        <ModalShell onClose={() => setArchivedForProject(null)} ariaLabel="Archived workspaces">
          <ArchivedWorkspacesModal
            projectId={archivedForProject.id}
            projectName={archivedForProject.name}
            projectPath={archivedForProject.path}
            onRestored={(pid) => {
              void loadAllWorkspaces([pid]);
              void loadGitSummaries(pid);
              const p = recentProjects.find((x) => x.id === pid)?.path ?? (project?.id === pid ? project.path : undefined);
              if (p) void loadProjectPrs(pid, p);
            }}
            onClose={() => setArchivedForProject(null)}
          />
        </ModalShell>
      )}

      {/* Project customization menu */}
      {showProjectCustomizer && customizingProjectId && (() => {
        const proj = recentProjects.find(p => p.id === customizingProjectId);
        if (!proj) return null;

        const customizations = JSON.parse(localStorage.getItem("projectCustomizations") || "{}");
        const customized = customizations[customizingProjectId] || {};

        return (
          <div
            className="absolute inset-0 z-30 flex items-start justify-start bg-black/30 p-2 octo-overlay-enter"
            onClick={() => setShowProjectCustomizer(false)}
            role="dialog"
            aria-modal="true"
          >
            <div onClick={(e) => e.stopPropagation()} className="ml-14 mt-12 octo-modal-enter">
              <ProjectCustomizeMenu
                currentName={customized.name || proj.name}
                currentTint={customized.tint || "brass"}
                onCustomized={(name, tint) => handleProjectCustomized(name, tint)}
                onCancel={() => setShowProjectCustomizer(false)}
              />
            </div>
          </div>
        );
      })()}

      {/* Project delete confirmation dialog */}
      {deletingProjectId && (() => {
        const proj = recentProjects.find(p => p.id === deletingProjectId);
        if (!proj) return null;

        return (
          <ConfirmDialog
            title="Delete Project Permanently?"
            body={`This will permanently delete "${proj.name}" and ALL its workspaces from disk.`}
            destructiveLabel="Delete"
            cancelLabel="Cancel"
            requireInput={proj.name}
            onConfirm={() => handleConfirmDeleteProject(deletingProjectId!)}
            onCancel={() => setDeletingProjectId(null)}
          />
        );
      })()}

      {/* Workspace context menu (right-click on monogram) */}
      {contextMenu && (() => {
        let ws = null;
        for (const projectWs of Object.values(workspacesByProjectId)) {
          ws = projectWs.find((w) => w.id === contextMenu.workspaceId);
          if (ws) break;
        }
        if (!ws) return null;
        const workspace = ws;
        const wsBranch = workspace.branch ?? "";
        const proj =
          recentProjects.find((p) => p.id === workspace.projectId) ??
          (project?.id === workspace.projectId ? project : null);
        const manualKey = workspace.linkedIssueKey ?? null;
        const detectedKey = detectIssueKeyForProject(wsBranch, proj?.jiraProjectKey ?? null);
        const ticketKey = manualKey ?? detectedKey;
        const wsLinkageKind: "linked" | "unlinked" = ticketKey ? "linked" : "unlinked";
        const wsPath = workspace.worktreePath ?? proj?.path ?? "";
        // Main worktree detection. The backend stores the main workspace's
        // worktree_path equal to the project root (never null), so the second
        // clause normally decides this; the null check is a defensive fallback.
        // Note: this is a raw string compare — the backend canonicalizes paths,
        // so a symlinked/non-canonical project path could in theory miss here.
        const isMain = !workspace.worktreePath || (!!proj && workspace.worktreePath === proj.path);
        const copy = async (text: string, label: string) => {
          setContextMenu(null);
          await copyToClipboard(text, label);
        };
        return (
          <WorkspaceContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            workspaceName={workspace.name}
            ticketKey={ticketKey}
            isMain={isMain}
            onRevealInFinder={() => {
              setContextMenu(null);
              void ipc.revealInFinder(wsPath).catch((err) =>
                pushToast({ level: "error", title: "Reveal failed", body: String(err) }),
              );
            }}
            onCopyPath={() => void copy(wsPath, "Path copied")}
            onCopyBranch={() => void copy(wsBranch, "Branch copied")}
            onOpenInEditor={() => {
              setContextMenu(null);
              void ipc.openInEditor(wsPath).catch((err) =>
                pushToast({ level: "error", title: "Open in editor failed", body: String(err) }),
              );
            }}
            onOpenInTerminal={() => {
              setContextMenu(null);
              void ipc.openInTerminal(wsPath).catch((err) =>
                pushToast({ level: "error", title: "Open in terminal failed", body: String(err) }),
              );
            }}
            onCustomize={() => {
              setContextMenu(null);
              setCustomizingWorkspaceId(contextMenu.workspaceId);
            }}
            onRename={() => {
              setRenamingWorkspace({ id: workspace.id, name: workspace.name });
              setContextMenu(null);
            }}
            onArchive={() => {
              setContextMenu(null);
              void useWorkspaceStore.getState()
                .archive(workspace.id, proj?.path ?? "", workspace.branch ?? "", workspace.worktreePath ?? null)
                .then(() => pushToast({ level: "success", title: "Workspace archived", body: "The branch is kept." }))
                .catch((err) => pushToast({ level: "error", title: "Archive failed", body: String(err) }));
            }}
            onDelete={() => {
              setContextMenu(null);
              setDeletingWorkspaceId(contextMenu.workspaceId);
            }}
            onClose={() => setContextMenu(null)}
            linkageKind={wsLinkageKind}
            onLinkJira={() => {
              setJiraTicketPickerOpen({ workspaceId: contextMenu.workspaceId, mode: "link" });
              setContextMenu(null);
            }}
            onChangeJira={() => {
              setJiraTicketPickerOpen({ workspaceId: contextMenu.workspaceId, mode: "change" });
              setContextMenu(null);
            }}
            onUnlinkJira={async () => {
              await ipc.updateWorkspaceLink(contextMenu.workspaceId, null);
              await useWorkspaceStore.getState().load(workspace.projectId);
              setContextMenu(null);
            }}
          />
        );
      })()}

      {/* Large-file confirmation dialog */}
      {largeFile && (
        <ConfirmDialog
          title="Large file"
          body={`${largeFile.path.split("/").pop()} is ${formatBytes(largeFile.size)}. Opening large files can make the editor slow. Open anyway?`}
          destructiveLabel="Open anyway"
          cancelLabel="Cancel"
          onConfirm={() => resolveLargeFile(true)}
          onCancel={() => resolveLargeFile(false)}
        />
      )}

      {/* Delete confirmation modal */}
      {deletingWorkspaceId && (() => {
        // Search across all workspaces from all projects
        let ws = null;
        for (const projectWs of Object.values(workspacesByProjectId)) {
          ws = projectWs.find((w) => w.id === deletingWorkspaceId);
          if (ws) break;
        }
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
        <div className="absolute inset-0 z-50 bg-octo-bg octo-fade-in">
          <NewProjectFlow
            onBack={() => setShowAddProject(false)}
          />
        </div>
      )}

      {/* Jira ticket picker modal (link / change from workspace context menu) */}
      {jiraTicketPickerOpen && (() => {
        const { issues: allIssues } = useIssuesStore.getState();
        // Find the workspace to get projectKey context
        let pickerWs = null;
        for (const projectWs of Object.values(workspacesByProjectId)) {
          pickerWs = projectWs.find((w) => w.id === jiraTicketPickerOpen.workspaceId);
          if (pickerWs) break;
        }
        const pickerProject = pickerWs
          ? recentProjects.find((p) => p.id === pickerWs!.projectId) ?? (project?.id === pickerWs.projectId ? project : null)
          : null;
        const pickerProjectKey = pickerProject?.jiraProjectKey ?? null;
        return (
          <JiraTicketPickerModal
            candidates={allIssues ?? []}
            projectKey={pickerProjectKey}
            title={jiraTicketPickerOpen.mode === "link" ? "Link Jira ticket" : "Change Jira ticket"}
            onPick={async (key) => {
              await ipc.updateWorkspaceLink(jiraTicketPickerOpen.workspaceId, key);
              await useWorkspaceStore.getState().load(pickerWs!.projectId);
              void useIssuesStore.getState().load();
              setJiraTicketPickerOpen(null);
            }}
            onClose={() => setJiraTicketPickerOpen(null)}
          />
        );
      })()}

      {/* Jira project key editor modal (set project key from project context menu) */}
      {jiraProjectKeyEditorOpen && (() => {
        const proj = recentProjects.find((p) => p.id === jiraProjectKeyEditorOpen.projectId)
          ?? (project?.id === jiraProjectKeyEditorOpen.projectId ? project : null);
        if (!proj) return null;
        return (
          <JiraProjectKeyModal
            initialValue={proj.jiraProjectKey ?? ""}
            projectName={proj.name}
            onSave={async (value) => {
              await ipc.updateProjectJiraKey(jiraProjectKeyEditorOpen.projectId, value);
              await loadRecentProjects();
              setJiraProjectKeyEditorOpen(null);
            }}
            onClose={() => setJiraProjectKeyEditorOpen(null)}
          />
        );
      })()}

      {/* Backlog ticket context menu */}
      {backlogTicketMenu && (
        <BacklogRowContextMenu
          x={backlogTicketMenu.x}
          y={backlogTicketMenu.y}
          onCreateWorkspace={() => void startCreateForTicket(backlogTicketMenu.issue)}
          onClose={() => setBacklogTicketMenu(null)}
        />
      )}

      {/* Existing workspace alert modal */}
      {existingWsAlert && (
        <ExistingWorkspaceAlertModal
          ticketKey={existingWsAlert.ticketKey}
          workspaceName={existingWsAlert.existingName}
          onContinue={() => {
            const { ticketKey, summary } = existingWsAlert;
            setExistingWsAlert(null);
            void continueCreateForTicket(ticketKey, summary);
          }}
          onCancel={() => setExistingWsAlert(null)}
        />
      )}

      {/* Project picker modal (multiple projects match the Jira prefix) */}
      {projectPickerForTicket && (
        <ProjectPickerModal
          candidates={projectPickerForTicket.candidates}
          title="Select Octopush Project"
          onPick={(projectId) => {
            const picked = recentProjects.find((p) => p.id === projectId);
            if (!picked) return;
            setProjectPickerForTicket(null);
            setCreatorForTicket({
              projectId: picked.id,
              projectPath: picked.path,
              initialTask: projectPickerForTicket.summary,
              linkIssueKeyOnCreate: projectPickerForTicket.ticketKey,
            });
          }}
          onClose={() => setProjectPickerForTicket(null)}
        />
      )}

      {/* Ticket-driven workspace creator (overlay, does not unmount canvas) */}
      {creatorForTicket && (() => {
        const targetProject = getProjectById(creatorForTicket.projectId);
        return targetProject ? (
          <div className="absolute inset-0 z-50 bg-octo-bg octo-fade-in">
            {/* The `key` forces a remount when the ticket-driven creator
             *  opens for a different ticket — `useState(initialTask)` only
             *  reads at mount, so without this prop a back-to-back flow on
             *  two tickets would keep the first ticket's pre-fill. */}
            <MissionCreator
              key={creatorForTicket.linkIssueKeyOnCreate}
              projectId={targetProject.id}
              projectPath={targetProject.path}
              initialTask={creatorForTicket.initialTask}
              linkIssueKeyOnCreate={creatorForTicket.linkIssueKeyOnCreate}
              onCreated={() => setCreatorForTicket(null)}
              onCancel={() => setCreatorForTicket(null)}
            />
          </div>
        ) : null;
      })()}

      <ToastContainer />
      <UpdateNotifier />
      <UpgradeSheet />
      <HistorySheet />
      {/* Mounted only while open — the room subscribes to the whole runs
          board, so an always-mounted instance would churn on every stage
          event for nothing. OverlayRoom's fade-in covers the entrance. */}
      {missionControlOpen && (
        <MissionControl
          open
          onClose={() => setMissionControlOpen(false)}
          onJumpToRun={handleJumpToRun}
          onJumpToAttention={handleJumpToAttention}
          onDispatch={handleDispatchCrew}
        />
      )}
      {logbookOpen && (
        <LogbookRoom open onClose={() => setLogbookOpen(false)} project={project} />
      )}
    </div>
  );
}

function RunEmptyState({ onStart }: { onStart: () => Promise<void> | void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Run
      </div>
      <div className="font-serif text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Start a new terminal.
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        A terminal opens in the workspace's worktree directory. You can keep multiple terminals open and switch via the Companion panel.
      </p>
      <button
        type="button"
        onClick={() => onStart()}
        className="mt-2 rounded-md px-4 py-2 font-serif text-[13px] text-octo-brass transition"
        style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
      >
        Open terminal
      </button>
    </div>
  );
}

export default App;
