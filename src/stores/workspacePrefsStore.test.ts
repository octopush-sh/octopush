import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspacePrefs, coerceWorkspaceMode } from "./workspacePrefsStore";

function reset() {
  useWorkspacePrefs.setState({ defaultMode: "talk" });
}

describe("workspacePrefsStore", () => {
  beforeEach(reset);

  it("defaults to talk", () => {
    expect(useWorkspacePrefs.getState().defaultMode).toBe("talk");
  });

  it("setDefaultMode updates to a valid mode", () => {
    useWorkspacePrefs.getState().setDefaultMode("run");
    expect(useWorkspacePrefs.getState().defaultMode).toBe("run");
    useWorkspacePrefs.getState().setDefaultMode("direct");
    expect(useWorkspacePrefs.getState().defaultMode).toBe("direct");
  });

  it("setDefaultMode ignores an unknown mode", () => {
    useWorkspacePrefs.getState().setDefaultMode("review");
    // A garbage value (e.g. from stale storage routed through the setter) is rejected.
    useWorkspacePrefs.getState().setDefaultMode("bogus" as never);
    // unchanged from the last valid set
    expect(useWorkspacePrefs.getState().defaultMode).toBe("review");
  });
});

describe("coerceWorkspaceMode (stale-storage guard)", () => {
  it("accepts every known mode", () => {
    for (const m of ["talk", "run", "review", "direct"] as const) {
      expect(coerceWorkspaceMode(m)).toBe(m);
    }
  });

  it("rejects unknown / malformed values as null", () => {
    expect(coerceWorkspaceMode("bogus")).toBeNull();
    expect(coerceWorkspaceMode("")).toBeNull();
    expect(coerceWorkspaceMode(undefined)).toBeNull();
    expect(coerceWorkspaceMode(null)).toBeNull();
    expect(coerceWorkspaceMode(42)).toBeNull();
    expect(coerceWorkspaceMode({ defaultMode: "run" })).toBeNull();
  });
});
