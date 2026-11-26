import { describe, it, expect, beforeEach } from "vitest";
import type { CrewPreview } from "./ipc";
import type { ProviderConfig } from "./types";
import { catalogModelIds, cliShellLine, escalationLine, flaggedModels, loopLine, modelFlagText, openDroppedCrew } from "./crew";
import { useCrewImportStore } from "../stores/crewImportStore";

const preview = (stages: Partial<CrewPreview["stages"][number]>[]): CrewPreview => ({
  name: "c",
  description: "",
  roles: [],
  problems: [],
  ok: true,
  stages: stages.map((s, i) => ({
    position: i, label: "s", role: "plan", agentModel: "a", escalateModel: null, substrate: "api",
    cliDialect: null, checkpoint: false, readOnly: true, actionRole: false, tools: [], instructions: null,
    effort: null, escalateEffort: null, loopTargetPosition: null, loopMode: null, loopMaxIterations: 0,
    unpricedModel: false, unpricedEscalate: false, warnings: [], problem: null, ...s,
  })),
});

describe("crew stage lines", () => {
  it("names a CLI stage's real power by dialect, and nothing on API", () => {
    const [claude, codex, codexRo, api] = preview([
      { substrate: "cli", cliDialect: "claude", readOnly: false },
      { substrate: "cli", cliDialect: "codex", readOnly: false },
      { substrate: "cli", cliDialect: "codex", readOnly: true },
      {},
    ]).stages;
    expect(cliShellLine(claude)).toBe("Full shell · Claude Code (all permissions)");
    expect(cliShellLine(codex)).toBe("Full shell · Codex (workspace-write sandbox)");
    expect(cliShellLine(codexRo)).toBe("Shell · Codex (read-only sandbox)");
    expect(cliShellLine(api)).toBeNull();
  });

  it("spells out loops and escalation", () => {
    const [looping, plain, esc] = preview([
      { loopTargetPosition: 1, loopMode: "gated", loopMaxIterations: 9 },
      {},
      { escalateEffort: "max" },
    ]).stages;
    expect(loopLine(looping)).toBe("Loops back to stage 2 · gated · up to ×9");
    expect(loopLine(plain)).toBeNull();
    expect(escalationLine(plain)).toBeNull();
    expect(escalationLine(esc)).toBe("escalates · effort max");
  });
});

describe("crew model flags", () => {
  it("reads only enabled providers into the catalog", () => {
    const ids = catalogModelIds([
      { enabled: true, models: [{ id: "a" }] },
      { enabled: false, models: [{ id: "b" }] },
    ] as unknown as ProviderConfig[]);
    expect([...ids]).toEqual(["a"]);
  });

  it("flags models missing from the catalog or unpriced, once each, escalation included", () => {
    const flags = flaggedModels(
      preview([
        { agentModel: "a" },
        { agentModel: "ghost", unpricedModel: true, escalateModel: "free-local", unpricedEscalate: true },
        { agentModel: "ghost", unpricedModel: true },
        { agentModel: "listed-unpriced", unpricedModel: true },
      ]),
      new Set(["a", "free-local", "listed-unpriced"]),
    );
    expect(flags.map((f) => [f.model, modelFlagText(f)])).toEqual([
      ["ghost", "not in your catalog · unpriced"],
      ["free-local", "unpriced"],
      ["listed-unpriced", "unpriced"],
    ]);
  });
});

describe("openDroppedCrew", () => {
  beforeEach(() => useCrewImportStore.getState().close());

  const dropOf = (files: File[]) => {
    let prevented = false;
    const e = {
      dataTransfer: { files, types: ["Files"] },
      preventDefault: () => { prevented = true; },
    } as unknown as React.DragEvent;
    return { e, prevented: () => prevented };
  };

  it("opens the review sheet on a dropped .octocrew.json", async () => {
    const { e, prevented } = dropOf([new File(["{\"octocrew\":1}"], "relay.octocrew.json")]);
    expect(openDroppedCrew(e)).toBe(true);
    expect(prevented()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const s = useCrewImportStore.getState();
    expect(s.open).toBe(true);
    expect(s.text).toBe("{\"octocrew\":1}");
    expect(s.origin).toBe("relay.octocrew.json");
  });

  it("leaves other drops to the caller", () => {
    const { e, prevented } = dropOf([new File(["x"], "shot.png")]);
    expect(openDroppedCrew(e)).toBe(false);
    expect(prevented()).toBe(false);
    expect(useCrewImportStore.getState().open).toBe(false);
  });
});
