import { beforeEach, describe, expect, it, vi } from "vitest";

const cliVersionMock = vi.hoisted(() => vi.fn());
vi.mock("./ipc", () => ({ ipc: { claudeCliVersion: cliVersionMock } }));

const {
  claudeUpdateLabel,
  cliTooOldForEffort,
  crewUsesClaudeCode,
  effortApplies,
  loadClaudeCliVersion,
  resetClaudeCliVersionCache,
  runsOnClaudeCode,
} = await import("./claudeCli");

beforeEach(() => {
  resetClaudeCliVersionCache();
  cliVersionMock.mockReset();
});

describe("claudeUpdateLabel", () => {
  it("names the floor only for a known version below it", () => {
    expect(claudeUpdateLabel({ version: "2.1.307", floor: "2.1.314", belowFloor: true })).toBe(
      "Update Claude Code (2.1.314 or newer recommended)",
    );
    expect(claudeUpdateLabel({ version: "2.1.316", floor: "2.1.314", belowFloor: false })).toBeNull();
    expect(claudeUpdateLabel({ version: null, floor: "2.1.314", belowFloor: false })).toBeNull();
    expect(claudeUpdateLabel(null)).toBeNull();
  });
});

describe("crewUsesClaudeCode", () => {
  const stage = (substrate: string, agentModel: string, position = 0) => ({ position, substrate, agentModel });

  it("mirrors the backend's CLI dialect choice", () => {
    expect(runsOnClaudeCode("claude-sonnet-4-6")).toBe(true);
    expect(runsOnClaudeCode("my-proxy-model")).toBe(true); // unknown ids run on claude
    expect(runsOnClaudeCode("gpt-5")).toBe(false);
    expect(runsOnClaudeCode("o3-mini")).toBe(false);
    expect(runsOnClaudeCode("gpt-5-codex")).toBe(false);
  });

  it("counts only CLI stages, with overrides applied", () => {
    expect(crewUsesClaudeCode([stage("api", "claude-sonnet-4-6")], {})).toBe(false);
    expect(crewUsesClaudeCode([stage("cli", "claude-sonnet-4-6")], {})).toBe(true);
    expect(crewUsesClaudeCode([stage("cli", "gpt-5")], {})).toBe(false);
    expect(crewUsesClaudeCode([stage("cli", "gpt-5")], { 0: "claude-opus-4-8" })).toBe(true);
    expect(crewUsesClaudeCode([stage("cli", "claude-sonnet-4-6")], { 0: "gpt-5" })).toBe(false);
  });
});

describe("effortApplies", () => {
  it("mirrors the backend: API, and Claude Code CLI stages, but not Codex", () => {
    expect(effortApplies("api", "gpt-5")).toBe(true);
    expect(effortApplies("cli", "claude-opus-5-5")).toBe(true);
    expect(effortApplies("cli", "my-proxy-model")).toBe(true);
    expect(effortApplies("cli", "gpt-5-codex")).toBe(false);
  });

  it("hides CLI effort only for a known version below the floor", () => {
    expect(cliTooOldForEffort({ version: "2.1.307", floor: "2.1.314", belowFloor: true })).toBe(true);
    expect(cliTooOldForEffort({ version: "2.1.316", floor: "2.1.314", belowFloor: false })).toBe(false);
    expect(cliTooOldForEffort({ version: null, floor: "2.1.314", belowFloor: false })).toBe(false);
    expect(cliTooOldForEffort(null)).toBe(false);
  });
});

describe("loadClaudeCliVersion", () => {
  it("fetches once per session", async () => {
    cliVersionMock.mockResolvedValue({ version: "2.1.316", floor: "2.1.314", belowFloor: false });
    await loadClaudeCliVersion();
    await loadClaudeCliVersion();
    expect(cliVersionMock).toHaveBeenCalledTimes(1);
  });

  it("resolves null on failure and retries next time", async () => {
    cliVersionMock.mockRejectedValueOnce(new Error("no tauri"));
    expect(await loadClaudeCliVersion()).toBeNull();
    cliVersionMock.mockResolvedValue({ version: "2.1.316", floor: "2.1.314", belowFloor: false });
    expect((await loadClaudeCliVersion())?.version).toBe("2.1.316");
    expect(cliVersionMock).toHaveBeenCalledTimes(2);
  });
});
