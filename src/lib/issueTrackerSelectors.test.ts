import { describe, it, expect } from "vitest";
import {
  resolveLinkage,
  resolveJiraProjectKey,
  selectBacklog,
  selectElsewhereCount,
  selectBlocking,
  selectBlockedBy,
  selectSubtasksOrSiblings,
  selectEpicSiblings,
  resolveEpicKey,
  issueTypeToken,
} from "./issueTrackerSelectors";
import type { Issue, LinkedIssueRef, ProjectInfo, Workspace } from "./types";

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
  return { id: "p1", name: "Test", path: "/tmp/repo", jiraProjectKey: null, pinned: false, ...overrides };
}

function issue(
  key: string,
  issueType: string = "Story",
  overrides: Partial<Issue> = {},
): Issue {
  return {
    key,
    summary: "summary " + key,
    statusName: "To Do",
    statusCategory: "todo",
    issueType,
    priority: null,
    url: "https://x/browse/" + key,
    parentKey: null,
    subtask: false,
    hierarchyLevel: 0,
    ...overrides,
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

  it("unlinked when no manual + no branch key (issueLinkDismissed no longer matters)", () => {
    expect(resolveLinkage(ws({ issueLinkDismissed: true }), "main")).toEqual({ kind: "unlinked" });
  });

  it("branch key still detected regardless of issueLinkDismissed", () => {
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
    issue("CLPNSNS-92", "Story", { statusCategory: "inProgress", statusName: "In Progress", priority: "High" }),
    issue("CLPNSNS-105", "Story", { statusCategory: "todo", priority: "Medium" }),
    issue("CLPNSNS-99", "Story", { statusCategory: "done", priority: "Low" }),
    issue("OTHER-1", "Story"),
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
      issue("P-3", "Story", { statusCategory: "todo", priority: "Low" }),
      issue("P-1", "Story", { statusCategory: "done" }),
      issue("P-2", "Story", { statusCategory: "inProgress", statusName: "In Progress", priority: "High" }),
      issue("P-4", "Story", { statusCategory: "todo", priority: "High" }),
    ];
    const result = selectBacklog(mixed, "P", null);
    expect(result.map((i) => i.key)).toEqual(["P-2", "P-4", "P-3", "P-1"]);
  });
});

describe("selectElsewhereCount", () => {
  it("counts only inProgress outside the active project", () => {
    const issues = [
      issue("HERE-1", "Story", { statusCategory: "inProgress", statusName: "In Progress" }),
      issue("OTHER-1", "Story", { statusCategory: "inProgress", statusName: "In Progress" }),
      issue("OTHER-2", "Story"),
      issue("FAR-1", "Story", { statusCategory: "inProgress", statusName: "In Progress" }),
    ];
    expect(selectElsewhereCount(issues, "HERE")).toBe(2);
  });

  it("returns 0 when projectKey is null (nothing is 'elsewhere')", () => {
    expect(selectElsewhereCount([issue("A-1", "Story", { statusCategory: "inProgress" })], null)).toBe(0);
  });
});

describe("issueTypeToken", () => {
  it("Epic by hierarchyLevel maps to text-state-purple", () => {
    expect(issueTypeToken(issue("E-1", "Epic", { hierarchyLevel: 1 }))).toBe("text-state-purple");
  });

  it("Sub-task by subtask flag maps to text-state-blue", () => {
    expect(issueTypeToken(issue("S-1", "Sub-task", { subtask: true, hierarchyLevel: -1 }))).toBe("text-state-blue");
  });

  it("Story (English) maps to text-octo-verdigris", () => {
    expect(issueTypeToken(issue("X-1", "Story"))).toBe("text-octo-verdigris");
  });

  it("Story (Spanish 'Historia') maps to text-octo-verdigris", () => {
    expect(issueTypeToken(issue("X-1", "Historia"))).toBe("text-octo-verdigris");
  });

  it("Bug (English) maps to text-octo-rouge", () => {
    expect(issueTypeToken(issue("X-1", "Bug"))).toBe("text-octo-rouge");
  });

  it("Bug (Spanish 'Error' / 'Incidencia') maps to text-octo-rouge", () => {
    expect(issueTypeToken(issue("X-1", "Error"))).toBe("text-octo-rouge");
    expect(issueTypeToken(issue("X-1", "Incidencia"))).toBe("text-octo-rouge");
  });

  it("Task (English / Spanish 'Tarea') maps to text-state-blue", () => {
    expect(issueTypeToken(issue("X-1", "Task"))).toBe("text-state-blue");
    expect(issueTypeToken(issue("X-1", "Tarea"))).toBe("text-state-blue");
  });

  it("Unmapped types fall back to text-octo-brass", () => {
    expect(issueTypeToken(issue("X-1", "Spike"))).toBe("text-octo-brass");
    expect(issueTypeToken(issue("X-1", "Improvement"))).toBe("text-octo-brass");
  });
});

