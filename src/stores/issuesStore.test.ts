import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Issue, ProjectIssueTracker } from "../lib/types";

const mockIpc = {
  listMyIssues: vi.fn<(projectId?: string | null) => Promise<Issue[]>>(),
  getProjectIssueTracker: vi.fn<(projectId: string) => Promise<ProjectIssueTracker>>(),
};
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useIssuesStore } = await import("./issuesStore");

const ISSUES: Issue[] = [
  { key: "PROJ-123", summary: "Login", statusName: "In Progress", statusCategory: "inProgress", issueType: "Story", priority: "High", url: "u", parentKey: null, subtask: false, hierarchyLevel: 0 },
];

const EPIKU: ProjectIssueTracker = { choice: "epiku", epikuProject: null, active: "epiku" };
const JIRA: ProjectIssueTracker = { choice: null, epikuProject: null, active: "jira" };

beforeEach(() => {
  useIssuesStore.setState({ issues: null, loading: false, error: null, projectId: null, tracker: null, scope: null, detailByKey: {} });
  mockIpc.listMyIssues.mockReset();
  mockIpc.getProjectIssueTracker.mockReset();
});

describe("issuesStore", () => {
  it("load() sets issues on success", async () => {
    mockIpc.listMyIssues.mockResolvedValue(ISSUES);
    await useIssuesStore.getState().load();
    expect(useIssuesStore.getState().issues).toEqual(ISSUES);
    expect(useIssuesStore.getState().error).toBeNull();
  });
  it("load() sets error on failure and keeps last issues", async () => {
    useIssuesStore.setState({ issues: ISSUES });
    mockIpc.listMyIssues.mockRejectedValue(new Error("boom"));
    await useIssuesStore.getState().load();
    expect(useIssuesStore.getState().error).toBeTruthy();
    expect(useIssuesStore.getState().issues).toEqual(ISSUES); // last good kept
  });

  it("setProject reads the project's tracker and empties the caches when the scope changes", async () => {
    useIssuesStore.setState({ issues: ISSUES, scope: "jira", detailByKey: { "PROJ-123": ISSUES[0] } });
    mockIpc.getProjectIssueTracker.mockResolvedValue(EPIKU);
    await useIssuesStore.getState().setProject("p1");
    const s = useIssuesStore.getState();
    expect([s.projectId, s.tracker, s.scope]).toEqual(["p1", "epiku", "epiku:p1"]);
    expect(s.issues).toBeNull();
    expect(s.detailByKey).toEqual({});
    expect(s.trackerByProject.p1).toEqual(EPIKU);
    mockIpc.listMyIssues.mockResolvedValue(ISSUES);
    await s.load();
    expect(mockIpc.listMyIssues).toHaveBeenCalledWith("p1");
  });
  it("keeps the one Jira list across two Jira projects", async () => {
    useIssuesStore.setState({ issues: ISSUES, scope: "jira", projectId: "p1", tracker: "jira" });
    mockIpc.getProjectIssueTracker.mockResolvedValue(JIRA);
    await useIssuesStore.getState().setProject("p2");
    expect(useIssuesStore.getState().issues).toEqual(ISSUES);
    expect(useIssuesStore.getState().projectId).toBe("p2");
  });
  it("drops an answer for a project the user has left", async () => {
    let answer: (v: Issue[]) => void = () => {};
    mockIpc.listMyIssues.mockReturnValue(new Promise((r) => (answer = r)));
    useIssuesStore.setState({ scope: "jira", projectId: "p1", tracker: "jira" });
    const pending = useIssuesStore.getState().load();
    mockIpc.getProjectIssueTracker.mockResolvedValue(EPIKU);
    await useIssuesStore.getState().setProject("p2");
    answer(ISSUES);
    await pending;
    expect(useIssuesStore.getState().issues).toBeNull();
    expect(useIssuesStore.getState().loading).toBe(false);
  });
});
