import { describe, it, expect, beforeEach } from "vitest";
import { useScratchpadStore } from "./scratchpadStore";

describe("ScratchpadStore - toggleOpen Issue Diagnosis", () => {
  beforeEach(() => {
    const store = useScratchpadStore.getState();
    store.reset?.();
  });

  it("DEBUG: toggleOpen should create first tab", () => {
    console.log("\n[DEBUG] Initial state:");
    let state = useScratchpadStore.getState();
    console.log(`  isOpen: ${state.isOpen}`);
    console.log(`  tabs.length: ${state.tabs.length}`);
    console.log(`  tabs: ${JSON.stringify(state.tabs)}`);

    console.log("\n[DEBUG] Calling toggleOpen()...");
    const store = useScratchpadStore.getState();
    store.toggleOpen();

    console.log("\n[DEBUG] After toggleOpen (using old reference):");
    console.log(`  store.isOpen: ${store.isOpen}`);
    console.log(`  store.tabs.length: ${store.tabs.length}`);
    console.log(`  store.tabs: ${JSON.stringify(store.tabs)}`);

    console.log("\n[DEBUG] After toggleOpen (getting fresh state):");
    state = useScratchpadStore.getState();
    console.log(`  state.isOpen: ${state.isOpen}`);
    console.log(`  state.tabs.length: ${state.tabs.length}`);
    console.log(`  state.tabs: ${JSON.stringify(state.tabs)}`);

    expect(state.isOpen).toBe(true);
    expect(state.tabs.length).toBe(1);
    expect(state.tabs[0]?.name).toBe("Untitled 1");
  });

  it("DEBUG: Check what toggleOpen is returning", () => {
    const store = useScratchpadStore.getState();

    console.log("\n[DEBUG] Before toggleOpen:");
    console.log(`  store.isOpen: ${store.isOpen}`);
    console.log(`  store.tabs.length: ${store.tabs.length}`);

    const result = store.toggleOpen();
    console.log(`\n[DEBUG] toggleOpen returned: ${result}`);

    const newState = useScratchpadStore.getState();
    console.log("\n[DEBUG] After toggleOpen:");
    console.log(`  newState.isOpen: ${newState.isOpen}`);
    console.log(`  newState.tabs.length: ${newState.tabs.length}`);
    console.log(`  newState.tabs: ${JSON.stringify(newState.tabs)}`);
  });
});
