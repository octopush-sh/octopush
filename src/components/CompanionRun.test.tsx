/**
 * Run mode's Companion: Context follows the focused pane's agent session and
 * folds away when there is nothing to say; Changes lists the uncommitted
 * files and hands off to Review; Mission is the mission's Logbook line.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
const getSessionUsage = vi.fn();
const logbookSummary = vi.fn();
// Every subscriber, as the real event reaches them all (the Context section
// and the mission's Logbook line both listen for an ingest pass).
const ingestHandlers = new Set<() => void>();
const settledHandlers = new Set<(terminalId: string) => void>();
const sessionHandlers = new Set<(terminalId: string) => void>();
const onIngested = () => ingestHandlers.forEach((h) => h());
const onSettled = (terminalId: string) => settledHandlers.forEach((h) => h(terminalId));
const onSessionChanged = (terminalId: string) => sessionHandlers.forEach((h) => h(terminalId));
vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      getSessionUsage: (...a: unknown[]) => getSessionUsage(...a),
      logbookSummary: (...a: unknown[]) => logbookSummary(...a),
      onSpendIngested: (h: () => void) => {
        ingestHandlers.add(h);
        return Promise.resolve(() => void ingestHandlers.delete(h));
      },
      onPtySettled: (h: (terminalId: string) => void) => {
        settledHandlers.add(h);
        return Promise.resolve(() => void settledHandlers.delete(h));
      },
      onClaudeSessionChanged: (h: (terminalId: string) => void) => {
        sessionHandlers.add(h);
        return Promise.resolve(() => void sessionHandlers.delete(h));
      },
    },
  };
});

import { useTerminalsStore, type TerminalState } from "../stores/terminalsStore";
import { useMissionsStore } from "../stores/missionsStore";
import type { FileChange, GitStatus, LogbookMissionRow, Mission, SessionUsage } from "../lib/types";
import type { SessionRole } from "../lib/sessionRole";
import { changeStats } from "../lib/runChanges";
import { CompanionRun, spentLabel } from "./CompanionRun";

const WS = "ws-1";

/** A session; an agent one runs Claude Code unless `over.agentCli` says otherwise. */
const term = (id: string, label: string, role: SessionRole, over: Partial<TerminalState> = {}): TerminalState => ({
  id,
  label,
  position: 0,
  running: true,
  busy: role !== "shell",
  restored: false,
  role,
  agentCli: role === "agent" ? "claude" : null,
  command: role === "shell" ? null : "cmd",
  ...over,
});

function sessions(list: TerminalState[], activeId: string | null) {
  useTerminalsStore.setState({ terminalsByWs: { [WS]: list }, activeByWs: { [WS]: activeId } });
}

const usage = (over: Partial<SessionUsage> = {}): SessionUsage => ({
  contextTokens: 148_000,
  maxContext: 1_000_000,
  spentUsd: 2.61,
  calls: 40,
  unpricedCalls: 0,
  cacheHitPct: 94.2,
  model: "claude-fable-5-2",
  asOf: "2026-11-18T10:00:00+00:00",
  ...over,
});

const file = (path: string, status: FileChange["status"] = "modified"): FileChange => ({
  path,
  status,
  staged: false,
  unstaged: true,
  conflicted: status === "conflicted",
});

const status = (files: FileChange[]): GitStatus => ({
  branch: "feat/x",
  changedFiles: files,
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  conflicted: 0,
  aheadBehindKnown: true,
  operation: null,
});

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " keep",
  "-old",
  "+new",
  "+more",
  "diff --git a/docs/plan.md b/docs/plan.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/plan.md",
  "@@ -0,0 +1,1 @@",
  "+one",
].join("\n");

const flush = () => act(async () => {});

/** The Context section, only while it is drawn (not folded away). */
function contextSection(): HTMLElement | null {
  const el = screen.queryByTestId("companion-run-context");
  return el && !el.closest("[inert]") ? el : null;
}

beforeEach(() => {
  localStorage.clear();
  ingestHandlers.clear();
  settledHandlers.clear();
  sessionHandlers.clear();
  getSessionUsage.mockReset().mockResolvedValue(null);
  logbookSummary.mockReset().mockResolvedValue([]);
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {} });
  useMissionsStore.setState({ missionsByProjectId: {}, missionByWorkspaceId: {} });
});

