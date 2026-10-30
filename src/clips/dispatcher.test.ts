import { describe, expect, it } from "vitest";
import { createDispatcher, defaultFor } from "./dispatcher";
import { SCENARIOS } from "../../scripts/clips/scenarios";

describe("clip harness dispatcher", () => {
  it("serves fixtures, calls handlers with args and logs defaults", () => {
    const { handle, log } = createDispatcher({
      name: "t",
      description: "",
      commands: { fixed: [1, 2], fn: (a) => `ws:${String(a.workspaceId)}` },
    });
    expect(handle("fixed")).toEqual([1, 2]);
    expect(handle("fn", { workspaceId: "w1" })).toBe("ws:w1");
    expect(handle("list_things")).toEqual([]);
    expect(handle("list_things")).toEqual([]);
    expect(log.calls).toEqual({ fixed: 1, fn: 1, list_things: 2 });
    expect(log.defaulted).toEqual(["list_things"]);
  });

  it("returns a fresh copy of fixed fixtures so the app can't mutate the scenario", () => {
    const { handle } = createDispatcher({ name: "t", description: "", commands: { obj: { a: 1 } } });
    (handle("obj") as { a: number }).a = 2;
    expect(handle("obj")).toEqual({ a: 1 });
  });

  it("records handlers that throw", () => {
    const { handle, log } = createDispatcher({ name: "t", description: "", commands: { boom: () => { throw new Error("x"); } } });
    expect(() => handle("boom")).toThrow("x");
    expect(log.failed).toEqual(["boom"]);
  });

  it("defaults by naming convention", () => {
    expect(defaultFor("list_runs")).toEqual([]);
    expect(defaultFor("workspaces_git_summary")).toEqual([]);
    expect(defaultFor("is_pro")).toBe(false);
    expect(defaultFor("get_run")).toBeNull();
    expect(defaultFor("plugin:updater|check")).toBeNull();
    expect(defaultFor("plugin:window|scale_factor")).toBe(1);
  });

  it("scenario keys match their names", () => {
    for (const [key, s] of Object.entries(SCENARIOS)) expect(s.name).toBe(key);
    expect(Object.keys(SCENARIOS)).toEqual(expect.arrayContaining(["default", "empty"]));
  });
});
