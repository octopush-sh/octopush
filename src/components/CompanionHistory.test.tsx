/**
 * Tests for CompanionHistory.
 *
 * Focus: row semantics after the audit restructure — the select and delete
 * controls are sibling buttons (no invalid button-in-button nesting) and the
 * delete button is keyboard-reachable.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompanionHistory, type CompanionHistoryChat } from "./CompanionHistory";

const chats: CompanionHistoryChat[] = [
  { id: "c1", title: "First conversation", meta: "2h ago" },
  { id: "c2", title: "Second conversation", meta: "1d ago" },
];

function renderHistory(overrides: Partial<React.ComponentProps<typeof CompanionHistory>> = {}) {
  const props = {
    chats,
    activeChatId: "c1",
    onSelectChat: vi.fn(),
    onNewChat: vi.fn(),
    onDeleteChat: vi.fn(),
    ...overrides,
  };
  render(<CompanionHistory {...props} />);
  return props;
}

describe("CompanionHistory — rendering & actions", () => {
  it("renders one row per chat and an empty message when there are none", () => {
    renderHistory();
    expect(screen.getByText("First conversation")).toBeInTheDocument();
    expect(screen.getByText("Second conversation")).toBeInTheDocument();
  });

  it("shows an empty-state CTA when no chats exist", () => {
    renderHistory({ chats: [] });
    expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument();
    expect(screen.getByText(/begin a new conversation/i)).toBeInTheDocument();
  });

  it("clicking a row calls onSelectChat", async () => {
    const user = userEvent.setup();
    const props = renderHistory();
    await user.click(screen.getByText("Second conversation"));
    expect(props.onSelectChat).toHaveBeenCalledWith("c2");
  });

  it("clicking the New conversation button calls onNewChat", async () => {
    const user = userEvent.setup();
    const props = renderHistory();
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    expect(props.onNewChat).toHaveBeenCalled();
  });

  it("delete requires a confirm step before calling onDeleteChat", async () => {
    const user = userEvent.setup();
    const props = renderHistory();
    const deleteButtons = screen.getAllByRole("button", { name: "Delete conversation" });
    await user.click(deleteButtons[1]);
    // First click only arms the confirm — nothing deleted yet.
    expect(props.onDeleteChat).not.toHaveBeenCalled();
    expect(screen.getByText("Delete?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(props.onDeleteChat).toHaveBeenCalledWith("c2");
    expect(props.onSelectChat).not.toHaveBeenCalled();
  });

  it("exports a conversation via the export action", async () => {
    const user = userEvent.setup();
    const props = renderHistory({ onExportChat: vi.fn() });
    await user.click(screen.getAllByRole("button", { name: "Export conversation" })[0]);
    expect(props.onExportChat).toHaveBeenCalledWith("c1");
  });

  it("renames a conversation via the rename action", async () => {
    const user = userEvent.setup();
    const props = renderHistory({ onRenameChat: vi.fn() });
    await user.click(screen.getAllByRole("button", { name: "Rename conversation" })[0]);
    const input = screen.getByRole("textbox", { name: "Conversation title" });
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");
    expect(props.onRenameChat).toHaveBeenCalledWith("c1", "Renamed");
  });

  it("hides delete buttons when onDeleteChat is not provided", () => {
    renderHistory({ onDeleteChat: undefined });
    expect(screen.queryByRole("button", { name: "Delete conversation" })).toBeNull();
  });

  it("delete button is a sibling of the select button, not nested inside it", () => {
    renderHistory();
    const deleteBtn = screen.getAllByRole("button", { name: "Delete conversation" })[0];
    expect(deleteBtn.parentElement?.closest("button")).toBeNull();
    const selectBtn = screen.getByText("First conversation").closest("button")!;
    expect(selectBtn.contains(deleteBtn)).toBe(false);
  });
});

describe("CompanionHistory — keyboard reachability", () => {
  it("the delete button is reachable via Tab", async () => {
    const user = userEvent.setup();
    renderHistory({ chats: [chats[0]] });

    // Tab order: header "+" → row select button → row delete button.
    await user.tab();
    expect(screen.getByRole("button", { name: "New conversation" })).toHaveFocus();

    await user.tab();
    expect(screen.getByText("First conversation").closest("button")).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Delete conversation" })).toHaveFocus();
  });
});
