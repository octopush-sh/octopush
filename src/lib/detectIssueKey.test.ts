import { describe, it, expect } from "vitest";
import { detectIssueKey, detectIssueKeyForProject } from "./detectIssueKey";

describe("detectIssueKey", () => {
  it("extracts the first Jira-style key from a branch", () => {
    expect(detectIssueKey("feat/PROJ-123-login")).toBe("PROJ-123");
    expect(detectIssueKey("ABC-9")).toBe("ABC-9");
    expect(detectIssueKey("bugfix/AB12-7-x")).toBe("AB12-7");
  });
  it("returns null when there is no key", () => {
    expect(detectIssueKey("main")).toBeNull();
    expect(detectIssueKey("feature/login")).toBeNull();
    expect(detectIssueKey("proj-123")).toBeNull();
  });
});

describe("detectIssueKeyForProject", () => {
  it("accepts a detected key that matches the project prefix", () => {
    expect(detectIssueKeyForProject("feat/OCT-12-login", "OCT")).toBe("OCT-12");
    expect(detectIssueKeyForProject("oct/OCT-5", "OCT")).toBe("OCT-5");
  });
  it("rejects Jira-shaped tokens that are not the project key (C5)", () => {
    expect(detectIssueKeyForProject("fix/UTF-8-encoding", "OCT")).toBeNull();
    expect(detectIssueKeyForProject("docs/RFC-2616", "OCT")).toBeNull();
  });
  it("returns null when the project has no configured key", () => {
    expect(detectIssueKeyForProject("feat/OCT-12", null)).toBeNull();
    expect(detectIssueKeyForProject("feat/OCT-12", "")).toBeNull();
  });
  it("does not detect lowercase keys", () => {
    expect(detectIssueKeyForProject("feat/oct-12", "OCT")).toBeNull();
  });
});