describe("CompanionRun · Context", () => {
  it("shows the focused agent session's context, spend, cache share and model", async () => {
    sessions([term("t-agent", "Plan the migration", "agent")], "t-agent");
    getSessionUsage.mockResolvedValue(usage());
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();

    expect(getSessionUsage).toHaveBeenCalledWith("t-agent");
    const ctx = contextSection()!;
    // The eyebrow names the session it describes.
    expect(within(ctx).getByTestId("companion-section-meta")).toHaveTextContent("Plan the migration");
    const meter = within(ctx).getByTestId("run-context-meter");
    expect(meter).toHaveTextContent("148k / 1M");
    expect(meter).toHaveAttribute("data-tone", "ok");
    expect(within(ctx).getByTestId("run-context-spent")).toHaveTextContent("$2.61");
    expect(within(ctx).getByTestId("run-context-cached")).toHaveTextContent("94% of prompt tokens");
    expect(within(ctx).getByTestId("run-context-model")).toHaveTextContent("claude-fable-5-2");
    // Calm below 80%: no compaction line.
    expect(within(ctx).getByTestId("run-context-warning").closest("[inert]")).not.toBeNull();
  });

  it("is not drawn for a shell, a dev server, a failed or a stopped session, and asks nothing about them", async () => {
    sessions([term("t-shell", "zsh", "shell"), term("t-dev", "API", "dev")], "t-shell");
    getSessionUsage.mockResolvedValue(usage());
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(contextSection()).toBeNull();
    act(() => useTerminalsStore.setState({ activeByWs: { [WS]: "t-dev" } }));
    await flush();
    expect(contextSection()).toBeNull();
    act(() => sessions([term("t-fail", "claude", "agent", { failed: true, running: false })], "t-fail"));
    await flush();
    expect(contextSection()).toBeNull();
    // Its shell has exited: no Claude Code runs in a PTY that is gone.
    act(() => sessions([term("t-stopped", "claude", "agent", { running: false })], "t-stopped"));
    await flush();
    expect(contextSection()).toBeNull();
    expect(getSessionUsage).not.toHaveBeenCalled();
  });

  it("is not drawn for another agent CLI, and asks nothing about it", async () => {
    // Codex, aider and the rest share the agent role; only Claude Code has figures.
    sessions([term("t-codex", "codex", "agent", { agentCli: "codex" }), term("t-old", "agent", "agent", { agentCli: null })], "t-codex");
    getSessionUsage.mockResolvedValue(usage());
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(contextSection()).toBeNull();
    act(() => useTerminalsStore.setState({ activeByWs: { [WS]: "t-old" } }));
    await flush();
    expect(contextSection()).toBeNull();
    expect(getSessionUsage).not.toHaveBeenCalled();
  });

  it("folds away when Codex takes over a pane that ran Claude Code", async () => {
    sessions([term("t-a", "Agent", "agent")], "t-a");
    getSessionUsage.mockResolvedValue(usage());
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(contextSection()).not.toBeNull();
    // The store's own rule: the command that replaces the role replaces the CLI.
    act(() => useTerminalsStore.getState().setBusy(WS, "t-a", true, "codex"));
    await flush();
    expect(useTerminalsStore.getState().getTerminals(WS)[0].agentCli).toBe("codex");
    expect(contextSection()).toBeNull();
  });

  it("is not drawn for an agent session with no usage yet, and never shows zeroes", async () => {
    sessions([term("t-agent", "claude", "agent")], "t-agent");
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(getSessionUsage).toHaveBeenCalledWith("t-agent");
    expect(contextSection()).toBeNull();
    expect(screen.queryByText(/\$0\.00|0 \/ /)).toBeNull();
  });

  it("follows the focused pane: another agent's own figures, and folds away on a server", async () => {
    sessions(
      [term("t-a", "Test end to end", "agent"), term("t-b", "Plan", "agent"), term("t-srv", "API on 8090", "dev")],
      "t-a",
    );
    getSessionUsage.mockImplementation((id: string) =>
      Promise.resolve(id === "t-a" ? usage() : usage({ contextTokens: 30_000, spentUsd: 0.4, model: "claude-opus-5-5" })),
    );
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(within(contextSection()!).getByTestId("run-context-meter")).toHaveTextContent("148k / 1M");

    act(() => useTerminalsStore.setState({ activeByWs: { [WS]: "t-b" } }));
    // Before the new session's answer arrives, the first one's figures are
    // not shown under the second one's name.
    expect(contextSection()).toBeNull();
    await flush();
    const ctx = contextSection()!;
    expect(within(ctx).getByTestId("companion-section-meta")).toHaveTextContent("Plan");
    expect(within(ctx).getByTestId("run-context-meter")).toHaveTextContent("30k / 1M");
    expect(within(ctx).getByTestId("run-context-model")).toHaveTextContent("claude-opus-5-5");

    act(() => useTerminalsStore.setState({ activeByWs: { [WS]: "t-srv" } }));
    await flush();
    expect(contextSection()).toBeNull();

    // Back on the first: nothing is shown from memory; its figures return
    // with a fresh answer.
    act(() => useTerminalsStore.setState({ activeByWs: { [WS]: "t-a" } }));
    expect(contextSection()).toBeNull();
    await flush();
    expect(within(contextSection()!).getByTestId("run-context-meter")).toHaveTextContent("148k / 1M");
  });

  it("re-reads on a session event, a turn ending and a transcript ingest, never on a timer", async () => {
    sessions([term("t-a", "claude", "agent")], "t-a");
    getSessionUsage.mockResolvedValue(usage());
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(getSessionUsage).toHaveBeenCalledTimes(1);

    getSessionUsage.mockResolvedValue(usage({ contextTokens: 210_000, spentUsd: 3.05 }));
    act(() => onIngested());
    await flush();
    expect(getSessionUsage).toHaveBeenCalledTimes(2);
    expect(within(contextSection()!).getByTestId("run-context-meter")).toHaveTextContent("210k / 1M");
    expect(within(contextSection()!).getByTestId("run-context-spent")).toHaveTextContent("$3.05");

    // A turn ending is when a session's hooks say which terminal it runs
    // in: this terminal's own, or another's, which can lift a doubt here.
    act(() => onSettled("t-a"));
    await flush();
    expect(getSessionUsage).toHaveBeenCalledTimes(3);
    act(() => onSettled("t-other"));
    await flush();
    expect(getSessionUsage).toHaveBeenCalledTimes(4);
    // Claude Code's SessionStart / SessionEnd, in any terminal.
    act(() => onSessionChanged("t-a"));
    await flush();
    expect(getSessionUsage).toHaveBeenCalledTimes(5);
    expect(getSessionUsage).toHaveBeenLastCalledWith("t-a");
  });

  it("folds away the moment the session ends or is cleared, and when a read fails", async () => {
    sessions([term("t-a", "claude", "agent")], "t-a");
    getSessionUsage.mockResolvedValue(usage({ contextTokens: 900_000 }));
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(within(contextSection()!).getByTestId("run-context-warning")).toHaveTextContent("Past 80%");

    // `/clear` or `/exit`: the backend has no figures for the terminal now.
    getSessionUsage.mockResolvedValue(null);
    act(() => onSessionChanged("t-a"));
    await flush();
    expect(contextSection()).toBeNull();

    // A new conversation's first figures; then a read that fails: the
    // figures are cleared, not kept from before.
    getSessionUsage.mockResolvedValue(usage({ contextTokens: 4_000 }));
    act(() => onIngested());
    await flush();
    expect(within(contextSection()!).getByTestId("run-context-meter")).toHaveTextContent("4k / 1M");
    getSessionUsage.mockRejectedValue(new Error("db is locked"));
    act(() => onIngested());
    await flush();
    expect(contextSection()).toBeNull();
  });

  it("warns past 80% with the compaction line, and turns rouge past 95%", async () => {
    sessions([term("t-a", "claude", "agent")], "t-a");
    getSessionUsage.mockResolvedValue(usage({ contextTokens: 799_000 }));
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    const meter = () => within(contextSection()!).getByTestId("run-context-meter");
    const warning = () => within(contextSection()!).getByTestId("run-context-warning");
    expect(meter()).toHaveAttribute("data-tone", "ok");
    expect(warning().closest("[inert]")).not.toBeNull();

    getSessionUsage.mockResolvedValue(usage({ contextTokens: 800_000 }));
    act(() => onIngested());
    await flush();
    expect(meter()).toHaveAttribute("data-tone", "warning");
    expect(warning()).toHaveTextContent("Past 80% · /compact soon");
    expect(warning().closest("[inert]")).toBeNull();
    expect(warning().className).toContain("text-octo-warning");

    getSessionUsage.mockResolvedValue(usage({ contextTokens: 950_000 }));
    act(() => onIngested());
    await flush();
    expect(meter()).toHaveAttribute("data-tone", "rouge");
    expect(warning().closest("[inert]")).toBeNull();
  });

  it("drops the meter when the context size or the window is unknown, and keeps the rest", async () => {
    sessions([term("t-a", "claude", "agent")], "t-a");
    getSessionUsage.mockResolvedValue(usage({ contextTokens: null, cacheHitPct: null }));
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    const ctx = contextSection()!;
    expect(within(ctx).queryByTestId("run-context-meter")).toBeNull();
    expect(within(ctx).queryByTestId("run-context-cached")).toBeNull();
    expect(within(ctx).getByTestId("run-context-spent")).toHaveTextContent("$2.61");
    expect(within(ctx).getByTestId("run-context-model")).toHaveTextContent("claude-fable-5-2");

    // A model the catalog doesn't list: the prompt's size alone, no window, no warning.
    getSessionUsage.mockResolvedValue(usage({ contextTokens: 990_000, maxContext: null }));
    act(() => onIngested());
    await flush();
    const meter = within(contextSection()!).getByTestId("run-context-meter");
    expect(meter).toHaveTextContent("990k");
    expect(meter).not.toHaveTextContent("/");
    expect(within(contextSection()!).getByTestId("run-context-warning").closest("[inert]")).not.toBeNull();
  });

  it("never prints an unpriced session's cost as $0.00", () => {
    expect(spentLabel({ spentUsd: 0, calls: 3, unpricedCalls: 3 })).toBe("unpriced");
    expect(spentLabel({ spentUsd: 1.5, calls: 3, unpricedCalls: 1 })).toBe("$1.50 · partly unpriced");
    expect(spentLabel({ spentUsd: 1.5, calls: 3, unpricedCalls: 0 })).toBe("$1.50");
    expect(spentLabel({ spentUsd: 0.004, calls: 1, unpricedCalls: 0 })).toBe("$0.004");
  });

  it("remembers its fold like Talk's sections", async () => {
    sessions([term("t-a", "claude", "agent")], "t-a");
    getSessionUsage.mockResolvedValue(usage());
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    fireEvent.click(within(contextSection()!).getByRole("button", { name: /context/i }));
    expect(localStorage.getItem("octo.companion.section.run-context")).toBe("0");
    fireEvent.click(within(screen.getByTestId("companion-run-changes")).getByRole("button", { name: /changes/i }));
    expect(localStorage.getItem("octo.companion.section.run-changes")).toBe("0");
  });
});

