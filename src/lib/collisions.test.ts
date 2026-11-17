import { describe, it, expect } from "vitest";
import {
  collisionsByWorkspace,
  collisionLine,
  collisionSegment,
  collisionTooltip,
  fileList,
  notable,
  worstSeverity,
} from "./collisions";
import type { Collision } from "./types";

const mk = (over: Partial<Collision>): Collision => ({
  a: "ws-a",
  aName: "auth-flow",
  b: "ws-b",
  bName: "refund-webhooks",
  files: ["src/billing/limits.ts", "src/billing/plan.ts"],
  truncated: 0,
  conflictingTruncated: 0,
  conflictingFiles: [],
  severity: "overlap",
  confirmed: true,
  ...over,
});

describe("collision radar — derivation", () => {
  it("gives both sides of a pair an entry naming the other", () => {
    const by = collisionsByWorkspace([mk({})]);
    expect(by["ws-a"].map((c) => c.otherName)).toEqual(["refund-webhooks"]);
    expect(by["ws-b"].map((c) => c.otherName)).toEqual(["auth-flow"]);
  });

  it("sorts each workspace's collisions worst first", () => {
    const by = collisionsByWorkspace([
      mk({ b: "ws-b", bName: "beta", severity: "overlap", files: ["a", "b", "c"] }),
      mk({ b: "ws-c", bName: "gamma", severity: "conflict", files: ["a"], conflictingFiles: ["a"] }),
      mk({ b: "ws-d", bName: "delta", severity: "lockfile", files: ["yarn.lock"] }),
    ]);
    expect(by["ws-a"].map((c) => c.otherName)).toEqual(["gamma", "beta", "delta"]);
    expect(worstSeverity(by["ws-a"])).toBe("conflict");
  });

  it("the same file in three workspaces yields two entries for each", () => {
    const by = collisionsByWorkspace([
      mk({ a: "x", aName: "x", b: "y", bName: "y" }),
      mk({ a: "x", aName: "x", b: "z", bName: "z" }),
      mk({ a: "y", aName: "y", b: "z", bName: "z" }),
    ]);
    expect(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length]))).toEqual({ x: 2, y: 2, z: 2 });
  });

  it("lockfile-only overlaps raise no indicator", () => {
    const by = collisionsByWorkspace([mk({ files: ["package-lock.json"], severity: "lockfile" })]);
    expect(notable(by["ws-a"])).toEqual([]);
    expect(worstSeverity(by["ws-a"])).toBeNull();
    expect(collisionTooltip(by["ws-a"])).toBeNull();
    expect(collisionSegment(by["ws-a"])).toBeNull();
    expect(worstSeverity(undefined)).toBeNull();
  });
});

describe("collision radar — copy", () => {
  it("names the other workspace and the files", () => {
    const [c] = collisionsByWorkspace([mk({})])["ws-a"];
    expect(collisionLine(c)).toBe(
      "Overlaps refund-webhooks · 2 files: src/billing/limits.ts, src/billing/plan.ts",
    );
    expect(collisionSegment([c])).toBe("overlaps refund-webhooks · 2 files");
  });

  it("a confirmed conflict counts only the conflicting files", () => {
    const [c] = collisionsByWorkspace([
      mk({ severity: "conflict", conflictingFiles: ["src/billing/limits.ts"] }),
    ])["ws-b"];
    expect(collisionLine(c)).toBe("Will conflict with auth-flow in 1 file: src/billing/limits.ts");
    expect(collisionSegment([c])).toBe("conflicts with auth-flow · 1 file");
  });

  it("several collisions: one tooltip line each, and a +N on the segment", () => {
    const list = collisionsByWorkspace([
      mk({ b: "ws-b", bName: "beta", files: ["a"] }),
      mk({ b: "ws-c", bName: "gamma", files: ["a", "b"] }),
    ])["ws-a"];
    expect(collisionTooltip(list)?.split("\n")).toEqual([
      "Overlaps gamma · 2 files: a, b",
      "Overlaps beta · 1 file: a",
    ]);
    expect(collisionSegment(list)).toBe("overlaps gamma · 2 files · +1 more");
  });

  it("long file lists are capped", () => {
    expect(fileList(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, d +2 more");
    expect(fileList(["a"])).toBe("a");
  });

  it("files the backend left out still count and show as +N more", () => {
    expect(fileList(["a", "b"], 4, 3)).toBe("a, b +3 more");
    const files = Array.from({ length: 50 }, (_, i) => `f${i}`);
    const [c] = collisionsByWorkspace([mk({ files, truncated: 12 })])["ws-a"];
    expect(collisionLine(c)).toBe("Overlaps refund-webhooks · 62 files: f0, f1, f2, f3 +58 more");
    expect(collisionSegment([c])).toBe("overlaps refund-webhooks · 62 files");
    const [k] = collisionsByWorkspace([
      mk({ severity: "conflict", conflictingFiles: ["x"], conflictingTruncated: 2 }),
    ])["ws-a"];
    expect(collisionLine(k)).toBe("Will conflict with refund-webhooks in 3 files: x +2 more");
  });

  it("ranks by the full file count, truncated paths included", () => {
    const by = collisionsByWorkspace([
      mk({ b: "ws-b", bName: "beta", files: ["a", "b"] }),
      mk({ b: "ws-c", bName: "gamma", files: ["a"], truncated: 5 }),
    ]);
    expect(by["ws-a"].map((c) => c.otherName)).toEqual(["gamma", "beta"]);
  });
});