function ref(key: string, overrides: Partial<LinkedIssueRef> = {}): LinkedIssueRef {
  return {
    key,
    summary: "ref " + key,
    statusName: "To Do",
    statusCategory: "todo",
    issueType: "Story",
    url: "https://x/browse/" + key,
    ...overrides,
  };
}

describe("selectBlocking / selectBlockedBy", () => {
  it("returns the active issue's blocks list", () => {
    const active = issue("A-1", "Story", {
      blocks: [ref("A-2"), ref("A-3")],
    });
    expect(selectBlocking(active).map((r) => r.key)).toEqual(["A-2", "A-3"]);
  });

  it("returns the active issue's blockedBy list", () => {
    const active = issue("A-1", "Story", {
      blockedBy: [ref("A-4")],
    });
    expect(selectBlockedBy(active).map((r) => r.key)).toEqual(["A-4"]);
  });

  it("returns [] when activeIssue is null or fields are absent", () => {
    expect(selectBlocking(null)).toEqual([]);
    expect(selectBlockedBy(null)).toEqual([]);
    expect(selectBlocking(issue("A-1"))).toEqual([]);
    expect(selectBlockedBy(issue("A-1"))).toEqual([]);
  });
});

describe("selectSubtasksOrSiblings", () => {
  it("returns the active's own subtasks when active is not a sub-task", () => {
    const active = issue("A-1", "Story", {
      subtask: false,
      subtasks: [ref("A-1.1"), ref("A-1.2")],
    });
    const out = selectSubtasksOrSiblings(active, {});
    expect(out.map((r) => r.key)).toEqual(["A-1.1", "A-1.2"]);
  });

  it("returns siblings (parent's subtasks minus self) when active IS a sub-task", () => {
    const parent = issue("A-1", "Story", {
      subtasks: [ref("A-1.1"), ref("A-1.2"), ref("A-1.3")],
    });
    const active = issue("A-1.2", "Sub-task", { subtask: true, parentKey: "A-1" });
    const out = selectSubtasksOrSiblings(active, { "A-1": parent });
    expect(out.map((r) => r.key)).toEqual(["A-1.1", "A-1.3"]);
  });

  it("returns [] for a sub-task whose parent is not in the parents cache yet", () => {
    const active = issue("A-1.2", "Sub-task", { subtask: true, parentKey: "A-1" });
    expect(selectSubtasksOrSiblings(active, {})).toEqual([]);
  });

  it("returns [] when active is null", () => {
    expect(selectSubtasksOrSiblings(null, {})).toEqual([]);
  });
});

describe("selectEpicSiblings", () => {
  it("excludes the active ticket and sorts by status/priority/key", () => {
    const list = [
      issue("E-3", "Story", { statusCategory: "todo", priority: "Low" }),
      issue("E-1", "Story", { statusCategory: "inProgress" }),
      issue("E-2", "Story", { statusCategory: "todo", priority: "High" }),
      issue("E-active", "Story", { statusCategory: "inProgress" }),
    ];
    const out = selectEpicSiblings(list, "E-active");
    expect(out.map((i) => i.key)).toEqual(["E-1", "E-2", "E-3"]);
  });

  it("returns [] when the epic cache is undefined (not yet fetched)", () => {
    expect(selectEpicSiblings(undefined, "E-active")).toEqual([]);
  });
});

describe("resolveEpicKey", () => {
  it("returns the active key when active itself is the epic", () => {
    expect(resolveEpicKey(issue("EPIC-1", "Epic", { hierarchyLevel: 1 }), {})).toBe("EPIC-1");
  });

  it("returns the parent key when the parent is an epic", () => {
    const parents = { "EPIC-1": issue("EPIC-1", "Epic", { hierarchyLevel: 1 }) };
    const story = issue("S-1", "Story", { parentKey: "EPIC-1" });
    expect(resolveEpicKey(story, parents)).toBe("EPIC-1");
  });

  it("returns the grandparent key when active is a sub-task under a story under an epic", () => {
    const parents = {
      "S-1":  issue("S-1",  "Story", { parentKey: "EPIC-1" }),
      "EPIC-1": issue("EPIC-1", "Epic",  { hierarchyLevel: 1 }),
    };
    const sub = issue("S-1.1", "Sub-task", { subtask: true, parentKey: "S-1" });
    expect(resolveEpicKey(sub, parents)).toBe("EPIC-1");
  });

  it("falls back to parentKey for non-sub-tasks when the parents cache is empty", () => {
    const story = issue("S-1", "Story", { parentKey: "EPIC-1" });
    expect(resolveEpicKey(story, {})).toBe("EPIC-1");
  });

  it("returns null for a sub-task with no parent loaded — we can't guess one level up safely", () => {
    const sub = issue("S-1.1", "Sub-task", { subtask: true, parentKey: "S-1" });
    expect(resolveEpicKey(sub, {})).toBeNull();
  });

  it("returns null when active is null", () => {
    expect(resolveEpicKey(null, {})).toBeNull();
  });
});
