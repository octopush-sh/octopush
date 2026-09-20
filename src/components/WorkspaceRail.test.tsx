import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { WorkspaceRail, resolveAttention, type ProjectGroup } from "./WorkspaceRail";
import { useAttentionStore } from "../stores/attentionStore";
import { useMissionsStore } from "../stores/missionsStore";
import type { Workspace, Mission } from "../lib/types";

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "m-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    intent: "build",
    title: "t",
    status: "active",
    linkedIssueKey: null,
    gitIsolation: "worktree",
    execIsolation: "none",
    payload: "{}",
    createdAt: "2026-05-16T00:00:00Z",
    updatedAt: "2026-05-16T00:00:00Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    projectId: "proj-1",
    name: "Auth refactor",
    task: "",
    branch: "feat/auth",
    worktreePath: null,
    setupScript: "",
    status: "active",
    createdAt: "2026-05-16T00:00:00Z",
    lastActive: "2026-05-16T00:00:00Z",
    glyph: null,
    tint: null,
    linkedIssueKey: null,
    fromBranch: null,
    ...overrides,
  };
}

afterEach(() => {
  useAttentionStore.setState({ flagsByWs: {} });
  useMissionsStore.setState({ missionsByProjectId: {}, missionByWorkspaceId: {} });
  // Per-project fold state persists in localStorage; a folded project hides
  // its rows from the accessibility tree, so never let one test fold the next.
  localStorage.removeItem("railProjectCollapsed");
});

