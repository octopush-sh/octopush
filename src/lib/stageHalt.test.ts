import { describe, it, expect } from "vitest";
import { haltCause, isDeferredToolUnavailable } from "./stageHalt";

describe("haltCause", () => {
  it("names a Claude Code release to skip on a gateway max_tokens failure", () => {
    const c = haltCause(
      "Skip Claude Code 2.1.329 on a gateway model: it drops the retry gateway models need when a max_tokens error names a lower limit; 2.1.330 restores it. Update Claude Code, then resume or re-run.\nAPI Error: 400 max_tokens: 64000 > 32768",
      25,
    );
    expect(c.title).toBe("Claude Code 2.1.329 is a release to skip on a gateway model");
    expect(c.remedy).toBe(
      "It drops the retry gateway models need when a max_tokens error names a lower limit; 2.1.330 restores it. Update Claude Code, then resume or re-run.",
    );
    expect(c.preferRerun).toBeUndefined();
    // The CLI's own max_tokens error, on any other release, reads as itself.
    expect(haltCause("API Error: 400 max_tokens: 64000 > 32768", 25).title).toBe("API Error: 400 max_tokens: 64000 > 32768");
  });
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
    const error =
      "The resumed session was waiting to run mcp__a.b__c, which isn't available anymore. Reconnect it and resume, drop the call and continue, or re-run the stage fresh.\n(terminal_reason: tool_deferred_unavailable)\n— stderr —\nexit 1";
    const c = haltCause(error, 25);
    expect(c.title).toBe("The resumed session was waiting to run mcp__a.b__c, which isn't available anymore");
    expect(c.remedy).toBe("Reconnect it and resume, drop the call and continue, or re-run the stage fresh.");
    expect(c.preferRerun).toBe(true);
    expect(isDeferredToolUnavailable(error)).toBe(true);
  });
  it("keeps the paused call's preview whole in the title, dots and all (#973)", () => {
    const error =
      "A hook paused Bash · npm publish --tag beta. && echo done. before it ran. Resume once it may run, or re-run the stage.\n(terminal_reason: tool_deferred)";
    const c = haltCause(error, 25);
    expect(c.title).toBe("A hook paused Bash · npm publish --tag beta. && echo done. before it ran");
    expect(c.remedy).toBe("Resume once it may run, or re-run the stage.");
    // A paused call whose tool is still there has nothing to drop.
    expect(isDeferredToolUnavailable(error)).toBe(false);
    expect(isDeferredToolUnavailable(null)).toBe(false);
  });
  it("prefers Resume for other halts", () => {
    expect(haltCause("claude stopped early (error_max_turns) — review…", 25).preferRerun).toBeFalsy();
    // Text alone, without the backend's marker, is not a deferred halt.
    expect(haltCause("A hook paused Edit before it ran. Resume once it may run.", 25).preferRerun).toBeFalsy();
  });
  it("explains an idle timeout", () => {
    expect(haltCause("claude timed out — no output for 5 minutes", 25).title).toMatch(/no output/i);
  });
  it("names the command an idle timeout waited on", () => {
    const c = haltCause("claude timed out — Bash `npm test` gave no result for 11 minutes", 25);
    expect(c.title).toBe("Bash `npm test` gave no result for 11 minutes");
    expect(c.remedy).toMatch(/still waiting on it/);
  });
  it("names the API retry an idle timeout followed", () => {
    const c = haltCause("claude timed out — no output for 10 minutes after an API retry (overloaded)", 25);
    expect(c.title).toBe("No answer for 10 minutes after an API retry (overloaded)");
    expect(c.remedy).toMatch(/retry delay/);
    expect(haltCause("claude timed out — no output for 6 minutes after an API retry", 25).title).toBe(
      "No answer for 6 minutes after an API retry",
    );
  });
  it("names a stall before the first request, and the update that fixes it", () => {
    const hint =
      "Claude Code 2.1.327 fixes a hang before the first request when a model's settings fetch stalls (for example at a proxy). Update Claude Code";
    const old = haltCause(`claude timed out — Claude Code sent no request in 5 minutes; ${hint}\nlast lines…`, 25);
    expect(old.title).toBe("Claude Code sent no request in 5 minutes");
    expect(old.remedy).toBe(`${hint}, then re-run.`);
    expect(old.preferRerun).toBe(true);
    const current = haltCause("claude timed out — Claude Code sent no request in 5 minutes", 25);
    expect(current.title).toBe("Claude Code sent no request in 5 minutes");
    expect(current.remedy).toMatch(/proxy/);
    expect(current.remedy).not.toMatch(/2\.1\.327/);
  });
  it("falls back to the first line", () => {
    expect(haltCause("something weird\nsecond line", 25).title).toBe("something weird");
  });
  it("handles null", () => {
    expect(haltCause(null, 25).title).toBe("Stage halted");
  });
});
