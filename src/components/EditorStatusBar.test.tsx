import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const toggleWrap = vi.fn();
const toggleLineNumbers = vi.fn();
const cycleTabWidth = vi.fn();
const bumpFontSize = vi.fn();

vi.mock("../stores/editorPrefsStore", () => ({
  useEditorPrefs: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      wrap: false,
      lineNumbers: true,
      tabWidth: 2,
      fontSize: 13,
      toggleWrap,
      toggleLineNumbers,
      cycleTabWidth,
      bumpFontSize,
    }),
  ),
}));

import { EditorStatusBar } from "./EditorStatusBar";

beforeEach(() => vi.clearAllMocks());

describe("EditorStatusBar", () => {
  it("shows the caret position", () => {
    render(<EditorStatusBar line={41} col={18} selectionCount={1} lang="rust" />);
    expect(screen.getByText((_, el) => el?.textContent === "Ln 41, Col 18")).toBeInTheDocument();
    expect(screen.getByText("rust")).toBeInTheDocument();
  });

  it("offers Ask Talk about this only while text is selected", async () => {
    const onAskTalk = vi.fn();
    const { rerender } = render(
      <EditorStatusBar line={1} col={1} selectionCount={1} selectionLines={null} onAskTalk={onAskTalk} lang="ts" />,
    );
    expect(screen.queryByText("Ask Talk about this")).not.toBeInTheDocument();
    rerender(
      <EditorStatusBar line={1} col={1} selectionCount={1} selectionLines={{ from: 5, to: 10 }} onAskTalk={onAskTalk} lang="ts" />,
    );
    const btn = screen.getByRole("button", { name: /Ask Talk about this/ });
    expect(btn).toHaveAttribute("title", "Ask Talk about lines 5–10");
    await userEvent.click(btn);
    expect(onAskTalk).toHaveBeenCalledTimes(1);
  });

  it("disables Ask Talk about this while the file has unsaved edits", async () => {
    const onAskTalk = vi.fn();
    render(
      <EditorStatusBar
        line={1} col={1} selectionCount={1} selectionLines={{ from: 5, to: 10 }}
        onAskTalk={onAskTalk} askTalkUnsaved lang="ts"
      />,
    );
    const btn = screen.getByRole("button", { name: /Ask Talk about this/ });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/^Save the file first/);
    await userEvent.click(btn);
    expect(onAskTalk).not.toHaveBeenCalled();
  });

  it("shows selection count only when more than one selection", () => {
    const { rerender } = render(
      <EditorStatusBar line={1} col={1} selectionCount={1} lang="rust" />,
    );
    expect(screen.queryByText(/selections/)).not.toBeInTheDocument();
    rerender(<EditorStatusBar line={1} col={1} selectionCount={3} lang="rust" />);
    expect(screen.getByText("3 selections")).toBeInTheDocument();
  });

  it("shows the blame saved-version note only when asked", () => {
    const { rerender } = render(
      <EditorStatusBar line={1} col={1} selectionCount={1} lang="rust" />,
    );
    expect(screen.queryByTestId("statusbar-blame-saved")).not.toBeInTheDocument();
    rerender(
      <EditorStatusBar line={1} col={1} selectionCount={1} lang="rust" blameSavedNote />,
    );
    expect(screen.getByTestId("statusbar-blame-saved")).toHaveTextContent(
      "blame: saved version",
    );
  });

  it("clicking the wrap segment toggles wrap", async () => {
    render(<EditorStatusBar line={1} col={1} selectionCount={1} lang="rust" />);
    await userEvent.click(screen.getByTestId("statusbar-wrap"));
    expect(toggleWrap).toHaveBeenCalledOnce();
  });

  it("clicking the line-numbers segment toggles line numbers", async () => {
    render(<EditorStatusBar line={1} col={1} selectionCount={1} lang="rust" />);
    await userEvent.click(screen.getByTestId("statusbar-linenumbers"));
    expect(toggleLineNumbers).toHaveBeenCalledOnce();
  });

  it("clicking the indent segment cycles tab width", async () => {
    render(<EditorStatusBar line={1} col={1} selectionCount={1} lang="rust" />);
    await userEvent.click(screen.getByTestId("statusbar-indent"));
    expect(cycleTabWidth).toHaveBeenCalledOnce();
  });

  it("font steppers bump the size up and down", async () => {
    render(<EditorStatusBar line={1} col={1} selectionCount={1} lang="rust" />);
    await userEvent.click(screen.getByTestId("statusbar-font-inc"));
    await userEvent.click(screen.getByTestId("statusbar-font-dec"));
    expect(bumpFontSize).toHaveBeenNthCalledWith(1, 1);
    expect(bumpFontSize).toHaveBeenNthCalledWith(2, -1);
  });
});