describe("WorkspaceRail", () => {
  it("renders one button per workspace", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
      makeWorkspace({ id: "c", name: "Gamma" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    const workspaceButtons = screen
      .getAllByRole("button")
      .filter((b) =>
        workspaces.some((ws) => ws.name === b.getAttribute("aria-label")),
      );
    expect(workspaceButtons).toHaveLength(workspaces.length);
  });

  it("renders the workspace monogram glyph", () => {
    const workspaces = [makeWorkspace({ name: "Hyperion" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="ws-1"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    expect(screen.getByText("H")).toBeInTheDocument();
  });

  it("calls onSelect with the workspace id on click", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const onSelect = vi.fn();
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={onSelect}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("B"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("calls onCustomize with the workspace id on right-click when no onContextMenu provided", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const onCustomize = vi.fn();
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={onCustomize}
      />,
    );
    fireEvent.contextMenu(screen.getByText("A"));
    expect(onCustomize).toHaveBeenCalledWith("a");
  });

  it("calls onContextMenu with workspace id and coords on right-click when provided", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const onContextMenu = vi.fn();
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        onContextMenu={onContextMenu}
      />,
    );
    fireEvent.contextMenu(screen.getByText("A"), { clientX: 50, clientY: 80 });
    expect(onContextMenu).toHaveBeenCalledWith("a", 50, 80);
  });

  it("renders at 280px expanded and at the Run session rail's 44px when collapsed", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const { container, rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    const aside = container.querySelector("aside");
    expect(aside).toHaveClass("w-[280px]");

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
      />,
    );
    expect(aside).toHaveClass("w-[44px]");
  });

  it("renders project headers as serif index lines in expanded mode", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Frontend", workspaces: [workspaces[0]] },
      { id: "proj-2", name: "Backend", workspaces: [workspaces[1]] },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    expect(screen.getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();

    const headers = screen.getAllByTestId("project-header");
    expect(headers).toHaveLength(2);

    // The project name is the serif "name of a thing" voice — never a mono
    // eyebrow, never uppercase. Ivory marks the project holding the active
    // workspace; every other project reads in sage.
    const frontend = headers.find((h) => h.textContent === "Frontend");
    expect(frontend).toHaveClass("font-serif");
    expect(frontend).not.toHaveClass("uppercase");
    expect(frontend).toHaveClass("text-octo-ivory");
    const backend = headers.find((h) => h.textContent === "Backend");
    expect(backend).toHaveClass("font-serif");
    expect(backend).toHaveClass("text-octo-sage");
  });

  it("should hide project headers when collapsed", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Frontend", workspaces: [workspaces[0]] },
      { id: "proj-2", name: "Backend", workspaces: [workspaces[1]] },
    ];
    const { rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    expect(screen.getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
      />,
    );

    expect(screen.queryByText("Frontend")).not.toBeInTheDocument();
    expect(screen.queryByText("Backend")).not.toBeInTheDocument();
    // Collapsed, each cluster is headed by the project's mark, named for AT.
    expect(screen.getByRole("img", { name: "Frontend" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Backend" })).toBeInTheDocument();
  });

  it("shows a bare 20px glyph expanded and a 32px cell collapsed — no bordered tile in either", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Hyperion" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const { rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    const expanded = screen.getByLabelText("Hyperion");
    expect(expanded.textContent).toBe("H");
    expect(expanded).toHaveClass("h-5", "w-5");
    expect(expanded.className).not.toMatch(/border/);

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
      />,
    );

    const cell = screen.getByLabelText("Hyperion");
    expect(cell.textContent).toBe("H");
    expect(cell).toHaveClass("h-8");
    expect(cell.className).not.toMatch(/border/);
  });

  it("should render workspace names only in expanded mode", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    const { rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    expect(screen.getByText("Alpha")).toBeInTheDocument();

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
      />,
    );

    // Collapsed, the name lives in the cell's accessible name (and the hover
    // flyout) — there is no visible text and no native title to double it.
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    const cell = screen.getByLabelText("Alpha");
    expect(cell).not.toHaveAttribute("title");
  });

  it("renders unboxed meta for ticket, ahead count, open PR and uncommitted changes", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha", linkedIssueKey: "GUIDE-42" }),
    ];
    const projects: ProjectGroup[] = [{ id: "proj-1", name: "Project", workspaces }];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="z" /* not active, so the dirty glyph can show */
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        gitSummaryByWs={{ a: { dirty: true, ahead: 90, behind: 0 } as never }}
        prByWs={{ a: { number: 7 } as never }}
      />,
    );
    expect(screen.getByText("GUIDE-42")).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByTitle(/open pull request/i)).toBeInTheDocument();
    expect(screen.getByTitle("Uncommitted changes")).toBeInTheDocument();
    // No chip boxes anywhere in the row: the meta is plain mono ink.
    const row = screen.getByText("GUIDE-42").closest("div");
    expect(row?.className).not.toMatch(/border/);
  });

  it("hides the dirty glyph on the active row (the ContextHeader carries it there)", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [{ id: "proj-1", name: "Project", workspaces }];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        gitSummaryByWs={{ a: { dirty: true, ahead: 0, behind: 0 } as never }}
      />,
    );
    expect(screen.queryByTitle("Uncommitted changes")).not.toBeInTheDocument();
  });

  it("shows project aggregates only while the project is folded", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
    ];
    const projects: ProjectGroup[] = [{ id: "proj-1", name: "Project", workspaces }];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        gitSummaryByWs={{ a: { dirty: true } as never, b: { dirty: true } as never }}
        prByWs={{ a: { number: 1 } as never }}
      />,
    );
    // Expanded: the rows already show it, so the header stays quiet (the
    // aggregate line is mounted for the fade but hidden from everyone).
    const dirtyAgg = screen.getByTitle(/2 missions with uncommitted changes/i);
    const prAgg = screen.getByTitle(/1 open pr/i);
    const line = dirtyAgg.parentElement!;
    expect(line).toHaveAttribute("aria-hidden", "true");
    expect(line).toHaveClass("opacity-0", "max-w-0"); // takes no width while open
    expect(line.textContent).toContain("2 missions");
    expect(prAgg.parentElement).toBe(line);

    // Fold the project from its name — the one keyboard-reachable control
    // (the chevron is pointer decoration): the aggregates are what remains of
    // the hidden rows.
    const nameToggle = screen.getByRole("button", { name: "Project", expanded: true });
    fireEvent.click(nameToggle);
    expect(nameToggle).toHaveAttribute("aria-expanded", "false");
    expect(nameToggle).toHaveAttribute("title", "Expand Project");
    expect(line).toHaveAttribute("aria-hidden", "false");
    expect(line).toHaveClass("opacity-100");
    // Exactly one tab stop folds a project: the chevron is aria-hidden and not a button.
    expect(screen.queryByRole("button", { name: /Collapse Project|Expand Project/ })).not.toBeInTheDocument();
  });

  it("does not offer folding while a filter holds every project open, and never flips stored state", () => {
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces: [makeWorkspace({ id: "a", name: "Alpha" })] },
    ];
    render(
      <WorkspaceRail projects={projects} activeWorkspaceId="a" onSelect={vi.fn()} isCollapsed={false} onCustomize={vi.fn()} />,
    );
    // Fold, then filter: the project is forced open for the hits.
    fireEvent.click(screen.getByRole("button", { name: "Project", expanded: true }));
    expect(screen.getByRole("button", { name: "Project", expanded: false })).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Find a project or mission" });
    fireEvent.change(input, { target: { value: "al" } });
    const header = screen.getByRole("button", { name: "Project" });
    expect(header).not.toHaveAttribute("aria-expanded");
    expect(header).not.toHaveAttribute("title");
    expect(screen.getByLabelText("Alpha")).toBeInTheDocument(); // the row is shown (its name is split by the wash)
    expect(screen.queryByTitle(/Collapse Project|Expand Project/)).not.toBeInTheDocument();
    // Clicking the name while filtering is a no-op on the stored fold state…
    fireEvent.click(header);
    fireEvent.change(input, { target: { value: "" } });
    // …so clearing the filter restores the fold exactly as it was left.
    expect(screen.getByRole("button", { name: "Project", expanded: false })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("railProjectCollapsed") ?? "{}")).toEqual({ "proj-1": true });
  });

  it("marks the active row with the brass edge, brass-ghost ground and aria-current", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
    ];
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );

    const alpha = screen.getByLabelText("Alpha");
    expect(alpha).toHaveAttribute("aria-current", "location");
    const row = alpha.parentElement!;
    expect(row).toHaveClass("bg-[var(--brass-ghost)]");
    expect(row.querySelector(".bg-octo-brass")).not.toBeNull();

    // A non-active row carries neither brass nor its tint on the edge.
    const beta = screen.getByLabelText("Beta");
    expect(beta).not.toHaveAttribute("aria-current");
    const betaRow = beta.parentElement!;
    expect(betaRow.querySelector(".bg-octo-brass")).toBeNull();
    expect(betaRow.querySelector(".bg-transparent")).not.toBeNull();
  });

  it("shows the marching processing bar when a workspace is running", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [{ id: "proj-1", name: "Project", workspaces }];
    const { container, rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="z"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        runningByWs={{}}
      />,
    );
    // Not running → no processing bar.
    expect(container.querySelector("[data-running-bar]")).toBeNull();

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="z"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        runningByWs={{ a: true }}
      />,
    );
    // Running → the marching bar appears, and the tooltip reflects it.
    expect(container.querySelector("[data-running-bar]")).not.toBeNull();
    expect(screen.getByTitle(/Alpha — working/i)).toBeInTheDocument();
  });

  it("suppresses the attention pulse while a workspace is running (mutually exclusive)", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [{ id: "proj-1", name: "Project", workspaces }];
    useAttentionStore.setState({ flagsByWs: { a: { kind: "chat", at: Date.now() } } });

    const { container, rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="z"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        runningByWs={{}}
      />,
    );
    // Flag present, not running → the monogram pulses.
    expect(container.querySelector(".animate-attention-pulse")).not.toBeNull();

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="z"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        runningByWs={{ a: true }}
      />,
    );
    // Running wins: the bar marches, the pulse is gone.
    expect(container.querySelector("[data-running-bar]")).not.toBeNull();
    expect(container.querySelector(".animate-attention-pulse")).toBeNull();
  });

  it("marches in the collapsed rail too, so running suppresses the pulse there as well", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [{ id: "proj-1", name: "Project", workspaces }];
    useAttentionStore.setState({ flagsByWs: { a: { kind: "chat", at: Date.now() } } });

    const { container } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="z"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
        runningByWs={{ a: true }}
      />,
    );
    // The collapsed cell has the same identity edge, so the same rule holds.
    expect(container.querySelector("[data-running-bar]")).not.toBeNull();
    expect(container.querySelector(".animate-attention-pulse")).toBeNull();
  });

  it("pulses exactly one workspace — the one waiting longest — and dots the rest", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Alpha" }),
      makeWorkspace({ id: "b", name: "Beta" }),
      makeWorkspace({ id: "c", name: "Gamma" }),
    ];
    const projects: ProjectGroup[] = [{ id: "proj-1", name: "Project", workspaces }];
    useAttentionStore.setState({
      flagsByWs: {
        a: { kind: "chat", at: 2_000 },
        b: { kind: "terminal", at: 1_000 }, // oldest → the beacon
        c: { kind: "chat", at: 3_000 },
      },
    });
    const { container } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="z"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    const pulsing = container.querySelectorAll(".animate-attention-pulse");
    expect(pulsing).toHaveLength(1);
    expect(pulsing[0]).toHaveAttribute("aria-label", "Beta — needs attention");
    // The other two carry the static brass dot, never a second pulse.
    expect(screen.getAllByRole("img", { name: "Needs your attention" })).toHaveLength(2);
    expect(screen.getByLabelText("Alpha — needs attention")).toBeInTheDocument();
    expect(screen.getByTitle(/Gamma — needs your attention \(chat\)/)).toBeInTheDocument();
  });

  it("never signals attention on the active workspace", () => {
    const workspaces = [makeWorkspace({ id: "a", name: "Alpha" })];
    const projects: ProjectGroup[] = [{ id: "proj-1", name: "Project", workspaces }];
    useAttentionStore.setState({ flagsByWs: { a: { kind: "chat", at: 1 } } });
    const { container } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    expect(container.querySelector(".animate-attention-pulse")).toBeNull();
    expect(screen.queryByRole("img", { name: "Needs your attention" })).not.toBeInTheDocument();
  });

  it("carries the mission posture in the monogram's tooltip — no glyph slot", () => {
    useMissionsStore.setState({
      missionsByProjectId: {},
      missionByWorkspaceId: {
        "ws-1": makeMission({
          workspaceId: "ws-1",
          intent: "probe",
          gitIsolation: "readonly",
          execIsolation: "sandbox",
        }),
      },
    });
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces: [makeWorkspace({ id: "ws-1", name: "Alpha" })] },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="ws-1"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    const monogram = screen.getByTitle("probe mission · read-only · sandboxed");
    expect(monogram).toBe(screen.getByLabelText("Alpha"));
    expect(monogram.textContent).toBe("A");
    expect(monogram.querySelectorAll("svg")).toHaveLength(0);
  });

  it("folds the qualifiers into the posture only when they apply", () => {
    useMissionsStore.setState({
      missionsByProjectId: {},
      missionByWorkspaceId: {
        "ws-1": makeMission({ workspaceId: "ws-1", intent: "fix" }),
        "ws-2": makeMission({ id: "m-2", workspaceId: "ws-2", intent: "build", execIsolation: "sandbox" }),
      },
    });
    const projects: ProjectGroup[] = [
      {
        id: "proj-1",
        name: "Project",
        workspaces: [
          makeWorkspace({ id: "ws-1", name: "Alpha" }),
          makeWorkspace({ id: "ws-2", name: "Beta" }),
          makeWorkspace({ id: "ws-3", name: "Gamma" }),
        ],
      },
    ];
    render(
      <WorkspaceRail projects={projects} activeWorkspaceId="ws-1" onSelect={vi.fn()} isCollapsed={false} onCustomize={vi.fn()} />,
    );
    expect(screen.getByTitle("fix mission")).toBe(screen.getByLabelText("Alpha"));
    expect(screen.getByTitle("build mission · sandboxed")).toBe(screen.getByLabelText("Beta"));
    // No mission → no tooltip at all on the glyph (the name sits right beside it).
    expect(screen.getByLabelText("Gamma")).not.toHaveAttribute("title");
  });

  it("shows the 'No missions yet' empty state for a project with no rows", () => {
    const projects: ProjectGroup[] = [{ id: "proj-1", name: "Project", workspaces: [] }];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId={null}
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    expect(screen.getByText("No missions yet")).toBeInTheDocument();
  });

  it("puts 'Add project' in the head line as the one icon action, expanded and collapsed", () => {
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Project", workspaces: [makeWorkspace({ id: "a", name: "Alpha" })] },
    ];
    const onAddProject = vi.fn();
    const { rerender } = render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        onAddProject={onAddProject}
      />,
    );
    const add = screen.getByLabelText("Add project");
    expect(add).toHaveAttribute("title", "Add project");
    expect(add.textContent).toBe(""); // icon only — no "Add project" label text
    fireEvent.click(add);
    expect(onAddProject).toHaveBeenCalledTimes(1);

    rerender(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
        onAddProject={onAddProject}
      />,
    );
    fireEvent.click(screen.getByLabelText("Add project"));
    expect(onAddProject).toHaveBeenCalledTimes(2);
  });

  it("filters projects and missions from the search line, washing the hit", () => {
    const projects: ProjectGroup[] = [
      {
        id: "proj-1",
        name: "Frontend",
        workspaces: [
          makeWorkspace({ id: "a", name: "Alpha" }),
          makeWorkspace({ id: "b", name: "Gamma" }),
        ],
      },
      { id: "proj-2", name: "Backend", workspaces: [makeWorkspace({ id: "c", name: "Delta" })] },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Find a project or mission" });
    expect(input).toHaveAttribute("placeholder", "Find a project or mission");

    fireEvent.change(input, { target: { value: "amm" } });
    // Only Gamma survives; Backend (no hit anywhere) leaves the rail.
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("Backend")).not.toBeInTheDocument();
    expect(screen.getByText("Frontend")).toBeInTheDocument();
    const hit = screen.getByTestId("rail-hit");
    expect(hit.textContent).toBe("amm");
    expect(screen.getByLabelText("Gamma")).toBeInTheDocument();

    // A project-name hit keeps all of that project's missions.
    fireEvent.change(input, { target: { value: "back" } });
    expect(screen.getByText("Delta")).toBeInTheDocument();
    expect(screen.queryByText("Frontend")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();

    // Regex metacharacters are literal, and the hit is located on the name
    // itself (never on a lowercased copy whose length can differ).
    fireEvent.change(input, { target: { value: "c++ (" } });
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "ALPH" } });
    expect(screen.getByTestId("rail-hit").textContent).toBe("Alph");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Delta")).toBeInTheDocument();
  });

  it("names the ⌘N jump in the row tooltip only for rows the owner mapped", () => {
    const projects: ProjectGroup[] = [
      {
        id: "proj-1",
        name: "Project",
        workspaces: [makeWorkspace({ id: "a", name: "Alpha" }), makeWorkspace({ id: "b", name: "Beta" })],
      },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="a"
        onSelect={vi.fn()}
        isCollapsed={false}
        onCustomize={vi.fn()}
        shortcutByWs={{ a: "⌘1" }}
      />,
    );
    expect(screen.getByTitle("Alpha (⌘1)")).toBeInTheDocument();
    expect(screen.getByTitle("Beta")).toBeInTheDocument();
  });

  it("opens a flyout with project · name · status · ⌘N on a collapsed cell, and lets it go on leave", () => {
    vi.useFakeTimers();
    try {
      const projects: ProjectGroup[] = [
        {
          id: "proj-1",
          name: "Frontend",
          workspaces: [makeWorkspace({ id: "a", name: "Alpha", linkedIssueKey: "GUIDE-7" })],
        },
      ];
      render(
        <WorkspaceRail
          projects={projects}
          activeWorkspaceId="z"
          onSelect={vi.fn()}
          isCollapsed={true}
          onCustomize={vi.fn()}
          gitSummaryByWs={{ a: { dirty: true, ahead: 2, behind: 0 } as never }}
          prByWs={{ a: { number: 3 } as never }}
          shortcutByWs={{ a: "⌘1" }}
        />,
      );
      expect(screen.queryByTestId("rail-flyout-a")).not.toBeInTheDocument();

      const cell = screen.getByLabelText("Alpha");
      fireEvent.mouseEnter(cell.parentElement!);
      const fly = screen.getByTestId("rail-flyout-a");
      expect(fly).toHaveClass("octo-menu-enter");
      expect(fly.textContent).toContain("Frontend");
      expect(fly.textContent).toContain("Alpha");
      expect(fly.textContent).toContain("GUIDE-7 · ↑2 · PR open · uncommitted changes");
      expect(fly.textContent).toContain("⌘1");

      // Leaving starts a short grace period; re-entering the flyout cancels it.
      fireEvent.mouseLeave(cell.parentElement!);
      fireEvent.mouseEnter(fly);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByTestId("rail-flyout-a")).toBeInTheDocument();

      fireEvent.mouseLeave(fly);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByTestId("rail-flyout-a")).not.toBeInTheDocument();

      // Keyboard focus opens it too; blurring out of the cell closes it at once.
      fireEvent.focus(cell);
      expect(screen.getByTestId("rail-flyout-a")).toBeInTheDocument();
      fireEvent.blur(cell.parentElement!, { relatedTarget: document.body });
      expect(screen.queryByTestId("rail-flyout-a")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a keyboard-opened flyout while the pointer wanders, until the cell blurs", () => {
    vi.useFakeTimers();
    try {
      const projects: ProjectGroup[] = [
        { id: "proj-1", name: "Frontend", workspaces: [makeWorkspace({ id: "a", name: "Alpha" })] },
      ];
      render(
        <WorkspaceRail projects={projects} activeWorkspaceId="z" onSelect={vi.fn()} isCollapsed={true} onCustomize={vi.fn()} />,
      );
      const cell = screen.getByRole("button", { name: "Alpha" });
      // Real focus (so `document.activeElement` is the cell) plus the React
      // focus event jsdom's `focus()` does not always deliver.
      cell.focus();
      fireEvent.focus(cell);
      expect(document.activeElement).toBe(cell);
      expect(screen.getByTestId("rail-flyout-a")).toBeInTheDocument();
      fireEvent.mouseLeave(cell.parentElement!);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByTestId("rail-flyout-a")).toBeInTheDocument();
      fireEvent.blur(cell.parentElement!, { relatedTarget: document.body });
      expect(screen.queryByTestId("rail-flyout-a")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about git in the flyout until the summary has arrived — never a false 'clean'", () => {
    const projects: ProjectGroup[] = [
      {
        id: "proj-1",
        name: "Frontend",
        workspaces: [makeWorkspace({ id: "a", name: "Alpha" }), makeWorkspace({ id: "b", name: "Beta" })],
      },
    ];
    render(
      <WorkspaceRail
        projects={projects}
        activeWorkspaceId="z"
        onSelect={vi.fn()}
        isCollapsed={true}
        onCustomize={vi.fn()}
        gitSummaryByWs={{ b: { dirty: false, ahead: 0, behind: 0 } as never }}
      />,
    );
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Alpha" }).parentElement!);
    expect(screen.getByTestId("rail-flyout-a").textContent).not.toContain("clean");
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Beta" }).parentElement!);
    expect(screen.getByTestId("rail-flyout-b").textContent).toContain("clean");
  });

  it("keeps the flyout inside the viewport when the cell sits near the window's bottom", () => {
    const projects: ProjectGroup[] = [
      { id: "proj-1", name: "Frontend", workspaces: [makeWorkspace({ id: "a", name: "Alpha" })] },
    ];
    render(
      <WorkspaceRail projects={projects} activeWorkspaceId="z" onSelect={vi.fn()} isCollapsed={true} onCustomize={vi.fn()} />,
    );
    const cell = screen.getByRole("button", { name: "Alpha" });
    // jsdom has no layout: fake a cell 20px above the bottom and a 64px panel.
    const innerHeight = window.innerHeight;
    cell.getBoundingClientRect = () =>
      ({ top: innerHeight - 20, bottom: innerHeight + 12, left: 0, right: 44, width: 44, height: 32 }) as DOMRect;
    const proto = HTMLDivElement.prototype;
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLDivElement) {
      if (this.dataset.testid === "rail-flyout-a") return { height: 64, width: 212 } as DOMRect;
      return original.call(this);
    };
    try {
      fireEvent.focus(cell);
      const fly = screen.getByTestId("rail-flyout-a");
      expect(parseFloat(fly.style.top)).toBeLessThanOrEqual(innerHeight - 64 - 8);
      expect(fly.style.left).toBe("52px");
    } finally {
      proto.getBoundingClientRect = original;
    }
  });
});

