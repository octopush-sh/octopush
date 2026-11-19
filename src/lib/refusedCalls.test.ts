import { describe, it, expect } from "vitest";
import { isRefusedNotice, refusedCallsNote } from "./refusedCalls";
import { lastNotice } from "./liveLine";

describe("refused tool calls (#893)", () => {
  it("counts in plain English", () => {
    expect(refusedCallsNote(1)).toBe("1 tool call refused");
    expect(refusedCallsNote(4)).toBe("4 tool calls refused");
  });

  it("knows its journal notices", () => {
    expect(isRefusedNotice("refused · Bash · git push ×2")).toBe(true);
    expect(isRefusedNotice("VERDICT: PASS")).toBe(false);
  });

  it("never lets a refusal notice stand in for the verdict", () => {
    expect(
      lastNotice([
        { kind: "notice", text: "VERDICT: CHANGES_REQUESTED" },
        { kind: "notice", text: "refused · Bash · npm test" },
      ] as any),
    ).toBe("VERDICT: CHANGES_REQUESTED");
    expect(lastNotice([{ kind: "notice", text: "refused · Write · /etc/hosts" }] as any)).toBe("");
  });
});
