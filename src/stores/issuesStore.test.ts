import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Issue } from "../lib/types";

const mockIpc = { listMyIssues: vi.fn<() => Promise<Issue[]>>() };
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useIssuesStore } = await import("./issuesStore");

const ISSUES: Issue[] = [
  { key: "PROJ-123", summary: "Login", statusName: "In Progress", statusCategory: "inProgress", issueType: "Story", priority: "High", url: "u", parentKey: null },
];

beforeEach(() => {
  useIssuesStore.setState({ issues: null, loading: false, error: null });
  mockIpc.listMyIssues.mockReset();
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
});
