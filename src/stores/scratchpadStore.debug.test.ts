import { describe, it, expect, beforeEach } from "vitest";
import { useScratchpadStore } from "./scratchpadStore";

/**
 * DEBUG TESTS - Isolate the toggleOpen issue
 */

describe("Scratchpad Store - Debug Tests", () => {
  beforeEach(() => {
    const store = useScratchpadStore.getState();
    store.reset?.();
  });

  it("DEBUG: Store initial state should be correct", () => {
    const store = useScratchpadStore.getState();

    console.log("Initial state:", {
      isOpen: store.isOpen,
      tabs: store.tabs,
      activeTabId: store.activeTabId,
    });

    expect(store.isOpen).toBe(false);
    expect(store.tabs).toEqual([]);
    expect(store.activeTabId).toBe(null);
  });

  it("DEBUG: toggleOpen should exist", () => {
    const store = useScratchpadStore.getState();
    expect(store.toggleOpen).toBeDefined();
    expect(typeof store.toggleOpen).toBe("function");
  });

  it("DEBUG: toggleOpen with empty tabs should create first tab AND set isOpen to true", () => {
    const store = useScratchpadStore.getState();

    console.log("Before toggleOpen:", {
      isOpen: store.isOpen,
      tabs: store.tabs.length,
    });

    // Call toggleOpen
    store.toggleOpen();

    console.log("After toggleOpen:", {
      isOpen: store.isOpen,
      tabs: store.tabs.length,
      firstTabName: store.tabs[0]?.name,
      activeTabId: store.activeTabId,
    });

    // Both should change
    expect(store.isOpen).toBe(true);
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0].name).toBe("Untitled 1");
    expect(store.activeTabId).toBe(store.tabs[0].id);
  });

  it("DEBUG: toggleOpen again should close (not create another tab)", () => {
    const store = useScratchpadStore.getState();

    // First toggle: open
    store.toggleOpen();
    const firstTabId = store.tabs[0]?.id;
    console.log("After first toggle (open):", {
      isOpen: store.isOpen,
      tabs: store.tabs.length,
    });

    // Second toggle: close
    store.toggleOpen();
    console.log("After second toggle (close):", {
      isOpen: store.isOpen,
      tabs: store.tabs.length,
      firstTabStillExists: store.tabs[0]?.id === firstTabId,
    });

    expect(store.isOpen).toBe(false);
    expect(store.tabs).toHaveLength(1); // Tab still exists
    expect(store.tabs[0].id).toBe(firstTabId); // Same tab
  });

  // NOTE: This test was commented out as it uses an outdated Zustand subscribe API.
  // The current Zustand version requires a different subscription pattern.
  // TODO: Update this test to use the current Zustand API if needed.
  /*
  it("DEBUG: Store direct state subscription", (done) => {
    const store = useScratchpadStore.getState();
    let callCount = 0;

    const unsubscribe = useScratchpadStore.subscribe(
      (state) => state.isOpen,
      (isOpen) => {
        callCount++;
        console.log(`Subscription callback ${callCount}: isOpen = ${isOpen}`);
      }
    );

    console.log("Before toggle, subscribed");
    store.toggleOpen();
    console.log(`After toggle, callCount = ${callCount}`);

    unsubscribe();

    // Subscription should be called at least once
    expect(callCount).toBeGreaterThan(0);
    expect(store.isOpen).toBe(true);
    done();
  });
  */

  it("DEBUG: Multiple getState calls should return same store instance", () => {
    const store1 = useScratchpadStore.getState();
    const store2 = useScratchpadStore.getState();

    console.log("store1 === store2:", store1 === store2);
    console.log("store1 is store2:", Object.is(store1, store2));

    expect(store1).toBe(store2);

    // Modify through store1
    store1.toggleOpen();

    // Check through store2
    const store3 = useScratchpadStore.getState();
    console.log("After toggling store1, store3.isOpen:", store3.isOpen);

    expect(store3.isOpen).toBe(true);
  });

  it("DEBUG: Check if reset actually resets", () => {
    const store = useScratchpadStore.getState();

    // Open it
    store.toggleOpen();
    expect(store.isOpen).toBe(true);
    console.log("After toggle: isOpen =", store.isOpen);

    // Reset
    store.reset?.();
    console.log("After reset: isOpen =", store.isOpen);

    expect(store.isOpen).toBe(false);
    expect(store.tabs).toHaveLength(0);
  });

  it("DEBUG: Test the exact flow from test suite", () => {
    // Exactly mimicking the failing test
    const store = useScratchpadStore.getState();

    console.log("1. Initial state:", store.isOpen);
    expect(store.isOpen).toBe(false); // ✓ Pass

    console.log("2. Calling toggleOpen...");
    store.toggleOpen();

    console.log("3. After toggleOpen:", store.isOpen);
    // This is what's failing:
    expect(store.isOpen).toBe(true);
  });
});
