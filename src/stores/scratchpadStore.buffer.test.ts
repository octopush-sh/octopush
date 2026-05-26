import { describe, it, expect, beforeEach, vi } from "vitest";
import { useScratchpadStore } from "./scratchpadStore";

describe("ScratchpadStore - Buffer Logic Tests", () => {
  beforeEach(() => {
    const store = useScratchpadStore.getState();
    store.reset?.();
  });

  it("CRITICAL: Single character input should be stored without duplication", () => {
    const store = useScratchpadStore.getState();

    // Open scratchpad (creates first tab)
    store.toggleOpen();
    const firstTabId = store.tabs[0]?.id;
    expect(firstTabId).toBeDefined();

    // Set content to single character
    store.setContent(firstTabId!, "a");
    const updatedState = useScratchpadStore.getState();
    const updatedTab = updatedState.tabs.find((t) => t.id === firstTabId);

    expect(updatedTab?.content).toBe("a");
    expect(updatedTab?.content.length).toBe(1);
    console.log(`✓ Single character: "${updatedTab?.content}"`);
  });

  it("CRITICAL: Sequential character input should accumulate correctly", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();
    const tabId = store.tabs[0]?.id!;

    const testString = "claude";
    const results: string[] = [];

    for (const char of testString) {
      const currentState = useScratchpadStore.getState();
      const currentContent = currentState.tabs.find((t) => t.id === tabId)?.content || "";
      const newContent = currentContent + char;

      store.setContent(tabId, newContent);
      const updated = useScratchpadStore.getState();
      const updatedContent = updated.tabs.find((t) => t.id === tabId)?.content;

      results.push(updatedContent || "");
      console.log(`  [${results.length}] Input: "${char}", Content: "${updatedContent}"`);
    }

    expect(results[results.length - 1]).toBe("claude");
    expect(results[results.length - 1]?.length).toBe(6);
    console.log(
      `✓ Sequential input completed: "${results[results.length - 1]}"`,
    );
  });

  it("CRITICAL: Rapid successive updates should not lose characters", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();
    const tabId = store.tabs[0]?.id!;

    // Simulate rapid typing: "test"
    const inputs = ["t", "e", "s", "t"];
    let content = "";

    for (const char of inputs) {
      content += char;
      store.setContent(tabId, content);
      const updated = useScratchpadStore.getState();
      const storedContent = updated.tabs.find((t) => t.id === tabId)?.content;

      console.log(
        `  Input: "${char}", Accumulated: "${content}", Stored: "${storedContent}"`,
      );
      expect(storedContent).toBe(content);
    }

    const finalState = useScratchpadStore.getState();
    const finalContent = finalState.tabs.find((t) => t.id === tabId)?.content;
    expect(finalContent).toBe("test");
    expect(finalContent?.length).toBe(4);
    console.log(`✓ Final content: "${finalContent}"`);
  });

  it("CRITICAL: Content replacement should not duplicate", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();
    const tabId = store.tabs[0]?.id!;

    // Set initial content
    store.setContent(tabId, "hello");
    let state = useScratchpadStore.getState();
    expect(state.tabs.find((t) => t.id === tabId)?.content).toBe("hello");

    // Replace with new content
    store.setContent(tabId, "world");
    state = useScratchpadStore.getState();
    expect(state.tabs.find((t) => t.id === tabId)?.content).toBe("world");
    expect(state.tabs.find((t) => t.id === tabId)?.content).not.toBe(
      "helloworld",
    );

    console.log(`✓ Content replaced correctly: "world"`);
  });

  it("CRITICAL: Multiple tabs should maintain separate buffers", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();
    const tab1Id = store.tabs[0]?.id!;

    // Create second tab
    store.createTab();
    const tab2Id = store.tabs[1]?.id!;

    // Set different content in each
    store.setContent(tab1Id, "tab1content");
    store.setContent(tab2Id, "tab2content");

    const state = useScratchpadStore.getState();
    const tab1 = state.tabs.find((t) => t.id === tab1Id);
    const tab2 = state.tabs.find((t) => t.id === tab2Id);

    expect(tab1?.content).toBe("tab1content");
    expect(tab2?.content).toBe("tab2content");
    expect(tab1?.content).not.toBe(tab2?.content);

    console.log(
      `✓ Tab 1: "${tab1?.content}", Tab 2: "${tab2?.content}"`,
    );
  });

  it("CRITICAL: Empty string should clear content", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();
    const tabId = store.tabs[0]?.id!;

    store.setContent(tabId, "hasContent");
    let state = useScratchpadStore.getState();
    expect(state.tabs.find((t) => t.id === tabId)?.content).toBe("hasContent");

    store.setContent(tabId, "");
    state = useScratchpadStore.getState();
    expect(state.tabs.find((t) => t.id === tabId)?.content).toBe("");
    expect(state.tabs.find((t) => t.id === tabId)?.content.length).toBe(0);

    console.log(`✓ Content cleared successfully`);
  });

  it("CRITICAL: Large content should not be truncated or duplicated", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();
    const tabId = store.tabs[0]?.id!;

    const largeContent = "a".repeat(10000);
    store.setContent(tabId, largeContent);

    const state = useScratchpadStore.getState();
    const storedContent = state.tabs.find((t) => t.id === tabId)?.content;

    expect(storedContent?.length).toBe(10000);
    expect(storedContent).toBe(largeContent);

    console.log(
      `✓ Large content (${storedContent?.length} chars) stored correctly`,
    );
  });

  it("CRITICAL: Verify character-by-character accumulation doesn't duplicate", () => {
    console.log(`\n[TEST] Character-by-character accumulation test`);
    const store = useScratchpadStore.getState();
    store.toggleOpen();
    const tabId = store.tabs[0]?.id!;

    const testString = "test";
    const charLog: Array<{ char: string; stored: string; length: number }> = [];

    let accumulated = "";
    for (const char of testString) {
      accumulated += char;
      store.setContent(tabId, accumulated);

      const state = useScratchpadStore.getState();
      const stored = state.tabs.find((t) => t.id === tabId)?.content || "";

      charLog.push({
        char,
        stored,
        length: stored.length,
      });

      console.log(
        `  Char '${char}': accumulated="${accumulated}" stored="${stored}" length=${stored.length}`,
      );

      // Critical check: stored should match accumulated
      if (stored !== accumulated) {
        console.error(`  ❌ MISMATCH! Expected "${accumulated}" but got "${stored}"`);
      }
      expect(stored).toBe(accumulated);
    }

    // Verify final state
    const finalState = useScratchpadStore.getState();
    const finalContent = finalState.tabs.find((t) => t.id === tabId)?.content;
    expect(finalContent).toBe(testString);
    expect(finalContent?.length).toBe(4);

    console.log(`\n✓ All character accumulations correct`);
  });
});
