import { describe, it, expect, beforeEach } from "vitest";
import { useScratchpadStore } from "./scratchpadStore";

describe("useScratchpadStore", () => {
  beforeEach(() => {
    useScratchpadStore.getState().reset();
  });

  it("initializes with empty state", () => {
    const state = useScratchpadStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBe(null);
  });

  it("creates a new tab with auto-incremented name", () => {
    useScratchpadStore.getState().createTab();
    const state = useScratchpadStore.getState();

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].name).toBe("Untitled 1");
    expect(state.tabs[0].content).toBe("");
    expect(state.tabs[0].language).toBe("plaintext");
    expect(state.activeTabId).toBe(state.tabs[0].id);
  });

  it("creates multiple tabs with correct names", () => {
    const state = useScratchpadStore.getState();
    state.createTab();
    state.createTab();
    state.createTab();

    const updated = useScratchpadStore.getState();
    expect(updated.tabs).toHaveLength(3);
    expect(updated.tabs[0].name).toBe("Untitled 1");
    expect(updated.tabs[1].name).toBe("Untitled 2");
    expect(updated.tabs[2].name).toBe("Untitled 3");
  });

  it("sets content for a tab", () => {
    const state = useScratchpadStore.getState();
    state.createTab();
    const tabId = useScratchpadStore.getState().tabs[0].id;

    state.setContent(tabId, "console.log('hello')");
    const updated = useScratchpadStore.getState();
    expect(updated.tabs[0].content).toBe("console.log('hello')");
  });

  it("renames a tab and detects language", () => {
    const state = useScratchpadStore.getState();
    state.createTab();
    const tabId = useScratchpadStore.getState().tabs[0].id;

    state.renameTab(tabId, "script.sh");
    const updated = useScratchpadStore.getState();
    expect(updated.tabs[0].name).toBe("script.sh");
    expect(updated.tabs[0].language).toBe("shell");
  });

  it("prevents empty tab names (reverts to original)", () => {
    const state = useScratchpadStore.getState();
    state.createTab();
    const initialState = useScratchpadStore.getState();
    const tabId = initialState.tabs[0].id;
    const originalName = initialState.tabs[0].name;

    state.renameTab(tabId, "");
    const updated = useScratchpadStore.getState();
    expect(updated.tabs[0].name).toBe(originalName);
  });

  it("prevents duplicate tab names (appends number)", () => {
    const state = useScratchpadStore.getState();
    state.createTab();
    state.createTab();
    const initialState = useScratchpadStore.getState();
    const firstTabId = initialState.tabs[0].id;
    const secondTabId = initialState.tabs[1].id;

    // Rename first tab to "data.json"
    state.renameTab(firstTabId, "data.json");
    // Try to rename second tab to the same name
    state.renameTab(secondTabId, "data.json");

    const updated = useScratchpadStore.getState();
    // Should append number before extension to prevent collision
    expect(updated.tabs[0].name).toBe("data.json");
    expect(updated.tabs[1].name).toBe("data1.json");
  });

  it("deletes a tab", () => {
    const state = useScratchpadStore.getState();
    state.createTab();
    state.createTab();
    const initialState = useScratchpadStore.getState();
    const firstTabId = initialState.tabs[0].id;

    state.deleteTab(firstTabId);
    const updated = useScratchpadStore.getState();
    expect(updated.tabs).toHaveLength(1);
  });

  it("switches active tab", () => {
    const state = useScratchpadStore.getState();
    state.createTab();
    state.createTab();
    const initialState = useScratchpadStore.getState();
    const secondTabId = initialState.tabs[1].id;

    state.setActiveTab(secondTabId);
    const updated = useScratchpadStore.getState();
    expect(updated.activeTabId).toBe(secondTabId);
  });

  it("toggles open state", () => {
    let state = useScratchpadStore.getState();
    expect(state.isOpen).toBe(false);

    state.toggleOpen();
    state = useScratchpadStore.getState();
    expect(state.isOpen).toBe(true);

    state.toggleOpen();
    state = useScratchpadStore.getState();
    expect(state.isOpen).toBe(false);
  });

  it("closes scratchpad when deleting last tab", () => {
    const state = useScratchpadStore.getState();
    state.createTab();
    const initialState = useScratchpadStore.getState();
    const tabId = initialState.tabs[0].id;

    state.deleteTab(tabId);
    const updated = useScratchpadStore.getState();
    expect(updated.tabs).toHaveLength(0);
    expect(updated.isOpen).toBe(false);
  });

  it("preserves content when switching workspaces (session state)", () => {
    const state = useScratchpadStore.getState();
    state.createTab();
    const initialState = useScratchpadStore.getState();
    state.setContent(initialState.tabs[0].id, "test content");

    const updated = useScratchpadStore.getState();
    expect(updated.tabs[0].content).toBe("test content");
  });
});
