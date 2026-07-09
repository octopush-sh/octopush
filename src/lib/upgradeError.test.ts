import { describe, it, expect } from "vitest";
import { isUpgradeRequired } from "./upgradeError";

describe("isUpgradeRequired", () => {
  it("parses a structured UpgradeRequired object", () => {
    const info = isUpgradeRequired({ kind: "UpgradeRequired", feature: "direct.unlimited", used: 25, limit: 25 });
    expect(info).toEqual({ feature: "direct.unlimited", used: 25, limit: 25 });
  });

  it("parses a JSON-string UpgradeRequired error", () => {
    const info = isUpgradeRequired('{"kind":"UpgradeRequired","feature":"direct.unlimited","used":30,"limit":25}');
    expect(info?.used).toBe(30);
    expect(info?.limit).toBe(25);
  });

  it("returns null for a plain error string", () => {
    expect(isUpgradeRequired("another run is already in progress")).toBeNull();
  });

  it("returns null for a different structured error", () => {
    expect(isUpgradeRequired({ kind: "AuthRequired" })).toBeNull();
  });

  it("returns null when fields are missing/wrong type", () => {
    expect(isUpgradeRequired({ kind: "UpgradeRequired", feature: "x" })).toBeNull();
    expect(isUpgradeRequired({ kind: "UpgradeRequired", feature: "x", used: "25", limit: 25 })).toBeNull();
  });
});
