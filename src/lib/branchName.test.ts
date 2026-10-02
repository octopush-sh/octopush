import { describe, it, expect } from "vitest";
import { BRANCH_NAME_MAX, branchFromTask, shortenSlug } from "./branchName";

describe("branchFromTask", () => {
  it("keeps a short task as it was", () => {
    expect(branchFromTask("Add dark mode")).toBe("add-dark-mode");
    expect(branchFromTask("Fix checkout bug")).toBe("fix-checkout-bug");
  });

  it("starts with the ticket key and keeps four significant words of the summary", () => {
    const summary = "Add a GitLab group preview endpoint that returns the subgroup/project tree for the connect modal, refusing overlaps before the user selects anything";
    expect(branchFromTask(summary, "GUIDE-3753")).toBe("GUIDE-3753-add-gitlab-group-preview");
    expect(branchFromTask(summary, "GUIDE-3753").length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
  });

  it("finds the key in the task when none is given, and never repeats it", () => {
    expect(branchFromTask("GUIDE-3753: scan the AGP docker image")).toBe("GUIDE-3753-scan-agp-docker-image");
    expect(branchFromTask("Only the key: GUIDE-3753", "GUIDE-3753")).toBe("GUIDE-3753-only-key");
  });

  it("drops filler words, falling back to them when nothing else is left", () => {
    expect(branchFromTask("Build me a new app to track my daily tasks")).toBe("track-daily-tasks");
    expect(branchFromTask("the a an")).toBe("the-a-an");
    expect(branchFromTask("***")).toBe("");
    expect(branchFromTask("", "OCT-12")).toBe("OCT-12");
  });

  it("never exceeds the cap and never cuts inside a word or the key", () => {
    const long = branchFromTask("supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosis floccinaucinihilipilification", "VERYLONGPROJECTKEY-123456");
    expect(long.length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
    expect(long.startsWith("VERYLONGPROJECTKEY-123456")).toBe(true);
    expect(long).not.toMatch(/-$/);
  });
});

describe("shortenSlug", () => {
  it("cuts on a dash, hard only when there is none", () => {
    expect(shortenSlug("one-two-three", 9)).toBe("one-two");
    expect(shortenSlug("one-two-three", 13)).toBe("one-two-three");
    expect(shortenSlug("abcdefghijklmnop", 5)).toBe("abcde");
    expect(shortenSlug("one-two", 4)).toBe("one");
  });
});
