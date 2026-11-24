import { describe, it, expect } from "vitest";
import {
  archivableMerge,
  archivableMissions,
  archiveMergedBody,
  missionState,
  runsState,
  runStatesByWs,
} from "./railState";
import { fleetCounts } from "./runStatus";
import type { Pr } from "./types";

const gate = { status: "paused", planWait: null } as const;
const planPark = { status: "paused", planWait: { resumeAt: "2026-11-22T10:00:00Z", otherHold: false } } as never;
const running = { status: "running", planWait: null } as const;
const done = { status: "completed", planWait: null } as const;
const MERGED: Pr = { number: 7, title: "Fix", url: "u", isDraft: false, state: "merged" };

describe("runsState", () => {
  it("agrees with the fleet chip's split", () => {
    for (const runs of [[gate], [planPark], [running], [done], [done, gate], [running, gate], []]) {
      const { needsYou, inFlight } = fleetCounts(runs as never);
      const expected = needsYou > 0 ? "needs-you" : inFlight > 0 ? "working" : "idle";
      expect(runsState(runs as never)).toBe(expected);
    }
  });

  it("is idle without runs", () => {
    expect(runsState(undefined)).toBe("idle");
  });
});

describe("missionState", () => {
  it("raises an idle mission to working while something works in it, never one that needs you", () => {
    expect(missionState("idle", true)).toBe("working");
    expect(missionState(undefined, true)).toBe("working");
    expect(missionState("needs-you", true)).toBe("needs-you");
    expect(missionState(undefined, false)).toBe("idle");
  });

  it("is computed per workspace from the store's runs", () => {
    expect(runStatesByWs({ a: [gate], b: [done] } as never)).toEqual({ a: "needs-you", b: "idle" });
  });
});

describe("archivableMerge", () => {
  it("offers only an idle, unchanged mission with a merged PR and no open one", () => {
    expect(archivableMerge("a", "idle", { a: MERGED }, {}, {})).toBe(MERGED);
    expect(archivableMerge("a", "working", { a: MERGED }, {}, {})).toBeNull();
    expect(archivableMerge("a", "needs-you", { a: MERGED }, {}, {})).toBeNull();
    expect(archivableMerge("a", "idle", {}, {}, {})).toBeNull();
    expect(archivableMerge("a", "idle", { a: MERGED }, { a: { ...MERGED, state: "open" } }, {})).toBeNull();
    const summary = (dirty: boolean, ahead: number) => ({ a: { workspaceId: "a", dirty, ahead, behind: 0 } });
    expect(archivableMerge("a", "idle", { a: MERGED }, {}, summary(true, 0))).toBeNull();
    expect(archivableMerge("a", "idle", { a: MERGED }, {}, summary(false, 2))).toBeNull();
    expect(archivableMerge("a", "idle", { a: MERGED }, {}, summary(false, 0))).toBe(MERGED);
  });

  it("lists exactly the archivable missions, in order", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const out = archivableMissions(rows, { b: "needs-you" }, { c: false }, { a: MERGED, b: MERGED, c: MERGED }, {}, {});
    expect(out.map((w) => w.id)).toEqual(["a", "c"]);
  });
});

describe("archiveMergedBody", () => {
  const m = (name: string, localFiles: string[] = []) => ({ name, localFiles });

  it("names the missions, then what archiving does", () => {
    expect(archiveMergedBody([m("fix-a")])).toBe(
      "fix-a: its PR is merged and its worktree is clean. Archiving removes the worktree and keeps the branch; the notice that follows can undo it. Claude Code's \"don't ask again\" choices saved in the worktree are lost too.",
    );
    expect(archiveMergedBody(["a", "b", "c"].map((n) => m(n)))).toMatch(/^a, b and c: their PRs are merged/);
  });

  it("names the first eight and counts the rest", () => {
    const names = Array.from({ length: 10 }, (_, i) => m(`m${i}`));
    expect(archiveMergedBody(names)).toMatch(/^m0, m1, m2, m3, m4, m5, m6, m7 and 2 more:/);
  });

  it("marks a mission with local files and says Undo doesn't bring them back", () => {
    const body = archiveMergedBody([m("fix-a", [".env", "data.db"]), m("fix-b")]);
    expect(body).toMatch(/^fix-a \(has local files\) and fix-b:/);
    expect(body).toMatch(/deletes local files git ignores \(\.env, data\.db\); Undo doesn't bring them back\./);
    expect(body).toMatch(/"don't ask again" choices saved in the worktrees are lost too\.$/);
    expect(archiveMergedBody([m("x", ["a", "b", "c", "d"])])).toMatch(/\(a, b, c and 1 more\)/);
  });
});
