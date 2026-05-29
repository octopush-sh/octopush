import { describe, it, expect } from "vitest";
import { detectIssueKey } from "./detectIssueKey";

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
