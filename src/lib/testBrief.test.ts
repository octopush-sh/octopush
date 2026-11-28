import { describe, expect, it } from "vitest";
import { testBrief } from "./testBrief";

const ticket = { key: "ENG-42", summary: "Sign-in keeps the return path", url: "https://tracker.example.com/browse/ENG-42" };

describe("testBrief", () => {
  it("carries the ticket, its description and the ask", () => {
    const brief = testBrief({ ...ticket, description: "Steps:\n- Open /login?next=/billing\n- Sign in" });
    expect(brief.startsWith("Test ENG-42: Sign-in keeps the return path\nhttps://tracker.example.com/browse/ENG-42\n\n")).toBe(true);
    expect(brief).toContain("Description:\nSteps:\n- Open /login?next=/billing\n- Sign in");
    expect(brief).toContain("follow the test plan above");
    expect(brief).toContain("End with a verdict (Works, Doesn't work, or Couldn't test)");
  });

  it("says when there is no description, or the ticket couldn't be read", () => {
    expect(testBrief(ticket)).toContain("The ticket has no description.");
    const unread = testBrief({ key: "ENG-42", summary: "Sign-in keeps the return path" }, true);
    expect(unread).toContain("Test ENG-42: Sign-in keeps the return path\n\nThe ticket's description couldn't be read.");
    expect(unread).not.toContain("Description:");
  });
});
