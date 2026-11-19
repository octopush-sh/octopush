import { describe, it, expect, beforeEach } from "vitest";
import { GROUP_COLLAPSE_KEY, useRailGroupUi, __reloadRailGroupUi } from "./railGroupUiStore";

const stored = () => JSON.parse(localStorage.getItem(GROUP_COLLAPSE_KEY) ?? "{}");

beforeEach(() => {
  localStorage.removeItem(GROUP_COLLAPSE_KEY);
  __reloadRailGroupUi();
});

describe("railGroupUiStore", () => {
  it("persists folds under railGroupCollapsed, with no entry for an open group", () => {
    const ui = useRailGroupUi.getState();
    ui.toggle("a");
    ui.setCollapsed("b", true);
    expect(stored()).toEqual({ a: true, b: true });
    ui.toggle("a");
    expect(stored()).toEqual({ b: true });
    expect(useRailGroupUi.getState().collapsed).toEqual({ b: true });
  });

  it("reads the stored folds back, and survives a broken value", () => {
    localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify({ a: true }));
    __reloadRailGroupUi();
    expect(useRailGroupUi.getState().collapsed).toEqual({ a: true });
    localStorage.setItem(GROUP_COLLAPSE_KEY, "{not json");
    __reloadRailGroupUi();
    expect(useRailGroupUi.getState().collapsed).toEqual({});
    localStorage.setItem(GROUP_COLLAPSE_KEY, "[1]");
    __reloadRailGroupUi();
    expect(useRailGroupUi.getState().collapsed).toEqual({});
  });

  it("keeps one group in rename at a time", () => {
    const ui = useRailGroupUi.getState();
    ui.startRename("a");
    ui.startRename("b");
    expect(useRailGroupUi.getState().renamingId).toBe("b");
    ui.stopRename();
    expect(useRailGroupUi.getState().renamingId).toBeNull();
  });

  it("forgets a removed group's fold and its rename", () => {
    const ui = useRailGroupUi.getState();
    ui.setCollapsed("a", true);
    ui.setCollapsed("b", true);
    ui.startRename("a");
    ui.forget("a");
    expect(stored()).toEqual({ b: true });
    expect(useRailGroupUi.getState().renamingId).toBeNull();
  });
});
