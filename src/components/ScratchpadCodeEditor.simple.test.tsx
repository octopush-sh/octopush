import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ScratchpadCodeEditor } from "./ScratchpadCodeEditor";
import { useScratchpadStore } from "../stores/scratchpadStore";

/**
 * SIMPLE FOCUSED TESTS FOR SCRATCHPAD RENDERING FIX
 *
 * These tests verify that the critical fix for double-text rendering is in place:
 * The textarea must have opacity: 0 to be completely invisible while still
 * capturing input, allowing only the pre element to render visibly.
 */

describe("ScratchpadCodeEditor - Fix Verification", () => {
  it("CRITICAL FIX: Textarea has opacity 0 to be completely invisible", () => {
    const store = useScratchpadStore.getState();
    store.reset?.();

    // Create a tab so ScratchpadCodeEditor renders content
    store.createTab();

    const { container } = render(<ScratchpadCodeEditor />);
    const textarea = container.querySelector("textarea");

    expect(textarea).toBeInTheDocument();

    // CRITICAL: The textarea MUST have opacity: 0 to prevent double-text rendering
    // This is the fix for the bug where textarea text was visible as a shadow
    const computed = window.getComputedStyle(textarea!);
    expect(computed.opacity).toBe("0");
  });

  it("Pre element is the only visible rendering layer", () => {
    const store = useScratchpadStore.getState();
    store.reset?.();
    store.createTab();

    const { container } = render(<ScratchpadCodeEditor />);
    const pre = container.querySelector("pre");
    const textarea = container.querySelector("textarea");

    // Pre should be in document for rendering
    expect(pre).toBeInTheDocument();

    // Pre should not block events (so textarea can receive them)
    expect(pre).toHaveClass("pointer-events-none");

    // Textarea should be in document for input capture
    expect(textarea).toBeInTheDocument();

    // Textarea should be invisible (opacity 0)
    const taStyle = window.getComputedStyle(textarea!);
    expect(taStyle.opacity).toBe("0");

    // Both should be positioned absolutely for perfect overlay
    expect(textarea).toHaveClass("absolute");
    expect(pre).toHaveClass("absolute");
  });
});
