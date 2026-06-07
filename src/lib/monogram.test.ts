import { describe, it, expect } from "vitest";
import { resolveMonogram, TINTS, TINT_NAMES } from "./monogram";
import type { Workspace } from "./types";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    projectId: "proj-1",
    name: "Auth refactor",
    task: "Fix the JWT validation",
    branch: "feat/auth",
    worktreePath: null,
    setupScript: "",
    status: "active",
    createdAt: "2026-05-16T00:00:00Z",
    lastActive: "2026-05-16T00:00:00Z",
    glyph: null,
    tint: null,
    linkedIssueKey: null,
    ...overrides,
  };
}

describe("monogram resolution", () => {
  it("uses the first letter of the workspace name when no glyph is set", () => {
    const m = resolveMonogram(makeWorkspace({ name: "Auth refactor" }));
    expect(m.glyph).toBe("A");
    expect(m.isCustom).toBe(false);
  });

  it("uppercases the first letter", () => {
    const m = resolveMonogram(makeWorkspace({ name: "auth-refactor" }));
    expect(m.glyph).toBe("A");
  });

  it("uses the custom glyph when set", () => {
    const m = resolveMonogram(makeWorkspace({ glyph: "§" }));
    expect(m.glyph).toBe("§");
    expect(m.isCustom).toBe(true);
  });

  it("defaults tint to brass when not set", () => {
    const m = resolveMonogram(makeWorkspace({ tint: null }));
    expect(m.tint).toBe("brass");
  });

  it("uses the custom tint when set", () => {
    const m = resolveMonogram(makeWorkspace({ tint: "verdigris" }));
    expect(m.tint).toBe("verdigris");
    expect(m.isCustom).toBe(true);
  });

  it("falls back to '?' when the workspace name is empty", () => {
    const m = resolveMonogram(makeWorkspace({ name: "" }));
    expect(m.glyph).toBe("?");
  });

  it("considers either glyph OR tint customization as 'is custom'", () => {
    expect(resolveMonogram(makeWorkspace({ glyph: "X", tint: null })).isCustom).toBe(true);
    expect(resolveMonogram(makeWorkspace({ glyph: null, tint: "rouge" })).isCustom).toBe(true);
    expect(resolveMonogram(makeWorkspace({ glyph: null, tint: null })).isCustom).toBe(false);
  });
});

describe("tint preset table", () => {
  it("exposes 7 tint presets", () => {
    expect(TINT_NAMES).toEqual([
      "brass", "verdigris", "rouge", "indigo", "lavender", "smoke", "bone",
    ]);
  });

  it("each preset has accent and bg colors", () => {
    for (const name of TINT_NAMES) {
      expect(TINTS[name].accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(TINTS[name].bg).toMatch(/^rgba\(/);
    }
  });

  it("brass preset uses the Atelier accent color", () => {
    expect(TINTS.brass.accent).toBe("#d4a574");
  });

  it("rouge preset uses the design system rouge", () => {
    expect(TINTS.rouge.accent).toBe("#d18b8b");
  });
});
