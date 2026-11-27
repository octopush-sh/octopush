import { describe, it, expect } from "vitest";
import { detectIssueKey, detectIssueKeyForProject, detectTrackerKey, isIssueKey } from "./detectIssueKey";

const known = (...keys: string[]) => (key: string) => keys.includes(key);

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
    expect(detectIssueKey("A-1.1")).toBeNull();
  });
  it("extracts a dotted Epiku story id whole", () => {
    expect(detectIssueKey("feat/ST-2.3-login")).toBe("ST-2.3");
    expect(detectIssueKey("HU-1.1")).toBe("HU-1.1");
    expect(detectIssueKey("ST-1.2.3-deep")).toBe("ST-1.2.3");
    expect(detectIssueKey("fix/[ST-10.12]")).toBe("ST-10.12");
  });
  it("matches Jira keys exactly as before: a dot extends a key only before a digit", () => {
    expect(detectIssueKey("feat/PROJ-123.fix")).toBe("PROJ-123");
    expect(detectIssueKey("Fix PROJ-123.")).toBe("PROJ-123");
    expect(detectIssueKey("PROJ-12..3")).toBe("PROJ-12");
    expect(detectIssueKey("PROJ-123-login.v2")).toBe("PROJ-123");
    expect(detectIssueKey("ABC-9_x")).toBe("ABC-9");
    expect(detectIssueKey("release/1.2-PROJ-7")).toBe("PROJ-7");
    expect(detectIssueKey("ST-.1")).toBeNull();
  });
});

describe("isIssueKey", () => {
  it("accepts one whole Jira key or Epiku story id", () => {
    expect(isIssueKey("PROJ-123")).toBe(true);
    expect(isIssueKey("ST-1.1")).toBe(true);
    expect(isIssueKey("HU-2.10.3")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isIssueKey("proj-123")).toBe(false);
    expect(isIssueKey("PROJ-123.")).toBe(false);
    expect(isIssueKey("ST-1.1 extra")).toBe(false);
    expect(isIssueKey("A-1")).toBe(false);
    expect(isIssueKey("#42")).toBe(false);
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
  it("keeps a Jira key undotted: PROJ-12.5 names PROJ-12", () => {
    expect(detectIssueKeyForProject("feat/PROJ-12.5-login", "PROJ")).toBe("PROJ-12");
    expect(detectIssueKeyForProject("PROJ-7.1.2", "PROJ")).toBe("PROJ-7");
  });
  it("does not detect lowercase keys", () => {
    expect(detectIssueKeyForProject("feat/oct-12", "OCT")).toBeNull();
  });
});

describe("detectTrackerKey", () => {
  it("takes a dotted id under Epiku only when it is one of the project's stories", () => {
    expect(detectTrackerKey("feat/ST-2.3-login", "epiku", null, known("ST-2.3"))).toBe("ST-2.3");
    expect(detectTrackerKey("feat/HU-1.1", "epiku", "OCT", known("HU-1.1"))).toBe("HU-1.1");
    expect(detectTrackerKey("feat/ST-2.3-login", "epiku", null, known("ST-1.1"))).toBeNull();
    expect(detectTrackerKey("feat/ST-2.3-login", "epiku", null)).toBeNull();
  });
  it("never links a dotted token that isn't a story", () => {
    const stories = known("ST-1.1");
    for (const branch of ["docs/RFC-1.0", "fix/UTF-8.1-decoding", "chore/NODE-20.11", "release/v1.2.3"]) {
      expect(detectTrackerKey(branch, "epiku", null, stories)).toBeNull();
    }
    expect(detectTrackerKey("fix/UTF-8.1-then-ST-1.1", "epiku", null, stories)).toBe("ST-1.1");
  });
  it("keeps Jira's project-key rule otherwise, undotted", () => {
    expect(detectTrackerKey("feat/OCT-12-login", "jira", "OCT")).toBe("OCT-12");
    expect(detectTrackerKey("feat/PROJ-12.5", "jira", "PROJ", known("PROJ-12.5"))).toBe("PROJ-12");
    expect(detectTrackerKey("feat/ST-2.3", "jira", "OCT")).toBeNull();
    expect(detectTrackerKey("feat/OCT-12", null, "OCT")).toBe("OCT-12");
  });
});
