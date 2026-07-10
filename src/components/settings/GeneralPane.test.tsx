/**
 * Tests for Settings → General: the "Default mode for new workspaces" segmented
 * control reflects the persisted default and writes the user's choice back to
 * the workspacePrefs store (which App.tsx reads as the new-workspace fallback).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GeneralPane } from "./GeneralPane";
import { useWorkspacePrefs } from "../../stores/workspacePrefsStore";
import { useAttentionStore } from "../../stores/attentionStore";

beforeEach(() => {
  useWorkspacePrefs.setState({ defaultMode: "talk" });
  useAttentionStore.setState({ soundEnabled: true });
});

describe("GeneralPane — default workspace mode", () => {
  it("renders a segment per mode", () => {
    render(<GeneralPane />);
    const group = screen.getByRole("radiogroup", { name: /default workspace mode/i });
    const segments = group.querySelectorAll('[role="radio"]');
    expect(segments).toHaveLength(4);
    for (const label of ["Run", "Talk", "Review", "Direct"]) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the persisted default as checked", () => {
    useWorkspacePrefs.setState({ defaultMode: "direct" });
    render(<GeneralPane />);
    expect(screen.getByRole("radio", { name: "Direct" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Talk" })).toHaveAttribute("aria-checked", "false");
  });

  it("selecting a segment persists the new default", () => {
    render(<GeneralPane />);
    fireEvent.click(screen.getByRole("radio", { name: "Run" }));
    expect(useWorkspacePrefs.getState().defaultMode).toBe("run");
    expect(screen.getByRole("radio", { name: "Run" })).toHaveAttribute("aria-checked", "true");
  });
});
