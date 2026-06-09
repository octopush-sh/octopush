import { describe, it, expect } from "vitest";
import { COMMIT_SYSTEM, buildCommitPrompt } from "./commitMessage";

describe("commitMessage", () => {
  it("system prompt asks for message-only, subject + optional body", () => {
    expect(COMMIT_SYSTEM).toMatch(/ONLY the message/i);
    expect(COMMIT_SYSTEM).toMatch(/subject/i);
  });
  it("buildCommitPrompt embeds the staged diff", () => {
    expect(buildCommitPrompt("DIFFX")).toContain("DIFFX");
  });
  it("caps a very large diff in the prompt", () => {
    const big = "x".repeat(20000);
    const prompt = buildCommitPrompt(big);
    expect(prompt.length).toBeLessThan(13000);
    expect(prompt).toContain("truncated for the prompt");
  });
});
