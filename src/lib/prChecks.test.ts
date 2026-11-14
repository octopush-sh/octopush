import { describe, expect, it } from "vitest";
import { FAILED_LOG_MAX_CHARS, checksTitle, failedRunIds, fixChecksBrief } from "./prChecks";
import type { Pr } from "./types";

const failing: Pr = {
  number: 42,
  title: "Add exports",
  url: "https://github.com/o/r/pull/42",
  isDraft: false,
  state: "open",
  checks: {
    state: "failing",
    failing: [
      { name: "test", runId: 12 },
      { name: "lint", runId: 12 },
      { name: "ci/circle", runId: null },
    ],
  },
};

describe("checksTitle", () => {
  it("lists the failing checks by name", () => {
    expect(checksTitle(failing.checks!)).toBe("Checks failing: test, lint, ci/circle");
  });
  it("names passing and pending plainly", () => {
    expect(checksTitle({ state: "passing", failing: [] })).toBe("Checks passing");
    expect(checksTitle({ state: "pending", failing: [] })).toBe("Checks running");
  });
});

describe("failedRunIds", () => {
  it("keeps each Actions run once and skips non-Actions checks", () => {
    expect(failedRunIds(failing.checks!)).toEqual([12]);
  });
});

describe("fixChecksBrief", () => {
  it("names the PR and each failed check, with the log tail fenced", () => {
    const brief = fixChecksBrief(failing, "run 12\nError: expected 2, got 3\n");
    expect(brief).toContain("pull request #42 (Add exports)");
    expect(brief).toContain("- test\n- lint\n- ci/circle");
    expect(brief).toContain("```\nrun 12\nError: expected 2, got 3\n```");
  });

  it("leaves the log section out when there is no log", () => {
    expect(fixChecksBrief(failing, "  ")).not.toContain("gh run view");
  });

  it("keeps only the last 8k chars of a long log", () => {
    const log = "x".repeat(20_000) + "THE END";
    const brief = fixChecksBrief(failing, log);
    expect(brief).toContain("THE END");
    expect(brief).not.toContain("x".repeat(FAILED_LOG_MAX_CHARS));
    expect(brief.length).toBeLessThan(FAILED_LOG_MAX_CHARS + 600);
  });

  it("caps by code points, never splitting a surrogate pair", () => {
    // 8000 emoji then one ASCII char: the cap drops the first emoji whole,
    // where a UTF-16 slice would start on the low half of a pair.
    const log = "🐙".repeat(FAILED_LOG_MAX_CHARS) + "x";
    const brief = fixChecksBrief(failing, log);
    const fenced = brief.slice(brief.indexOf("```\n") + 4, brief.lastIndexOf("\n```"));
    expect(Array.from(fenced)).toHaveLength(FAILED_LOG_MAX_CHARS);
    expect(fenced).toBe("🐙".repeat(FAILED_LOG_MAX_CHARS - 1) + "x");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(brief)).toBe(false);
  });
});
