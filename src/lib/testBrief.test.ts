import { describe, expect, it } from "vitest";
import { TEST_ASK, testBrief } from "./testBrief";

const ticket = {
  key: "ENG-42",
  summary: "Keep the return path on sign-in",
  url: "https://tracker.example.com/browse/ENG-42",
};

describe("testBrief", () => {
  it("carries the key, summary, URL, description and the ask", () => {
    const brief = testBrief({ ...ticket, description: "Test plan\n\n- Run sample-service\n- Open /login?next=/billing" });
    expect(brief).toBe(
      "Test ENG-42: Keep the return path on sign-in\nhttps://tracker.example.com/browse/ENG-42\n\n" +
        "Description:\nTest plan\n\n- Run sample-service\n- Open /login?next=/billing\n\n" +
        TEST_ASK,
    );
    expect(TEST_ASK).toContain("a verdict (Works, Doesn't work, or Couldn't test)");
  });

  it("says when the ticket has no description", () => {
    expect(testBrief({ ...ticket, description: null })).toContain("\n\nThe ticket has no description.\n\n");
    expect(testBrief({ ...ticket, description: "   " })).toContain("The ticket has no description.");
  });

  it("carries the key and summary when the ticket couldn't be read", () => {
    const brief = testBrief({ key: "ENG-42", summary: "Keep the return path on sign-in" }, false);
    expect(brief.startsWith("Test ENG-42: Keep the return path on sign-in\n\nThe ticket's description couldn't be read.")).toBe(true);
    expect(brief.endsWith(TEST_ASK)).toBe(true);
  });
});
