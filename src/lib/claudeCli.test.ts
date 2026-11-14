import { beforeEach, describe, expect, it, vi } from "vitest";
import codexCatalog from "./codexEffortLevels.json";

const cliVersionMock = vi.hoisted(() => vi.fn());
vi.mock("./ipc", () => ({ ipc: { claudeCliVersion: cliVersionMock } }));

const {
  claudeSecurityLabel,
  claudeUpdateLabel,
  cliTooOldForEffort,
  clampToListedLevels,
  codexClampTitle,
  codexEffortLevel,
  codexEffortLevels,
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
      { position: 3, substrate: "cli", agentModel: "gpt-5-codex", escalateModel: "claude-opus-5-5" },
    ];
    // The Codex stage's Claude escalation runs on Claude Code, so it counts.
    expect(crewClaudeModels(stages, { 1: "claude-fable-5-1" })).toEqual([
      "claude-sonnet-5-5",
      "claude-fable-5-2",
      "claude-fable-5-1",
      "claude-opus-5-5",
    ]);
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
  it("mirrors the backend: API, Claude Code, and Codex on a model its catalog knows", () => {
    expect(effortApplies("api", "gpt-5")).toBe(true);
    expect(effortApplies("cli", "claude-opus-5-5")).toBe(true);
    expect(effortApplies("cli", "my-proxy-model")).toBe(true);
    expect(effortApplies("cli", "gpt-5.5")).toBe(true);
    expect(effortApplies("cli", "gpt-5.6-sol")).toBe(true);
    expect(effortApplies("cli", "gpt-5-codex")).toBe(false);
    expect(effortApplies("cli", "o3")).toBe(false);
    expect(effortApplies("api", "gpt-5-codex")).toBe(true);
    expect(effortApplies("bogus", "claude-opus-5-5")).toBe(false);
  });

  it("follows Codex's catalog for every model it lists", () => {
    const levels = ["low", "medium", "high", "xhigh", "max"];
    for (const [slug, listed] of Object.entries(codexCatalog.models)) {
      for (const e of levels) {
        const want = listed.includes(e) ? e : "xhigh"; // only max is ever missing today
        expect(codexEffortLevel(slug, e), `${slug} ${e}`).toBe(want);
      }
    }
    // gpt-5.6-* and codex-auto-review list max too, not only gpt-6*.
    for (const m of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "codex-auto-review", "gpt-6.1-terra"]) {
      expect(codexEffortLevel(m, "max")).toBe("max");
    }
    expect(codexEffortLevel("gpt-5.5", "max")).toBe("xhigh");
    expect(codexEffortLevel("GPT-5.5", "high")).toBe("high");
  });

  it("passes nothing to Codex on a model its catalog doesn't know", () => {
    for (const m of ["gpt-5-codex", "o3", "o4-mini", "gpt-5", "gpt-4o", "GPT-6"]) {
      expect(codexEffortLevels(m)).toBeUndefined();
      for (const e of ["low", "medium", "high", "xhigh", "max"]) expect(codexEffortLevel(m, e)).toBeNull();
    }
  });

  it("matches ids like Codex: longest prefix, then one namespace strip", () => {
    const gpt55 = codexEffortLevels("gpt-5.5");
    expect(gpt55).toBeDefined();
    expect(codexEffortLevels("gpt-5.5-2026-03-01")).toBe(gpt55);
    expect(codexEffortLevels("gpt-6-luna-preview")).toBe(codexEffortLevels("gpt-6-luna"));
    expect(codexEffortLevels("openai/gpt-5.5")).toBe(gpt55);
    expect(codexEffortLevels("OpenAI/GPT-5.5-2026-03-01")).toBe(gpt55);
    expect(codexEffortLevels("a/b/gpt-5.5")).toBeUndefined();
    for (const m of ["gpt-5-codex", "o3", "gpt-6", "openai/o3"]) {
      expect(codexEffortLevels(m), m).toBeUndefined();
      expect(codexEffortLevel(m, "high"), m).toBeNull();
    }
    expect(codexEffortLevel("gpt-5.5-2026-03-01", "max")).toBe("xhigh");
    expect(effortApplies("cli", "gpt-5.5-2026-03-01")).toBe(true);
  });

  it("clamps to a listed level like the Rust helper", () => {
    // Mirrors `codex_clamps_to_the_highest_listed_level_below` in tests.rs.
    for (const e of ["low", "medium", "high", "xhigh", "max"]) {
      expect(clampToListedLevels([], e), e).toBeNull();
      expect(clampToListedLevels(["none", "minimal"], e), e).toBeNull();
    }
    expect(clampToListedLevels(["low", "medium", "high"], "max")).toBe("high");
    expect(clampToListedLevels(["low", "medium", "high"], "xhigh")).toBe("high");
    expect(clampToListedLevels(["medium", "high"], "low")).toBe("medium");
    expect(clampToListedLevels(["low", "high"], "medium")).toBe("low");
  });

  it("says where a clamped Codex level lands, down or up", () => {
    const label = (l: string) => l.toUpperCase();
    expect(codexClampTitle(["low", "high"], "medium", label)).toBe(
      "Runs as LOW on this model in Codex, the highest level it lists below MEDIUM",
    );
    expect(codexClampTitle(["high", "xhigh"], "low", label)).toBe(
      "Runs as HIGH on this model in Codex, the lowest level it lists",
    );
    expect(codexClampTitle(["low", "medium", "high"], "max", label)).toBe(
      "Runs as HIGH on this model in Codex, the highest level it lists below MAX",
    );
    expect(codexClampTitle(["low", "high"], "high", label)).toBeNull();
    expect(codexClampTitle(["none", "minimal"], "high", label)).toBeNull();
    expect(codexClampTitle([], "low", label)).toBeNull();
  });

  it("reads the table the Rust side reads (one shared file)", () => {
    expect(codexCatalog.source).toContain("models.json");
    expect(Object.keys(codexCatalog.models).length).toBeGreaterThanOrEqual(12);
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
