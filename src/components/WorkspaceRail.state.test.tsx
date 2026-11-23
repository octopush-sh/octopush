/**
 * The rail's state filter (Needs you · Working · Idle) and its
 * "merged · archive?" row action (#963).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Group, Pr, Workspace, WorkspaceGitSummary } from "../lib/types";

vi.mock("./Toasts", () => ({ pushToast: vi.fn() }));

import { WorkspaceRail, type ProjectGroup } from "./WorkspaceRail";
import { useGroupsStore } from "../stores/groupsStore";
import { useRunsStore } from "../stores/runsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAttentionStore } from "../stores/attentionStore";
import { GROUP_COLLAPSE_KEY, __reloadRailGroupUi } from "../stores/railGroupUiStore";

function ws(id: string, name: string, groupId: string | null = null): Workspace {
  return {
    id,
    projectId: "p1",
    name,
    task: "",
    branch: name,
    worktreePath: null,
    setupScript: "",
    status: "active",
    createdAt: "2026-11-01T00:00:00Z",
    lastActive: "2026-11-01T00:00:00Z",
    glyph: null,
    tint: null,
    linkedIssueKey: null,
    fromBranch: null,
    groupId,
  };
}

const FIXES: Group = {
  id: "g-fixes",
  scope: "workspace",
  projectId: "p1",
  name: "Fixes",
  tint: null,
  sortOrder: 0,
  createdAt: "2026-11-01T00:00:00Z",
};

/** main · [Fixes: fix-parser, fix-codec] · release-notes */
const MISSIONS = [ws("main", "main"), ws("w-parser", "fix-parser", FIXES.id), ws("w-codec", "fix-codec", FIXES.id), ws("w-notes", "release-notes")];
const PROJECTS: ProjectGroup[] = [
  { id: "p1", name: "Backend", workspaces: MISSIONS },
  { id: "p2", name: "Site", workspaces: [{ ...ws("w-site", "landing"), projectId: "p2" }] },
];

const MERGED: Pr = { number: 42, title: "Fix", url: "https://x/42", isDraft: false, state: "merged" };

function Rail(props: {
  running?: Record<string, boolean>;
  onArchiveMerged?: (id: string) => void;
  prByWs?: Record<string, Pr | null>;
  gitSummaryByWs?: Record<string, WorkspaceGitSummary>;
}) {
  return (
    <WorkspaceRail
      projects={PROJECTS}
      activeWorkspaceId="main"
      onSelect={vi.fn()}
      onCustomize={vi.fn()}
      isCollapsed={false}
      runningByWs={props.running}
      prByWs={props.prByWs}
      gitSummaryByWs={props.gitSummaryByWs}
      onArchiveMerged={props.onArchiveMerged}
    />
  );
}

const shown = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-rail-ws]")).map((el) => el.dataset.railWs);

const pickState = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: /missions/i }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }));
};

beforeEach(() => {
  localStorage.removeItem(GROUP_COLLAPSE_KEY);
  __reloadRailGroupUi();
  useGroupsStore.setState({ groups: [FIXES], loaded: true });
  useAttentionStore.setState({ flagsByWs: {} });
  useWorkspaceStore.setState({ workspacesByProjectId: { p1: MISSIONS }, mergedPrByWs: {}, gitSummaryByWs: {}, prByWs: {} });
  useRunsStore.setState({
    runsByWs: {
      // A crew at a gate: needs you.
      "w-parser": [{ id: "r1", status: "paused", planWait: null }] as never,
      // A crew parked on a Claude plan with a resume scheduled: in flight.
      "w-notes": [{ id: "r2", status: "paused", planWait: { resumeAt: "2026-11-22T10:00:00Z", otherHold: false } }] as never,
    },
  });
});
afterEach(() => {
  useGroupsStore.setState({ groups: [], loaded: false });
  useRunsStore.setState({ runsByWs: {} });
  useWorkspaceStore.setState({ workspacesByProjectId: {}, mergedPrByWs: {} });
});

