import { describe, it, expect, beforeEach } from "vitest";
import { useCompanionPrefs } from "./companionPrefsStore";

beforeEach(() => {
  localStorage.clear();
  useCompanionPrefs.setState({ workContextCollapsed: {}, setupScriptByProject: {} });
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

  describe("setup-script template per project", () => {
    it("starts empty", () => {
      expect(useCompanionPrefs.getState().setupScriptByProject).toEqual({});
    });

    it("stores the last-used setup script per project id, including the empty string", () => {
      useCompanionPrefs.getState().setSetupScriptForProject("p1", "npm install");
      useCompanionPrefs.getState().setSetupScriptForProject("p2", "");
      const { setupScriptByProject } = useCompanionPrefs.getState();
      expect(setupScriptByProject["p1"]).toBe("npm install");
      expect(setupScriptByProject["p2"]).toBe("");
    });

    it("updating one project does not clobber another", () => {
      useCompanionPrefs.getState().setSetupScriptForProject("p1", "npm ci");
      useCompanionPrefs.getState().setSetupScriptForProject("p2", "make setup");
      useCompanionPrefs.getState().setSetupScriptForProject("p1", "pnpm install");
      const { setupScriptByProject } = useCompanionPrefs.getState();
      expect(setupScriptByProject["p1"]).toBe("pnpm install");
      expect(setupScriptByProject["p2"]).toBe("make setup");
    });

    it("persists to localStorage and rehydrates", () => {
      useCompanionPrefs.getState().setSetupScriptForProject("p1", "npm install");
      const raw = localStorage.getItem("octo-companion-prefs");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.state.setupScriptByProject["p1"]).toBe("npm install");
    });
  });
});
