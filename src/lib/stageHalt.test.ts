import { describe, it, expect } from "vitest";
import { haltCause } from "./stageHalt";

describe("haltCause", () => {
  it("explains a turn-budget halt", () => {
    const c = haltCause("claude stopped early (error_max_turns) — review…", 25);
    expect(c.title).toContain("turn limit");
    expect(c.title).toContain("25");
  });
  it("explains a budget stop as a budget stop, not a crash", () => {
    const c = haltCause(
      "budget reached mid-stage — Claude Code stopped at the run's remaining budget (error_max_budget_usd, $1.27 reported) — resume…",
      25,
    );
    expect(c.title).toBe("Claude stopped at the run's budget");
    expect(c.remedy).toMatch(/Resum/);
    // A sibling in a parallel batch can stop while the run is still under
    // budget, so the remedy must not promise a budget gate on every Resume.
    expect(c.remedy).toContain("within whatever budget is left");
    expect(c.remedy).not.toMatch(/approve the budget gate/);
  });
  it("explains a finished stage whose session could not be saved", () => {
    const c = haltCause(
      "Claude Code finished the work but exited with an error — it could not save its session (disk full or quota?). The changes are in the worktree; free space, then accept or re-run.\n— stderr —\nENOSPC\n1.2 GB free on the worktree's volume",
      25,
    );
    expect(c.title).toBe("Claude finished the work but couldn't save its session");
    expect(c.remedy).toMatch(/free some space/);
    // The session is cleared, so the bar offers only Re-run — the copy must not promise Resume.
    expect(c.remedy).toMatch(/Re-running starts a fresh session/);
    expect(c.remedy).not.toMatch(/Resum/);
  });
  it("explains a hook-deferred tool call and prefers Re-run", () => {
    const c = haltCause(
      "A hook paused echo (MCP server fixture-srv) before it ran. Resume once it may run, or re-run the stage.\n(terminal_reason: tool_deferred)",
      25,
    );
    expect(c.title).toBe("A hook paused echo (MCP server fixture-srv) before it ran");
    expect(c.remedy).toBe("Resume once it may run, or re-run the stage.");
    expect(c.preferRerun).toBe(true);
  });
  it("explains a resumed session whose deferred tool is gone", () => {
    const c = haltCause(
      "The resumed session was waiting to run mcp__a.b__c, which isn't available anymore. Reconnect it and resume, or re-run the stage fresh.\n(terminal_reason: tool_deferred_unavailable)\n— stderr —\nexit 1",
      25,
    );
    expect(c.title).toBe("The resumed session was waiting to run mcp__a.b__c, which isn't available anymore");
    expect(c.remedy).toBe("Reconnect it and resume, or re-run the stage fresh.");
    expect(c.preferRerun).toBe(true);
  });
  it("prefers Resume for other halts", () => {
    expect(haltCause("claude stopped early (error_max_turns) — review…", 25).preferRerun).toBeFalsy();
    // Text alone, without the backend's marker, is not a deferred halt.
    expect(haltCause("A hook paused Edit before it ran. Resume once it may run.", 25).preferRerun).toBeFalsy();
  });
  it("explains an idle timeout", () => {
    expect(haltCause("claude timed out — no output for 5 minutes", 25).title).toMatch(/no output/i);
  });
  it("falls back to the first line", () => {
    expect(haltCause("something weird\nsecond line", 25).title).toBe("something weird");
  });
  it("handles null", () => {
    expect(haltCause(null, 25).title).toBe("Stage halted");
  });
});