describe("rail: the state filter", () => {
  it("shows every mission until a state is picked", () => {
    render(<Rail />);
    expect(shown()).toEqual(["main", "w-parser", "w-codec", "w-notes", "w-site"]);
    expect(screen.getByRole("button", { name: "Show missions by state" })).toBeInTheDocument();
  });

  it("Needs you keeps the missions whose crew needs you, in their group, and drops empty projects", () => {
    render(<Rail />);
    pickState("Needs you");
    expect(shown()).toEqual(["w-parser"]);
    expect(screen.getByRole("button", { name: /^Fixes/ })).toBeInTheDocument();
    expect(screen.queryByText("Site")).toBeNull();
    // The narrowed rail says so on its search line.
    expect(screen.getByRole("button", { name: "Showing missions: Needs you" })).toHaveTextContent("Needs you");
  });

  it("Working counts the marching edge and a plan-parked crew; Idle is the rest", () => {
    render(<Rail running={{ "w-site": true }} />);
    pickState("Working");
    expect(shown()).toEqual(["w-notes", "w-site"]);
    pickState("Idle");
    expect(shown()).toEqual(["main", "w-codec"]);
  });

  it("lists how many missions are in each state", () => {
    render(<Rail />);
    fireEvent.click(screen.getByRole("button", { name: /missions/i }));
    expect(screen.getByRole("menuitemradio", { name: /^Needs you/ })).toHaveTextContent("1");
    expect(screen.getByRole("menuitemradio", { name: /^Idle/ })).toHaveTextContent("3");
    expect(screen.getByRole("menuitemradio", { name: "Every mission" })).toHaveAttribute("aria-checked", "true");
  });

  it("says when no mission is in the state, and Every mission brings them back", () => {
    useRunsStore.setState({ runsByWs: {} });
    render(<Rail />);
    pickState("Needs you");
    expect(shown()).toEqual([]);
    expect(screen.getByText("No mission needs you")).toBeInTheDocument();
    pickState("Every mission");
    expect(shown()).toHaveLength(5);
  });

  it("holds folded groups open while it narrows the rail", () => {
    render(<Rail />);
    fireEvent.click(screen.getByRole("button", { name: /^Fixes/ }));
    pickState("Needs you");
    const row = screen.getByTestId(`rail-group-${FIXES.id}`).querySelector('[data-rail-ws="w-parser"]');
    expect(row).not.toBeNull();
    expect(row!.closest("[inert]")).toBeNull();
  });
});

describe("rail: merged · archive?", () => {
  it("offers to archive an idle mission whose PR is merged and worktree clean", () => {
    useWorkspaceStore.setState({ mergedPrByWs: { "w-codec": MERGED } });
    const onArchiveMerged = vi.fn();
    render(<Rail onArchiveMerged={onArchiveMerged} />);
    const action = screen.getByRole("button", { name: "Merged — archive fix-codec" });
    expect(action).toHaveTextContent("merged · archive?");
    expect(action.title).toContain("PR #42");
    fireEvent.click(action);
    expect(onArchiveMerged).toHaveBeenCalledWith("w-codec");
  });

  it("holds back while the mission works, needs you, changed or has an open PR again", () => {
    useWorkspaceStore.setState({
      mergedPrByWs: { "w-parser": MERGED, "w-notes": MERGED, "w-codec": MERGED, main: MERGED, "w-site": MERGED },
    });
    render(
      <Rail
        onArchiveMerged={vi.fn()}
        running={{ "w-site": true }}
        gitSummaryByWs={{ "w-codec": { workspaceId: "w-codec", dirty: true, ahead: 0, behind: 0 } }}
        prByWs={{ main: { ...MERGED, state: "open" } }}
      />,
    );
    expect(screen.queryByText("merged · archive?")).toBeNull();
  });

  it("is not drawn without a handler", () => {
    useWorkspaceStore.setState({ mergedPrByWs: { "w-codec": MERGED } });
    render(<Rail />);
    expect(screen.queryByText("merged · archive?")).toBeNull();
  });
});
