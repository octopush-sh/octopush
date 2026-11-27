import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConversationSwitcher, filterChats } from "./ConversationSwitcher";

const chats = [
  { id: "a", title: "Fix the login race", meta: "14:32", pinned: true },
  { id: "b", title: "Draft the changelog", meta: "YESTERDAY" },
  { id: "c", title: "Login copy review", meta: "MON" },
];

function open(over: Partial<React.ComponentProps<typeof ConversationSwitcher>> = {}) {
  const props = { chats, activeChatId: "a", onSelect: vi.fn(), onNew: vi.fn(), onClose: vi.fn(), ...over };
  render(<ConversationSwitcher {...props} />);
  return { ...props, input: screen.getByTestId("conversation-switcher-input") };
}

describe("filterChats", () => {
  it("matches the title, case-insensitively, and keeps the order", () => {
    expect(filterChats(chats, "LOGIN").map((c) => c.id)).toEqual(["a", "c"]);
    expect(filterChats(chats, "  ").map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(filterChats(chats, "nothing")).toEqual([]);
  });
});

describe("ConversationSwitcher", () => {
  it("lists every conversation, marks the open one, and takes the focus", () => {
    const { input } = open({ streamingChatIds: ["b"] });
    expect(input).toHaveFocus();
    expect(screen.getByTestId("conversation-switcher-row-a")).toHaveTextContent("here");
    expect(screen.getByTestId("conversation-switcher-row-b")).toHaveTextContent("running ·");
    expect(screen.getByTestId("conversation-switcher-row-c")).not.toHaveTextContent("here");
    expect(screen.getByTestId("conversation-switcher-new")).toHaveTextContent("Begin a new conversation");
  });

  it("filters by title, and ⏎ switches to the first match", () => {
    const { input, onSelect, onClose } = open();
    fireEvent.change(input, { target: { value: "changelog" } });
    expect(screen.queryByTestId("conversation-switcher-row-a")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(onClose).toHaveBeenCalled();
  });

  it("↓ moves, and ⏎ on the open conversation only closes", () => {
    const { input, onSelect, onClose } = open();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("c");
  });

  it("⌘⏎ starts a new conversation from any row, and so does the last row", () => {
    const { input, onNew, onSelect } = open();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNew).toHaveBeenCalledTimes(2);
  });

  it("acts once on a held ⏎", () => {
    const { input, onNew } = open();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, repeat: true });
    expect(onNew).not.toHaveBeenCalled();
  });

  it("says when nothing matches, and Esc closes it", () => {
    const { input, onClose } = open();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("No conversation matches that.")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