describe("CompanionRun · Changes", () => {
  it("lists each uncommitted file with its status letter and line counts", () => {
    const files = [file("src/app.ts"), file("docs/plan.md", "new"), file("logo.png")];
    render(
      <CompanionRun workspaceId={WS} gitStatus={status(files)} changeStats={changeStats(DIFF)} onJumpToFile={vi.fn()} />,
    );
    const changes = screen.getByTestId("companion-run-changes");
    expect(within(changes).getByTestId("companion-section-meta")).toHaveTextContent("3 files · +3 −1");
    const rows = within(changes).getAllByTestId("run-change-row");
    expect(rows.map((r) => r.getAttribute("title"))).toEqual([
      "src/app.ts · open in Review",
      "docs/plan.md · open in Review",
      "logo.png · open in Review",
    ]);
    expect(rows[0]).toHaveTextContent("M");
    expect(rows[0]).toHaveTextContent("+2");
    expect(rows[0]).toHaveTextContent("−1");
    expect(rows[1]).toHaveTextContent("N");
    expect(rows[1]).toHaveTextContent("+1");
    expect(rows[1]).not.toHaveTextContent("−");
    // No lines known for it (binary): no invented count.
    expect(rows[2]).not.toHaveTextContent("+");
    expect(within(changes).queryByTestId("run-changes-more")).toBeNull();
    expect(within(changes).queryByTestId("run-changes-clean")).toBeNull();
  });

  it("shows eight rows, then +N more", () => {
    const files = Array.from({ length: 11 }, (_, i) => file(`src/file-${i}.ts`));
    render(<CompanionRun workspaceId={WS} gitStatus={status(files)} />);
    const changes = screen.getByTestId("companion-run-changes");
    expect(within(changes).getAllByTestId("run-change-row")).toHaveLength(8);
    expect(within(changes).getByTestId("run-changes-more")).toHaveTextContent("+3 more");
    expect(within(changes).getByTestId("companion-section-meta")).toHaveTextContent("11 files");
  });

  it("opens Review at the clicked file, and from the serif link", () => {
    const onJumpToFile = vi.fn();
    const onReadDiff = vi.fn();
    render(
      <CompanionRun
        workspaceId={WS}
        gitStatus={status([file("src/app.ts"), file("docs/plan.md", "new")])}
        changeStats={changeStats(DIFF)}
        onJumpToFile={onJumpToFile}
        onReadDiff={onReadDiff}
      />,
    );
    fireEvent.click(screen.getAllByTestId("run-change-row")[1]);
    expect(onJumpToFile).toHaveBeenCalledWith("docs/plan.md", null);
    const link = screen.getByRole("button", { name: "Read the diff" });
    expect(link.className).toContain("font-serif");
    fireEvent.click(link);
    expect(onReadDiff).toHaveBeenCalledTimes(1);
  });

  it("says a clean tree is clean, with the commits ahead of the base when there are any", () => {
    const onReadDiff = vi.fn();
    const { rerender } = render(<CompanionRun workspaceId={WS} gitStatus={status([])} onReadDiff={onReadDiff} />);
    const changes = screen.getByTestId("companion-run-changes");
    expect(within(changes).getByTestId("run-changes-clean")).toHaveTextContent("The working tree is clean.");
    expect(within(changes).queryByTestId("companion-section-meta")).toBeNull();
    expect(within(changes).queryByTestId("run-changes-ahead")).toBeNull();
    // Nothing to read in Review: no link.
    expect(screen.queryByRole("button", { name: "Read the diff" })).toBeNull();

    const ahead = { commits: 3, base: "main", mergeBase: "abc1234" };
    rerender(<CompanionRun workspaceId={WS} gitStatus={status([])} ahead={ahead} onReadDiff={onReadDiff} />);
    expect(within(changes).getByTestId("run-changes-ahead")).toHaveTextContent("3 commits ahead of main");
    expect(screen.getByRole("button", { name: "Read the diff" })).toBeInTheDocument();

    // Dirty again: the list, not the clean line; the count ahead belongs to the clean state.
    rerender(<CompanionRun workspaceId={WS} gitStatus={status([file("a.ts")])} ahead={ahead} onReadDiff={onReadDiff} />);
    expect(within(changes).queryByTestId("run-changes-clean")).toBeNull();
    expect(within(changes).queryByTestId("run-changes-ahead")).toBeNull();
  });

  it("claims nothing before the first status arrives", () => {
    render(<CompanionRun workspaceId={WS} gitStatus={null} onReadDiff={vi.fn()} />);
    expect(screen.getByTestId("run-changes-clean")).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Read the diff" })).toBeNull();
  });
});

