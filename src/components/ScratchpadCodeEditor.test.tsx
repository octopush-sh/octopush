import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScratchpadCodeEditor } from "./ScratchpadCodeEditor";
import { useScratchpadStore } from "../stores/scratchpadStore";

describe("ScratchpadCodeEditor", () => {
  beforeEach(() => {
    useScratchpadStore.getState().reset();
  });

  it("renders empty state when no active tab", () => {
    render(<ScratchpadCodeEditor />);
    expect(screen.getByText("No tab selected")).toBeInTheDocument();
  });

  it("renders empty placeholder text when tab is empty", () => {
    const store = useScratchpadStore.getState();
    store.createTab();

    render(<ScratchpadCodeEditor />);
    expect(screen.getByText("Paste code here, or start typing…")).toBeInTheDocument();
  });

  it("renders textarea with content", () => {
    const store = useScratchpadStore.getState();
    store.createTab();
    const tabId = store.tabs[0].id;
    store.setContent(tabId, "hello world");

    const { container } = render(<ScratchpadCodeEditor />);
    const textarea = container.querySelector("textarea");
    expect(textarea).toHaveValue("hello world");
  });

  it("renders syntax-highlighted code display layer", () => {
    const store = useScratchpadStore.getState();
    store.createTab();
    store.renameTab(store.tabs[0].id, "test.js");
    store.setContent(store.tabs[0].id, "const x = 1;");

    const { container } = render(<ScratchpadCodeEditor />);
    const codeElement = container.querySelector("code");
    expect(codeElement).toBeInTheDocument();
  });

  it("updates content on textarea change", async () => {
    const store = useScratchpadStore.getState();
    store.createTab();

    const { container } = render(<ScratchpadCodeEditor />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "test input" } });

    await waitFor(() => {
      const updated = useScratchpadStore.getState();
      expect(updated.tabs[0].content).toBe("test input");
    });
  });

  it("handles large content without duplication", async () => {
    const store = useScratchpadStore.getState();
    store.createTab();
    const tabId = store.tabs[0].id;

    // Generate large content (10KB)
    const largeContent = "a".repeat(10000);
    store.setContent(tabId, largeContent);

    const { container } = render(<ScratchpadCodeEditor />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // Verify textarea has correct content (not duplicated)
    expect(textarea.value.length).toBe(10000);
    expect(textarea.value).toBe(largeContent);
  });

  it("handles rapid input changes", async () => {
    const store = useScratchpadStore.getState();
    store.createTab();

    const { container } = render(<ScratchpadCodeEditor />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // Simulate rapid typing
    const inputs = ["h", "e", "l", "l", "o"];
    let fullContent = "";

    for (const input of inputs) {
      fullContent += input;
      fireEvent.change(textarea, { target: { value: fullContent } });
    }

    await waitFor(() => {
      const updated = useScratchpadStore.getState();
      // Verify no duplication - should be exactly "hello", not "hheelllloo"
      expect(updated.tabs[0].content).toBe("hello");
    });
  });

  it("maintains textarea and display layer alignment", () => {
    const store = useScratchpadStore.getState();
    store.createTab();
    store.renameTab(store.tabs[0].id, "test.ts");
    store.setContent(store.tabs[0].id, "const x: number = 42;");

    const { container } = render(<ScratchpadCodeEditor />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const displayDiv = container.querySelector("[style*='whitespace: pre']");

    // Both should have same font metrics
    const textareaStyle = window.getComputedStyle(textarea);
    const displayStyle = window.getComputedStyle(displayDiv!);

    // Verify critical styling is identical
    expect(textareaStyle.fontFamily).toContain("JetBrains");
    expect(displayStyle.fontFamily).toContain("JetBrains");
    expect(textareaStyle.fontSize).toBe(displayStyle.fontSize);
    expect(textareaStyle.lineHeight).toBe(displayStyle.lineHeight);
  });

  it("handles special characters correctly", async () => {
    const store = useScratchpadStore.getState();
    store.createTab();
    const tabId = store.tabs[0].id;

    const specialContent = 'const str = "hello\\nworld\\t\\r";';
    store.setContent(tabId, specialContent);

    const { container } = render(<ScratchpadCodeEditor />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // Verify special characters are not duplicated
    expect(textarea.value).toBe(specialContent);
    expect(textarea.value.length).toBe(specialContent.length);
  });

  it("caret color is visible and correct", () => {
    const store = useScratchpadStore.getState();
    store.createTab();

    const { container } = render(<ScratchpadCodeEditor />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    const style = window.getComputedStyle(textarea);
    // Caret should be brass colored
    expect(style.caretColor).toBeTruthy();
  });

  it("handles empty string input", async () => {
    const store = useScratchpadStore.getState();
    store.createTab();
    const tabId = store.tabs[0].id;
    store.setContent(tabId, "hello");

    const { container } = render(<ScratchpadCodeEditor />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "" } });

    await waitFor(() => {
      const updated = useScratchpadStore.getState();
      expect(updated.tabs[0].content).toBe("");
    });
  });
});
