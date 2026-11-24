import { describe, it, expect } from "vitest";
import { branchScanSummary, findingLocation, guardHeadline, holdSummary, overrideLabel, previewSummary, secretRefusal, secretSummary, uncheckedNote, type SecretFinding } from "./secretGuard";

const f = (over: Partial<SecretFinding> = {}): SecretFinding => ({
  file: "tests/fixtures.ts", line: 12, rule: "anthropic-key", kind: "Anthropic API key", yours: false, ...over,
});

describe("secretGuard", () => {
  it("keeps the masked preview out of every one-line summary (#820)", () => {
    const withPreview = f({ preview: "sk-ant-…9fQ2" });
    for (const text of [
      secretSummary([withPreview]),
      previewSummary({ findings: [withPreview], total: 1, partial: false }) ?? "",
      holdSummary({ acknowledged: false, fingerprint: "x", findings: [withPreview] }),
      guardHeadline("commit", [withPreview]),
    ]) {
      expect(text).not.toContain("9fQ2");
    }
  });

  it("words the branch scan's verdict", () => {
    expect(branchScanSummary({ findings: [], total: 0, partial: false }, 3)).toBe("No possible secrets in 3 commits.");
    expect(branchScanSummary({ findings: [], total: 0, partial: false }, 1)).toBe("No possible secrets in 1 commit.");
    expect(branchScanSummary({ findings: [], total: 0, partial: true }, 3)).toBe(
      "Nothing found in the first 16 MB; the rest wasn't checked.",
    );
    expect(branchScanSummary({ findings: [f()], total: 1, partial: false }, 3)).toBe("1 possible secret in this branch's commits.");
    expect(branchScanSummary({ findings: [f(), f()], total: 60, partial: true }, 3)).toBe("60 possible secrets in this branch's commits.");
  });

  it("recognises the guard's structured refusal, as an object or a JSON string", () => {
    const err = { kind: "SecretsFound", message: "possible secret: …", findings: [f()], total: 3, partial: true, fingerprint: "abc" };
    const want = { findings: [f()], total: 3, partial: true, fingerprint: "abc" };
    expect(secretRefusal(err)).toEqual(want);
    expect(secretRefusal(JSON.stringify(err))).toEqual(want);
    // Without a fingerprint there is nothing to confirm against.
    expect(secretRefusal({ kind: "SecretsFound", findings: [f()] })).toBeNull();
    expect(secretRefusal("git commit failed: nothing to commit")).toBeNull();
    expect(secretRefusal({ kind: "BudgetExceeded" })).toBeNull();
    expect(secretRefusal(null)).toBeNull();
  });

  it("reads kind, file and line", () => {
    expect(findingLocation(f())).toBe("tests/fixtures.ts:12");
    expect(findingLocation(f({ file: "deploy/id_rsa", line: null }))).toBe("deploy/id_rsa");
    expect(guardHeadline("commit", [f()])).toBe("This change adds what looks like an Anthropic API key in tests/fixtures.ts:12.");
    expect(guardHeadline("push", [f({ kind: "GitHub token" })])).toBe("This push adds what looks like a GitHub token in tests/fixtures.ts:12.");
    expect(guardHeadline("pr", [f({ kind: "your OpenAI API key", yours: true })])).toBe(
      "This pull request adds what looks like your OpenAI API key in tests/fixtures.ts:12.",
    );
    expect(guardHeadline("commit", [f(), f({ line: 13 })])).toBe("This change adds 2 things that look like secrets.");
    expect(secretSummary([f()])).toBe("possible secret · Anthropic API key in tests/fixtures.ts:12");
    expect(secretSummary([f(), f({ line: 3 })])).toBe("possible secrets · Anthropic API key in tests/fixtures.ts:12 and 1 more");
    expect(secretSummary([f()], 51)).toBe("possible secrets · Anthropic API key in tests/fixtures.ts:12 and 50 more");
    expect(guardHeadline("commit", [f()], 51)).toBe("This change adds 51 things that look like secrets.");
    expect(holdSummary({ acknowledged: false, fingerprint: "x", findings: [], unreadable: true })).toBe(
      "couldn't read the worktree's changes, so nothing was checked",
    );
    expect(holdSummary({ acknowledged: false, fingerprint: "x", findings: [], total: 0, partial: true })).toBe(
      "scanned the first 16 MB; the rest wasn't checked",
    );
  });

  it("summarises a preview only when Commit would ask", () => {
    expect(previewSummary(null)).toBeNull();
    expect(previewSummary({ findings: [], total: 0, partial: false })).toBeNull();
    expect(previewSummary({ findings: [f({ kind: "GitHub token", file: "a.ts", line: 3 })], total: 1, partial: false })).toBe(
      "possible secret · GitHub token in a.ts:3",
    );
    expect(previewSummary({ findings: [f()], total: 2, partial: true })).toBe(
      "possible secrets · Anthropic API key in tests/fixtures.ts:12 and 1 more · scanned the first 16 MB; the rest wasn't checked",
    );
    expect(previewSummary({ findings: [], total: 0, partial: true })).toBe("scanned the first 16 MB; the rest wasn't checked");
  });

  it("names each override", () => {
    expect(overrideLabel("commit")).toBe("Commit regardless");
    expect(overrideLabel("push")).toBe("Push regardless");
    expect(overrideLabel("pr")).toBe("Open it regardless");
    expect(overrideLabel("command")).toBe("Run regardless");
    expect(overrideLabel("message")).toBe("Send regardless");
    expect(guardHeadline("message", [f({ kind: "GitHub token", file: "@diff", line: 4 })])).toBe(
      "This message attaches what looks like a GitHub token in @diff:4.",
    );
    expect(guardHeadline("message", [f(), f()])).toBe("This message attaches 2 things that look like secrets.");
    // Blocks the guard couldn't scan (#1046), named by their token.
    expect(guardHeadline("message", [], 0, ["@diff"])).toBe("This message's @diff couldn't be checked.");
    expect(guardHeadline("message", [], 0, ["@src/a.ts#L2-3", "@session:dev"])).toBe(
      "This message's @src/a.ts#L2-3 and @session:dev couldn't be checked.",
    );
    expect(guardHeadline("message", [], 0, ["@diff", "@src/", "@a.ts", "@b.ts"])).toBe(
      "This message's @diff, @src/ and 2 more couldn't be checked.",
    );
    expect(guardHeadline("message", [f({ kind: "GitHub token", file: "a.ts", line: 3 })], 1, ["@diff"])).toBe(
      "This message attaches what looks like a GitHub token in a.ts:3.",
    );
    expect(uncheckedNote(["@diff"])).toBe("@diff couldn't be checked.");
    expect(guardHeadline("command", [f({ kind: "GitHub token" })])).toBe(
      "This command adds what looks like a GitHub token in tests/fixtures.ts:12.",
    );
  });
});
