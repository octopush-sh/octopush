import { describe, it, expect } from "vitest";
import { findingLocation, guardHeadline, overrideLabel, secretFindings, secretSummary, type SecretFinding } from "./secretGuard";

const f = (over: Partial<SecretFinding> = {}): SecretFinding => ({
  file: "tests/fixtures.ts", line: 12, rule: "anthropic-key", kind: "Anthropic API key", yours: false, ...over,
});

describe("secretGuard", () => {
  it("recognises the guard's structured refusal, as an object or a JSON string", () => {
    const err = { kind: "SecretsFound", message: "possible secret: …", findings: [f()] };
    expect(secretFindings(err)).toEqual([f()]);
    expect(secretFindings(JSON.stringify(err))).toEqual([f()]);
    expect(secretFindings("git commit failed: nothing to commit")).toBeNull();
    expect(secretFindings({ kind: "BudgetExceeded" })).toBeNull();
    expect(secretFindings(null)).toBeNull();
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
  });

  it("names each override", () => {
    expect(overrideLabel("commit")).toBe("Commit regardless");
    expect(overrideLabel("push")).toBe("Push regardless");
    expect(overrideLabel("pr")).toBe("Open it regardless");
  });
});