describe("resolveAttention — the rail's single beacon", () => {
  const projects: ProjectGroup[] = [
    {
      id: "p",
      name: "P",
      workspaces: [
        makeWorkspace({ id: "a", name: "A" }),
        makeWorkspace({ id: "b", name: "B" }),
        makeWorkspace({ id: "c", name: "C" }),
      ],
    },
  ];

  it("is empty with no flags", () => {
    expect(resolveAttention(projects, {}, null, {})).toEqual({});
  });

  it("gives the beacon to the oldest flag and a dot to every other", () => {
    const out = resolveAttention(
      projects,
      { a: { kind: "chat", at: 30 }, b: { kind: "chat", at: 10 }, c: { kind: "chat", at: 20 } },
      null,
      {},
    );
    expect(out).toEqual({ a: "dot", b: "beacon", c: "dot" });
  });

  it("measures the wait from `since` (the first ping), never from the latest `at`", () => {
    const out = resolveAttention(
      projects,
      { a: { kind: "chat", at: 50, since: 5 }, b: { kind: "chat", at: 10 } },
      null,
      {},
    );
    // a rang again recently (at 50) but has been waiting since 5 — it keeps the beacon.
    expect(out).toEqual({ a: "beacon", b: "dot" });
  });

  it("skips the active workspace and running ones, handing the beacon on", () => {
    const flags = { a: { kind: "chat" as const, at: 1 }, b: { kind: "chat" as const, at: 2 }, c: { kind: "chat" as const, at: 3 } };
    expect(resolveAttention(projects, flags, "a", { b: true })).toEqual({ c: "beacon" });
    expect(resolveAttention(projects, flags, "a", {})).toEqual({ b: "beacon", c: "dot" });
  });

  it("ignores flags for workspaces that are not in the rail", () => {
    expect(resolveAttention(projects, { ghost: { kind: "chat", at: 1 } }, null, {})).toEqual({});
  });
});
