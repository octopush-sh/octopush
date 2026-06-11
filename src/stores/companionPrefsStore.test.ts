import { describe, it, expect, beforeEach } from "vitest";
import { useCompanionPrefs } from "./companionPrefsStore";

beforeEach(() => {
  localStorage.clear();
  useCompanionPrefs.setState({ workContextCollapsed: {} });
});

describe("companionPrefsStore", () => {
  it("starts with no per-project collapse entries", () => {
    expect(useCompanionPrefs.getState().workContextCollapsed).toEqual({});
  });

  it("stores collapse state per project id", () => {
    useCompanionPrefs.getState().setWorkContextCollapsed("p1", true);
    useCompanionPrefs.getState().setWorkContextCollapsed("p2", false);
    const { workContextCollapsed } = useCompanionPrefs.getState();
    expect(workContextCollapsed["p1"]).toBe(true);
    expect(workContextCollapsed["p2"]).toBe(false);
  });

  it("toggling one project does not clobber another", () => {
    useCompanionPrefs.getState().setWorkContextCollapsed("p1", true);
    useCompanionPrefs.getState().setWorkContextCollapsed("p2", true);
    useCompanionPrefs.getState().setWorkContextCollapsed("p1", false);
    const { workContextCollapsed } = useCompanionPrefs.getState();
    expect(workContextCollapsed["p1"]).toBe(false);
    expect(workContextCollapsed["p2"]).toBe(true);
  });

  it("persists to localStorage under octo-companion-prefs", () => {
    useCompanionPrefs.getState().setWorkContextCollapsed("p1", true);
    const raw = localStorage.getItem("octo-companion-prefs");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.workContextCollapsed["p1"]).toBe(true);
  });
});
