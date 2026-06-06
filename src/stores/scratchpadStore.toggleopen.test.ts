import { describe, it, expect, beforeEach } from "vitest";
import { useScratchpadStore } from "./scratchpadStore";

describe("ScratchpadStore - toggleOpen Issue Diagnosis", () => {
  beforeEach(() => {
    const store = useScratchpadStore.getState();
    store.reset?.();
  });

  it("DEBUG: toggleOpen should create first tab", () => {
    let state = useScratchpadStore.getState();

    const store = useScratchpadStore.getState();
    store.toggleOpen();

    state = useScratchpadStore.getState();

    expect(state.isOpen).toBe(true);
    expect(state.tabs.length).toBe(1);
    expect(state.tabs[0]?.name).toBe("Untitled 1");
  });

  it("DEBUG: Check what toggleOpen is returning", () => {
    const store = useScratchpadStore.getState();

    store.toggleOpen();

    useScratchpadStore.getState();
  });
});
