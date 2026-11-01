import { describe, it, expect } from "vitest";
import { resolveWorkspaceTarget } from "./workspaceTarget";

const byProject = {
  "p-a": [{ id: "ws-a1" }, { id: "ws-a2" }],
  "p-b": [{ id: "ws-b1" }],
};
const recent = [
  { id: "p-a", path: "/repos/a" },
  { id: "p-b", path: "/repos/b" },
];

describe("resolveWorkspaceTarget", () => {
  it("stays in the open project for one of its workspaces", () => {
    expect(resolveWorkspaceTarget("ws-a2", byProject, "p-a", recent)).toEqual({ kind: "here" });
  });

  it("switches project for a workspace of another project", () => {
    expect(resolveWorkspaceTarget("ws-b1", byProject, "p-a", recent)).toEqual({
      kind: "switch",
      projectId: "p-b",
      projectPath: "/repos/b",
    });
  });

  it("switches project when none is open", () => {
    expect(resolveWorkspaceTarget("ws-b1", byProject, null, recent)).toMatchObject({
      kind: "switch",
      projectId: "p-b",
    });
  });

  it("falls back to a plain select for an unknown workspace or project path", () => {
    expect(resolveWorkspaceTarget("ws-x", byProject, "p-a", recent)).toEqual({ kind: "here" });
    expect(resolveWorkspaceTarget("ws-b1", byProject, "p-a", [recent[0]])).toEqual({ kind: "here" });
  });
});
