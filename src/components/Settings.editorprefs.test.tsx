/**
 * Behavioral tests for the Settings → Editor pane: word wrap toggle, font size
 * stepper (Atelier Stepper), tab width (Atelier SegmentedControl), and line
 * numbers toggle — each reads from / writes to editorPrefsStore.
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

async function renderEditorPane() {
  await act(async () => {
    render(<Settings open initialTab="editor" onClose={vi.fn()} />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPrefs();
});

describe("Settings · Editor pane — word wrap", () => {
  it("renders the toggle reflecting the store", async () => {
    await renderEditorPane();
    expect(screen.getByTestId("editor-wrap")).toHaveAttribute("aria-checked", "false");
  });

  it("clicking the toggle writes the store and flips the switch", async () => {
    await renderEditorPane();
    fireEvent.click(screen.getByTestId("editor-wrap"));
    expect(useEditorPrefs.getState().wrap).toBe(true);
    expect(screen.getByTestId("editor-wrap")).toHaveAttribute("aria-checked", "true");
  });
});

describe("Settings · Editor pane — font size stepper", () => {
  it("shows the current size", async () => {
    await renderEditorPane();
    expect(screen.getByLabelText("Editor font size")).toHaveTextContent("13");
  });

  it("increase and decrease bump the store by one", async () => {
    await renderEditorPane();
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(useEditorPrefs.getState().fontSize).toBe(14);
    fireEvent.click(screen.getByRole("button", { name: "Decrease" }));
    fireEvent.click(screen.getByRole("button", { name: "Decrease" }));
    expect(useEditorPrefs.getState().fontSize).toBe(12);
    expect(screen.getByLabelText("Editor font size")).toHaveTextContent("12");
  });

  it("clamps at both bounds and disables the buttons there", async () => {
    await renderEditorPane();
    act(() => useEditorPrefs.setState({ fontSize: FONT_MAX }));
    expect(screen.getByRole("button", { name: "Increase" })).toBeDisabled();

    act(() => useEditorPrefs.setState({ fontSize: FONT_MIN }));
    expect(screen.getByRole("button", { name: "Decrease" })).toBeDisabled();
  });
});

describe("Settings · Editor pane — tab width", () => {
  it("renders the 2/4/8 segments with the active one marked", async () => {
    await renderEditorPane();
    expect(screen.getByRole("radio", { name: "2" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "4" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "8" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a segment writes the store and moves the active mark", async () => {
    await renderEditorPane();
    fireEvent.click(screen.getByRole("radio", { name: "8" }));
    expect(useEditorPrefs.getState().tabWidth).toBe(8);
    expect(screen.getByRole("radio", { name: "8" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "2" })).toHaveAttribute("aria-checked", "false");
  });
});

describe("Settings · Editor pane — line numbers", () => {
  it("clicking the toggle writes the store", async () => {
    await renderEditorPane();
    expect(screen.getByTestId("editor-linenumbers")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("editor-linenumbers"));
    expect(useEditorPrefs.getState().lineNumbers).toBe(false);
    expect(screen.getByTestId("editor-linenumbers")).toHaveAttribute("aria-checked", "false");
  });
});
