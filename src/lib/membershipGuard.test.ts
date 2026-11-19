import { describe, it, expect, beforeEach } from "vitest";
import { __resetMembershipGuard, beginMembershipChange, beginMembershipLoad } from "./membershipGuard";
import type { GroupScope } from "./types";

interface Row {
  id: string;
  groupId?: string | null;
}

/** A read the test answers by hand. */
function read() {
  let resolve!: (rows: Row[]) => void;
  const promise = new Promise<Row[]>((res) => (resolve = res));
  return { fetch: () => promise, resolve };
}

/** A reload as the stores run one: read, then overlay and commit in one step. */
async function loadWithMembership(kind: GroupScope, fetch: () => Promise<Row[]>): Promise<Row[]> {
  const guard = beginMembershipLoad(kind);
  try {
    return guard.overlay(await fetch());
  } finally {
    guard.end();
  }
}

beforeEach(() => __resetMembershipGuard());

describe("membershipGuard", () => {
  it("passes rows through when nothing changed", async () => {
    const rows = [{ id: "a", groupId: "g" }, { id: "b", groupId: null }];
    expect(await loadWithMembership("workspace", async () => rows)).toEqual(rows);
  });

  it("lays a change over a read that began before the change settled", async () => {
    const r = read();
    const loading = loadWithMembership("workspace", r.fetch);
    beginMembershipChange("workspace", ["a"], "g").settle();
    r.resolve([{ id: "a", groupId: null }, { id: "b", groupId: null }]);
    expect(await loading).toEqual([{ id: "a", groupId: "g" }, { id: "b", groupId: null }]);
  });

  it("lays a change still in flight over any read", async () => {
    const change = beginMembershipChange("workspace", ["a"], null);
    expect(await loadWithMembership("workspace", async () => [{ id: "a", groupId: "g" }])).toEqual([
      { id: "a", groupId: null },
    ]);
    change.drop();
    expect(await loadWithMembership("workspace", async () => [{ id: "a", groupId: "g" }])).toEqual([
      { id: "a", groupId: "g" },
    ]);
  });

  it("trusts a read that began after the change settled", async () => {
    beginMembershipChange("workspace", ["a"], "g").settle();
    expect(await loadWithMembership("workspace", async () => [{ id: "a", groupId: "other" }])).toEqual([
      { id: "a", groupId: "other" },
    ]);
  });

  it("keeps protecting a settled change while an older read is still out", async () => {
    const old = read();
    const oldLoad = loadWithMembership("workspace", old.fetch);
    beginMembershipChange("workspace", ["a"], "g").settle();
    // A newer read comes and goes; the older one must still be corrected.
    await loadWithMembership("workspace", async () => [{ id: "a", groupId: "g" }]);
    old.resolve([{ id: "a", groupId: null }]);
    expect(await oldLoad).toEqual([{ id: "a", groupId: "g" }]);
  });

  it("keeps projects and workspaces apart, and the newest change to an item wins", async () => {
    beginMembershipChange("project", ["a"], "g1");
    const first = beginMembershipChange("workspace", ["a"], "g2");
    beginMembershipChange("workspace", ["a"], "g3");
    first.drop(); // the older handle no longer owns the item
    expect(await loadWithMembership("workspace", async () => [{ id: "a", groupId: null }])).toEqual([
      { id: "a", groupId: "g3" },
    ]);
    expect(await loadWithMembership("project", async () => [{ id: "a", groupId: null }])).toEqual([
      { id: "a", groupId: "g1" },
    ]);
  });

  it("a failed read still ends, so later changes are not kept forever", async () => {
    await expect(loadWithMembership("workspace", () => Promise.reject(new Error("db")))).rejects.toThrow("db");
    beginMembershipChange("workspace", ["a"], "g").settle();
    expect(await loadWithMembership("workspace", async () => [{ id: "a", groupId: null }])).toEqual([
      { id: "a", groupId: null },
    ]);
  });

  it("judges at the commit, not at the read: a move that starts after the rows came back still shows", () => {
    // A batch reload: this project's rows are back, a slower read is still out.
    const guard = beginMembershipLoad("workspace");
    const fetched: Row[] = [{ id: "a", groupId: null }];
    // An overlay taken now would miss what happens before the commit.
    expect(guard.overlay(fetched)).toEqual([{ id: "a", groupId: null }]);
    beginMembershipChange("workspace", ["a"], "g").settle();
    expect(guard.overlay(fetched)).toEqual([{ id: "a", groupId: "g" }]);
    guard.end();
  });

  it("judges at the commit: a move refused before the commit is not brought back", () => {
    const guard = beginMembershipLoad("workspace");
    const change = beginMembershipChange("workspace", ["a"], "g");
    const fetched: Row[] = [{ id: "a", groupId: null }];
    expect(guard.overlay(fetched)).toEqual([{ id: "a", groupId: "g" }]); // while it is in flight
    change.drop(); // the backend refused it
    expect(guard.overlay(fetched)).toEqual([{ id: "a", groupId: null }]);
    guard.end();
  });
});
