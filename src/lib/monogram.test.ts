import { describe, it, expect } from "vitest";
import { normalizeGlyph, resolveMonogram, TINTS, TINT_NAMES } from "./monogram";
import { paletteWorkspaces } from "./paletteWorkspaces";
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
    fromBranch: null,
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

describe("glyph normalization (#848)", () => {
  it("a main workspace reads M, never ß", () => {
    expect(resolveMonogram(makeWorkspace({ name: "main" })).glyph).toBe("M");
  });

  it("a stored ß (macOS ⌥S) falls back to the name's initial", () => {
    const m = resolveMonogram(makeWorkspace({ name: "main", glyph: "ß" }));
    expect(m.glyph).toBe("M");
    expect(normalizeGlyph("ß")).toBeNull();
  });

  it("never renders a multi-letter capital form", () => {
    expect(resolveMonogram(makeWorkspace({ name: "ßeta" })).glyph).toBe("S");
    expect(normalizeGlyph("ﬁ")).toBeNull();
  });

  it("uppercases a lowercase stored glyph and keeps symbols, digits and emoji whole", () => {
    expect(normalizeGlyph("m")).toBe("M");
    expect(normalizeGlyph(" é ")).toBe("É");
    expect(normalizeGlyph("7")).toBe("7");
    expect(normalizeGlyph("•")).toBe("•");
    expect(normalizeGlyph("🐙x")).toBe("🐙");
  });

  it("treats empty, whitespace and control input as no glyph", () => {
    expect(normalizeGlyph("")).toBeNull();
    expect(normalizeGlyph("   ")).toBeNull();
    expect(normalizeGlyph("\u0007")).toBeNull();
    expect(resolveMonogram(makeWorkspace({ name: "main", glyph: "" })).glyph).toBe("M");
  });

  it("the rail and ⌘K resolve the same glyph", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "main", glyph: "ß" }),
      makeWorkspace({ id: "b", name: "auth", glyph: "x" }),
      makeWorkspace({ id: "c", name: "ßeta" }),
    ];
    const rows = paletteWorkspaces([{ name: "p", workspaces }], {}, {}, {});
    for (const w of workspaces) {
      expect(rows.find((r) => r.id === w.id)?.glyph).toBe(resolveMonogram(w).glyph);
    }
    expect(rows.map((r) => r.glyph).sort()).toEqual(["M", "S", "X"]);
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

describe("normalizeGlyph private-use symbols", () => {
  it("keeps a private-use symbol such as the Apple logo", () => {
    expect(normalizeGlyph("\uF8FF")).toBe("\uF8FF");
  });
  it("still drops control characters", () => {
    expect(normalizeGlyph("\u0007")).toBeNull();
  });
});
