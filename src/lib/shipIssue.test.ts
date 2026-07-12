/** composeIssueTask — the issue→crew-task fold ("Ship it" flow). */
import { describe, it, expect } from "vitest";
import { composeIssueTask } from "./shipIssue";
import type { GhIssue } from "./types";

const issue = (over: Partial<GhIssue> = {}): GhIssue => ({
  number: 42,
  title: "Add CSV export to reports",
  body: "Users need CSV.",
  url: "https://github.com/o/r/issues/42",
  ...over,
});

describe("composeIssueTask", () => {
  it("carries the reference, the body, and the Closes instruction", () => {
    const t = composeIssueTask(issue());
    expect(t).toContain("Ship GitHub issue #42 — Add CSV export to reports");
    expect(t).toContain("Users need CSV.");
    expect(t).toContain('include "Closes #42" in its body');
  });

  it("omits the body block when the body is blank", () => {
    const t = composeIssueTask(issue({ body: "   " }));
    expect(t).not.toContain("\n\n\n");
    expect(t).toContain("Ship GitHub issue #42");
    expect(t).toContain("Closes #42");
  });

  it("caps a huge body with an explicit truncation note pointing at the issue", () => {
    const t = composeIssueTask(issue({ body: "x".repeat(20_000) }));
    expect(t.length).toBeLessThan(5_000);
    expect(t).toContain("issue body truncated");
    expect(t).toContain("https://github.com/o/r/issues/42");
    expect(t).toContain("Closes #42"); // the instruction survives the cap
  });
});
