import { beforeEach, describe, expect, it, vi } from "vitest";

const cliVersionMock = vi.hoisted(() => vi.fn());
vi.mock("./ipc", () => ({ ipc: { claudeCliVersion: cliVersionMock } }));

const {
  claudeSecurityLabel,
  claudeUpdateLabel,
  cliTooOldForEffort,
  codexEffortLevel,
  crewClaudeModels,
  crewUsesClaudeCode,
  effortApplies,
  loadClaudeCliVersion,
  modelFloorLabel,
  resetClaudeCliVersionCache,
  runsOnClaudeCode,
} = await import("./claudeCli");

beforeEach(() => {
  resetClaudeCliVersionCache();
  cliVersionMock.mockReset();
});

describe("crewClaudeModels", () => {
  it("lists each Claude Code CLI stage's model and escalation model once", () => {
    const stages = [
      { position: 0, substrate: "cli", agentModel: "claude-sonnet-5-5", escalateModel: "claude-fable-5-2" },
      { position: 1, substrate: "cli", agentModel: "claude-haiku-5-5" },
      { position: 2, substrate: "api", agentModel: "claude-fable-5-1", escalateModel: "claude-fable-5-1" },
      { position: 3, substrate: "cli", agentModel: "gpt-5-codex", escalateModel: "claude-fable-5-2" },
    ];
    expect(crewClaudeModels(stages, { 1: "claude-fable-5-1" })).toEqual(["claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"]);
    expect(crewClaudeModels(stages.slice(2, 3), {})).toEqual([]);
  });
});

describe("modelFloorLabel", () => {
  it("names the model, the version it needs and the installed one", () => {
    expect(modelFloorLabel({ label: "Fable 5.2", needs: "2.1.321", installed: "2.1.316" })).toBe(
      "Fable 5.2 needs Claude Code 2.1.321 or newer — this Mac has 2.1.316.",
    );
    expect(modelFloorLabel(null)).toBeNull();
  });
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

  it("names the backend's recommended version when the floor still lacks a security fix", () => {
    expect(claudeUpdateLabel({ version: "2.1.307", floor: "2.1.314", belowFloor: true, recommended: "2.1.319" })).toBe(
      "Update Claude Code (2.1.319 or newer recommended)",
    );
  });
});

describe("claudeSecurityLabel", () => {
  const fix = { version: "2.1.319", reason: "fixes a sandbox escape when creating a worktree" };

  it("names the missing fix for a known version at or above the floor", () => {
    expect(claudeSecurityLabel({ version: "2.1.316", floor: "2.1.314", belowFloor: false, securityFix: fix })).toBe(
      "Update Claude Code: 2.1.319 fixes a sandbox escape when creating a worktree",
    );
    expect(claudeSecurityLabel({ version: "2.1.319", floor: "2.1.314", belowFloor: false, securityFix: null })).toBeNull();
    expect(claudeSecurityLabel({ version: "2.1.319", floor: "2.1.314", belowFloor: false })).toBeNull();
  });

  it("yields to the tested-floor label, and never warns on an unknown version", () => {
    const old = { version: "2.1.307", floor: "2.1.314", belowFloor: true, securityFix: fix };
    expect(claudeUpdateLabel(old)).not.toBeNull();
    expect(claudeSecurityLabel(old)).toBeNull();
    expect(claudeSecurityLabel({ version: null, floor: "2.1.314", belowFloor: false, securityFix: fix })).toBeNull();
    expect(claudeSecurityLabel(null)).toBeNull();
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
  it("mirrors the backend: API, and CLI stages on Claude Code and Codex", () => {
    expect(effortApplies("api", "gpt-5")).toBe(true);
    expect(effortApplies("cli", "claude-opus-5-5")).toBe(true);
    expect(effortApplies("cli", "my-proxy-model")).toBe(true);
    expect(effortApplies("cli", "gpt-5-codex")).toBe(true);
    expect(effortApplies("bogus", "claude-opus-5-5")).toBe(false);
  });

  it("passes max to Codex only on gpt-6, xhigh elsewhere", () => {
    expect(codexEffortLevel("gpt-5-codex", "max")).toBe("xhigh");
    expect(codexEffortLevel("gpt-6.1-terra", "max")).toBe("max");
    expect(codexEffortLevel("GPT-6", "max")).toBe("max");
    expect(codexEffortLevel("gpt-5-codex", "high")).toBe("high");
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
