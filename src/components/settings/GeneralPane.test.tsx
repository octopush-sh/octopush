/**
 * Tests for Settings → General: the "Default mode for new workspaces" segmented
 * control reflects the persisted default and writes the user's choice back to
 * the workspacePrefs store (which App.tsx reads as the new-workspace fallback).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

const getSettings = vi.fn();
const saveSettings = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getSettings: (...args: unknown[]) => getSettings(...args),
    saveSettings: (...args: unknown[]) => saveSettings(...args),
  },
}));

import { GeneralPane, TALK_TURNS_DEFAULT, TALK_TURNS_STEP, TALK_TURNS_MAX } from "./GeneralPane";
import { useWorkspacePrefs } from "../../stores/workspacePrefsStore";
import { useAttentionStore } from "../../stores/attentionStore";

const BASE_SETTINGS = { providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} };

beforeEach(() => {
  useWorkspacePrefs.setState({ defaultMode: "talk" });
  useAttentionStore.setState({ soundEnabled: true });
  getSettings.mockReset().mockResolvedValue({ ...BASE_SETTINGS });
  saveSettings.mockReset().mockResolvedValue(undefined);
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

describe.each([
  {
    name: "tool turns per message",
    field: "talkMaxIterations" as const,
    other: "subagentMaxTurns" as const,
    switchName: "Limit tool turns per message",
    stepperName: "Tool turns per message",
  },
  {
    name: "sub-agent tool turns",
    field: "subagentMaxTurns" as const,
    other: "talkMaxIterations" as const,
    switchName: "Limit sub-agent tool turns",
    stepperName: "Sub-agent tool turns",
  },
])("GeneralPane — Talk · $name (off by default = no limit)", ({ field, other, switchName, stepperName }) => {
  function toggle() {
    return screen.getByRole("switch", { name: switchName });
  }
  function stepper() {
    return screen.getByLabelText(stepperName);
  }

  it("is off — no limit — when nothing is saved, with the stepper put away", async () => {
    await act(async () => {
      render(<GeneralPane />);
    });
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(stepper().closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
  });

  it("loads a persisted limit as on, with its value", async () => {
    getSettings.mockResolvedValue({ ...BASE_SETTINGS, [field]: 60 });
    await act(async () => {
      render(<GeneralPane />);
    });
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    expect(stepper()).toHaveTextContent("60");
    expect(stepper().closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");
  });

  it("clamps an out-of-range saved value into the supported range", async () => {
    getSettings.mockResolvedValue({ ...BASE_SETTINGS, [field]: 9_999 });
    await act(async () => {
      render(<GeneralPane />);
    });
    await waitFor(() => expect(stepper()).toHaveTextContent(String(TALK_TURNS_MAX)));
  });

  it("switching on persists a starting limit; switching off persists no limit — the other limit untouched", async () => {
    getSettings.mockResolvedValue({ ...BASE_SETTINGS, editorCommand: "cursor", [other]: 40 });
    await act(async () => {
      render(<GeneralPane />);
    });
    await act(async () => {
      fireEvent.click(toggle());
    });
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ editorCommand: "cursor", [other]: 40, [field]: TALK_TURNS_DEFAULT }),
    );
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    await act(async () => {
      fireEvent.click(toggle());
    });
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ [other]: 40, [field]: null }));
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("stepping a limit persists the new value without clobbering other settings", async () => {
    getSettings.mockResolvedValue({ ...BASE_SETTINGS, editorCommand: "cursor", [field]: 25, [other]: 25 });
    await act(async () => {
      render(<GeneralPane />);
    });
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    const increase = stepper().querySelector('button[aria-label="Increase"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(increase);
    });
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ editorCommand: "cursor", [other]: 25, [field]: 25 + TALK_TURNS_STEP }),
    );
    expect(stepper()).toHaveTextContent(String(25 + TALK_TURNS_STEP));
  });
});
