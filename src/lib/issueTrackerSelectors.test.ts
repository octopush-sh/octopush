import { describe, it, expect } from "vitest";
import {
  resolveLinkage,
  resolveJiraProjectKey,
  selectBacklog,
  selectElsewhereCount,
} from "./issueTrackerSelectors";
import type { Issue, ProjectInfo, Workspace } from "./types";

function ws(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    projectId: "p1",
    name: "ws",
    task: "",
    branch: "main",
    worktreePath: null,
    setupScript: "",
    status: "active",
    createdAt: "",
    lastActive: "",
    glyph: null,
    tint: null,
    testCommand: null,
    linkedIssueKey: null,
    issueLinkDismissed: false,
    ...overrides,
  };
}

function proj(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return { id: "p1", name: "Test", path: "/tmp/repo", jiraProjectKey: null, ...overrides };
}

function issue(key: string, statusCategory: Issue["statusCategory"] = "todo", priority: string | null = null): Issue {
  return {
    key,
    summary: "summary " + key,
    statusName: statusCategory === "inProgress" ? "In Progress" : "To Do",
    statusCategory,
    issueType: "Story",
    priority,
    url: "https://x/browse/" + key,
    parentKey: null,
  };
}

describe("resolveLinkage", () => {
  it("manual link wins over branch detection", () => {
    expect(resolveLinkage(ws({ linkedIssueKey: "ABC-1" }), "feat/XYZ-9")).toEqual({
      kind: "linked", key: "ABC-1", source: "manual",
    });
  });

  it("detected from branch when no manual link", () => {
    expect(resolveLinkage(ws(), "feat/PROJ-42-foo")).toEqual({
      kind: "linked", key: "PROJ-42", source: "detected",
    });
  });

  it("dismissed only when no manual + no branch key", () => {
    expect(resolveLinkage(ws({ issueLinkDismissed: true }), "main")).toEqual({ kind: "dismissed" });
  });

  it("dismissed is overridden by branch key (rename reactivates card)", () => {
    expect(
      resolveLinkage(ws({ issueLinkDismissed: true }), "feat/PROJ-7-go"),
    ).toEqual({ kind: "linked", key: "PROJ-7", source: "detected" });
  });

  it("unlinked when nothing else applies", () => {
    expect(resolveLinkage(ws(), "main")).toEqual({ kind: "unlinked" });
  });
});

describe("resolveJiraProjectKey", () => {
  it("project override wins over branch", () => {
    expect(
      resolveJiraProjectKey(proj({ jiraProjectKey: "FORCED" }), ws(), "feat/OTHER-1"),
    ).toBe("FORCED");
  });

  it("falls back to linkage prefix when no override", () => {
    expect(
      resolveJiraProjectKey(proj(), ws({ linkedIssueKey: "CLPNSNS-92" }), "main"),
    ).toBe("CLPNSNS");
  });

  it("falls back to branch detection when no override + no manual link", () => {
    expect(
      resolveJiraProjectKey(proj(), ws(), "feat/PROJ-1"),
    ).toBe("PROJ");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveJiraProjectKey(proj(), ws(), "main")).toBeNull();
  });
});

describe("selectBacklog", () => {
  const issues = [
    issue("CLPNSNS-92", "inProgress", "High"),
    issue("CLPNSNS-105", "todo", "Medium"),
    issue("CLPNSNS-99", "done", "Low"),
    issue("OTHER-1", "todo"),
  ];

  it("filters by project prefix and excludes active key", () => {
    const result = selectBacklog(issues, "CLPNSNS", "CLPNSNS-92");
    expect(result.map((i) => i.key)).toEqual(["CLPNSNS-105", "CLPNSNS-99"]);
  });

  it("returns [] when projectKey is null", () => {
    expect(selectBacklog(issues, null, null)).toEqual([]);
  });

  it("sorts by statusCategory (inProgress, todo, unknown, done) then priority then key", () => {
    const mixed = [
      issue("P-3", "todo", "Low"),
      issue("P-1", "done"),
      issue("P-2", "inProgress", "High"),
      issue("P-4", "todo", "High"),
    ];
    const result = selectBacklog(mixed, "P", null);
    expect(result.map((i) => i.key)).toEqual(["P-2", "P-4", "P-3", "P-1"]);
  });
});

describe("selectElsewhereCount", () => {
  it("counts only inProgress outside the active project", () => {
    const issues = [
      issue("HERE-1", "inProgress"),
      issue("OTHER-1", "inProgress"),
      issue("OTHER-2", "todo"),
      issue("FAR-1", "inProgress"),
    ];
    expect(selectElsewhereCount(issues, "HERE")).toBe(2);
  });

  it("returns 0 when projectKey is null (nothing is 'elsewhere')", () => {
    expect(selectElsewhereCount([issue("A-1", "inProgress")], null)).toBe(0);
  });
});