describe("CompanionRun · Mission", () => {
  const mission = { id: "m-1", workspaceId: WS, projectId: "p", intent: "build", title: "Ship it" } as Mission;
  const row = (over: Partial<LogbookMissionRow> = {}): LogbookMissionRow => ({
    missionId: "m-1",
    title: "Ship it",
    intent: "build",
    status: "active",
    hoursSecs: 2 * 3600 + 10 * 60,
    costUsd: 4.2,
    savingsUsd: 1.1,
    runsCount: 0,
    messagesCount: 0,
    perSurface: [],
    ...over,
  });

  it("is not drawn for a workspace with no mission", async () => {
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(screen.queryByTestId("companion-run-mission")).toBeNull();
    expect(logbookSummary).not.toHaveBeenCalled();
  });

  it("shows the mission's worked time, spend and savings, and opens the Logbook", async () => {
    useMissionsStore.setState({ missionByWorkspaceId: { [WS]: mission } });
    logbookSummary.mockResolvedValue([row()]);
    const onOpenLogbook = vi.fn();
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} onOpenLogbook={onOpenLogbook} />);
    await flush();
    const section = screen.getByTestId("companion-run-mission");
    expect(logbookSummary).toHaveBeenCalledWith("mission", "m-1", expect.any(String), expect.any(String));
    expect(section).toHaveTextContent("Worked");
    expect(section).toHaveTextContent("2h 10m");
    expect(section).toHaveTextContent("$4.20");
    expect(section).toHaveTextContent("Saved");
    expect(section).toHaveTextContent("$1.10");
    fireEvent.click(within(section).getByRole("button", { name: "Open the Logbook" }));
    expect(onOpenLogbook).toHaveBeenCalledTimes(1);
  });

  it("says so when the mission has no work recorded, and leaves savings out when there are none", async () => {
    useMissionsStore.setState({ missionByWorkspaceId: { [WS]: mission } });
    const { unmount } = render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(screen.getByTestId("companion-run-mission")).toHaveTextContent("No work recorded yet.");
    unmount();

    logbookSummary.mockResolvedValue([row({ savingsUsd: 0 })]);
    render(<CompanionRun workspaceId={WS} gitStatus={status([])} />);
    await flush();
    expect(screen.getByTestId("companion-run-mission")).not.toHaveTextContent("Saved");
  });
});
