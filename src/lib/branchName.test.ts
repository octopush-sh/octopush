import { describe, it, expect } from "vitest";
import fixtures from "./branchName.fixtures.json";
import { BRANCH_NAME_MAX, DIR_SLUG_MAX, DIR_SLUG_MIN, branchFromTask, shortenSlug, uniqueBranch, worktreeSlugMax } from "./branchName";

describe("branchFromTask", () => {
  it("satisfies every shared case, the ones the Rust mirror is pinned to", () => {
    for (const c of fixtures.cases) {
      expect(branchFromTask(c.task, c.key, c.projectKey), `${c.task} · key=${c.key} · project=${c.projectKey}`).toBe(c.expect);
    }
  });

  it("never exceeds the cap and never cuts inside a word or the key", () => {
    for (const c of fixtures.cases) {
      const out = branchFromTask(c.task, c.key, c.projectKey);
      expect(out.length).toBeLessThanOrEqual(Math.max(BRANCH_NAME_MAX, (c.key ?? "").length));
      expect(out).not.toMatch(/-$/);
      if (c.key) expect(out.startsWith(c.key)).toBe(true);
    }
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

describe("uniqueBranch", () => {
  it("suffixes a taken name with the first free number", () => {
    const taken = new Set(["fix-login-form-validation", "fix-login-form-validation-2"]);
    expect(uniqueBranch("fix-login-form-validation", (b) => taken.has(b))).toBe("fix-login-form-validation-3");
    expect(uniqueBranch("free", (b) => taken.has(b))).toBe("free");
  });
});

describe("worktreeSlugMax", () => {
  it("keeps the usual cap under a normal path and gives way under a deep one", () => {
    expect(worktreeSlugMax("/Users/j/IdeaProjects/.octopus-worktrees")).toBe(DIR_SLUG_MAX);
    expect(worktreeSlugMax(`/Users/j/${"deep/".repeat(28)}.octopus-worktrees`)).toBeLessThan(DIR_SLUG_MAX);
    expect(worktreeSlugMax(`/${"x/".repeat(120)}.octopus-worktrees`)).toBe(DIR_SLUG_MIN);
  });
});
