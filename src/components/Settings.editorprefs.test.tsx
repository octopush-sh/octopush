/**
 * Behavioral tests for the Settings → General → Editor section:
 * word wrap toggle, font size stepper, tab width segmented choice,
 * and line numbers toggle — each reads from / writes to editorPrefsStore.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useEditorPrefs, FONT_MIN, FONT_MAX } from "../stores/editorPrefsStore";

vi.mock("../lib/ipc", () => ({
  ipc: {
    getSettings: vi.fn().mockResolvedValue({
      providerKeys: {},
      providerBaseUrls: {},
      gitCredentials: {},
    }),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    detectEditors: vi.fn().mockResolvedValue([]),
  },
}));

import { Settings } from "./Settings";

function resetPrefs() {
  useEditorPrefs.setState({ wrap: false, fontSize: 13, tabWidth: 2, lineNumbers: true });
}

async function renderGeneralPane() {
  await act(async () => {
    render(<Settings open initialTab="general" onClose={vi.fn()} />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPrefs();
});

describe("Settings · Editor section — word wrap", () => {
  it("renders the toggle reflecting the store", async () => {
    await renderGeneralPane();
    expect(screen.getByTestId("editor-wrap")).toHaveAttribute("aria-checked", "false");
  });

  it("clicking the toggle writes the store and flips the switch", async () => {
    await renderGeneralPane();
    fireEvent.click(screen.getByTestId("editor-wrap"));
    expect(useEditorPrefs.getState().wrap).toBe(true);
    expect(screen.getByTestId("editor-wrap")).toHaveAttribute("aria-checked", "true");
  });
});

describe("Settings · Editor section — font size stepper", () => {
  it("shows the current size in mono", async () => {
    await renderGeneralPane();
    expect(screen.getByTestId("editor-font-value")).toHaveTextContent("13px");
  });

  it("plus and minus bump the store by one", async () => {
    await renderGeneralPane();
    fireEvent.click(screen.getByTestId("editor-font-inc"));
    expect(useEditorPrefs.getState().fontSize).toBe(14);
    fireEvent.click(screen.getByTestId("editor-font-dec"));
    fireEvent.click(screen.getByTestId("editor-font-dec"));
    expect(useEditorPrefs.getState().fontSize).toBe(12);
    expect(screen.getByTestId("editor-font-value")).toHaveTextContent("12px");
  });

  it("clamps at both bounds and disables the buttons there", async () => {
    await renderGeneralPane();
    act(() => useEditorPrefs.setState({ fontSize: FONT_MAX }));
    expect(screen.getByTestId("editor-font-inc")).toBeDisabled();
    fireEvent.click(screen.getByTestId("editor-font-inc"));
    expect(useEditorPrefs.getState().fontSize).toBe(FONT_MAX);

    act(() => useEditorPrefs.setState({ fontSize: FONT_MIN }));
    expect(screen.getByTestId("editor-font-dec")).toBeDisabled();
    fireEvent.click(screen.getByTestId("editor-font-dec"));
    expect(useEditorPrefs.getState().fontSize).toBe(FONT_MIN);
  });
});

describe("Settings · Editor section — tab width", () => {
  it("renders the 2/4/8 chips with the active one marked", async () => {
    await renderGeneralPane();
    expect(screen.getByTestId("editor-tab-2")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("editor-tab-4")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("editor-tab-8")).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking a chip writes the store and moves the active mark", async () => {
    await renderGeneralPane();
    fireEvent.click(screen.getByTestId("editor-tab-8"));
    expect(useEditorPrefs.getState().tabWidth).toBe(8);
    expect(screen.getByTestId("editor-tab-8")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("editor-tab-2")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Settings · Editor section — line numbers", () => {
  it("clicking the toggle writes the store", async () => {
    await renderGeneralPane();
    expect(screen.getByTestId("editor-linenumbers")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("editor-linenumbers"));
    expect(useEditorPrefs.getState().lineNumbers).toBe(false);
    expect(screen.getByTestId("editor-linenumbers")).toHaveAttribute("aria-checked", "false");
  });
});
