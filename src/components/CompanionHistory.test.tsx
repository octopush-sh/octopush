/**
 * Tests for CompanionHistory.
 *
 * Focus: row semantics after the audit restructure — the select and delete
 * controls are sibling buttons (no invalid button-in-button nesting) and the
 * delete button is keyboard-reachable.
 */
import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompanionHistory, type CompanionHistoryChat } from "./CompanionHistory";
import { useTourStore } from "../stores/tourStore";

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

describe("CompanionHistory — Regenerate title (#1137)", () => {
  it("sits beside rename, asks for that row's title and waits disabled until it settles", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    const onRegenerateTitle = vi.fn(() => new Promise<void>((r) => (settle = r)));
    renderHistory({ onRenameChat: vi.fn(), onRegenerateTitle });
    const buttons = screen.getAllByRole("button", { name: "Regenerate title" });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute("data-tour", "companion-chat-regenerate-title");
    expect(buttons[0].previousElementSibling).toHaveAccessibleName("Rename conversation");
    await user.click(buttons[1]);
    expect(onRegenerateTitle).toHaveBeenCalledWith("c2");
    expect(buttons[1]).toBeDisabled();
    await act(async () => settle());
    expect(buttons[1]).not.toBeDisabled();
  });

  it("crossfades a new title in", () => {
    const { rerender } = render(
      <CompanionHistory chats={chats} activeChatId="c1" onSelectChat={vi.fn()} onNewChat={vi.fn()} />,
    );
    const before = screen.getAllByTestId("chat-row-title")[0];
    rerender(
      <CompanionHistory
        chats={[{ ...chats[0], title: "GUIDE-123 · Waive virtualenv findings" }, chats[1]]}
        activeChatId="c1"
        onSelectChat={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    const after = screen.getAllByTestId("chat-row-title")[0];
    expect(after).not.toBe(before);
    expect(after).toHaveTextContent("GUIDE-123 · Waive virtualenv findings");
    expect(after.className).toMatch(/octo-fade-in/);
  });

  it("shows a row's actions while a tour points at its Regenerate title", () => {
    renderHistory({ onRegenerateTitle: vi.fn() });
    const target = screen.getAllByRole("button", { name: "Regenerate title" })[0];
    const bar = target.closest('[data-testid="chat-row-actions"]') as HTMLElement;
    expect(bar.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    act(() => useTourStore.setState({ active: true, target }));
    expect(bar.className).toMatch(/(^|\s)opacity-100(\s|$)/);
    act(() => useTourStore.setState({ active: false, target: null }));
  });
});

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

  it("pins a conversation via the pin action", async () => {
    const user = userEvent.setup();
    const props = renderHistory({ onPinChat: vi.fn() });
    await user.click(screen.getAllByRole("button", { name: "Pin conversation" })[0]);
    expect(props.onPinChat).toHaveBeenCalledWith("c1", true);
  });

  it("copies a conversation as Markdown, and its label says so", async () => {
    const user = userEvent.setup();
    const props = renderHistory({ onExportChat: vi.fn() });
    const copy = screen.getAllByRole("button", { name: "Copy conversation as Markdown" })[0];
    // The label matches the tooltip: the action copies, it downloads nothing.
    expect(copy).toHaveAttribute("title", "Copy conversation as Markdown");
    expect(screen.queryByRole("button", { name: "Export conversation" })).toBeNull();
    await user.click(copy);
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

  it("marks only the active chat as current and gives every row its full title as a tooltip", () => {
    const long = "Small Change Ship — why does the build break on CI but not locally why does";
    renderHistory({
      chats: [
        { id: "a", title: `${long} the build break`, meta: "14:32" },
        { id: "b", title: `${long} the deploy stall`, meta: "14:41" },
      ],
      activeChatId: "b",
    });
    const rows = Array.from(document.querySelectorAll("[data-row-select]"));
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual([null, "true"]);
    expect(rows.map((r) => r.getAttribute("title"))).toEqual([
      `${long} the build break`,
      `${long} the deploy stall`,
    ]);
  });

  it("boxes only the open chat; other rows get a hover-only wash", () => {
    renderHistory({
      chats: [
        { id: "a", title: "Same title", meta: "14:32" },
        { id: "b", title: "Same title", meta: "14:32" },
        { id: "c", title: "Same title", meta: "14:32" },
      ],
      activeChatId: "b",
    });
    const rows = Array.from(document.querySelectorAll("[data-row-select]")).map(
      (b) => b.parentElement!,
    );
    const selected = rows.filter(
      (r) => r.className.includes("bg-octo-panel-2") || r.className.includes("var(--brass-dim)"),
    );
    expect(selected).toEqual([rows[1]]);
    expect(rows[1].dataset.active).toBe("true");
    expect(rows[1].className).not.toContain("hover:bg-");
    for (const r of [rows[0], rows[2]]) {
      expect(r.className).toContain("hover:bg-[var(--brass-ghost)]");
      expect(r.className).not.toMatch(/(^|\s)bg-\[var\(--brass-ghost\)\]/);
      expect(r.dataset.active).toBeUndefined();
    }
  });

  it("lets a long title wrap to two lines instead of cutting it to one", () => {
    renderHistory();
    const title = screen.getAllByTestId("chat-row-title")[0];
    expect(title.className).toContain("line-clamp-2");
    expect(title.className).not.toMatch(/\btruncate\b/);
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

    // Tab order: section fold → header "+" → row select button → row delete button.
    await user.tab();
    expect(screen.getByRole("button", { name: /chats/i })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "New conversation" })).toHaveFocus();

    await user.tab();
    expect(screen.getByText("First conversation").closest("button")).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Delete conversation" })).toHaveFocus();
  });
});

describe("CompanionHistory — the title owns the row (#756)", () => {
  const withActions = { onRenameChat: vi.fn(), onExportChat: vi.fn(), onPinChat: vi.fn() };
  const titleBox = () => screen.getByText("First conversation").closest("button")!;
  const widthClasses = () => {
    const btn = titleBox();
    const title = screen.getByText("First conversation");
    return [btn.className, title.className, btn.parentElement!.className];
  };

  it("overlays the row actions instead of giving them width", () => {
    renderHistory(withActions);
    const actions = screen.getAllByTestId("chat-row-actions")[0];
    // Out of flow, at the right end, over the panel fade: revealing them can't
    // narrow the title, so the title never rewraps on hover.
    expect(actions).toHaveClass("absolute", "inset-y-0", "right-0", "octo-row-actions-fade");
    expect(actions).not.toHaveClass("max-w-0");
    expect(actions.className).not.toMatch(/max-w-\[/);
    // Hidden by opacity only, revealed on hover AND on keyboard focus.
    expect(actions).toHaveClass("opacity-0", "group-hover:opacity-100", "focus-within:opacity-100");
    // The shared motion token, never a hand-copied curve.
    expect(actions).toHaveClass("ease-[var(--ease-octo)]");
    expect(actions.className).not.toMatch(/cubic-bezier/);
    // The title button is the only in-flow child: it takes the whole row.
    expect(titleBox()).toHaveClass("min-w-0", "flex-1");
    expect(titleBox().parentElement).not.toHaveClass("pr-1");
  });

  it("the overlay lets clicks through to the title; only its buttons catch them (#818)", () => {
    renderHistory(withActions);
    const actions = screen.getAllByTestId("chat-row-actions")[0];
    expect(actions).toHaveClass("pointer-events-none");
    const buttons = actions.querySelectorAll("button");
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b).toHaveClass("pointer-events-auto");
  });

  it("the overlay fades on the row's own timing, so unhover drops no patch (#818)", () => {
    renderHistory(withActions);
    const actions = screen.getAllByTestId("chat-row-actions")[0];
    const row = actions.parentElement!;
    // `.octo-row-actions-fade` transitions opacity AND the registered
    // `--row-wash`; the utilities give both the row's duration and curve.
    for (const el of [row, actions]) expect(el).toHaveClass("duration-[220ms]", "ease-[var(--ease-octo)]");
    // The property list lives in the CSS class alone; a `transition-*`
    // utility here would hide that `--row-wash` fades too.
    expect(actions.className).not.toMatch(/(^|\s)transition(-|\s|$)/);
  });

  it("toggling hover or focus doesn't change the title's width classes", async () => {
    const user = userEvent.setup();
    renderHistory({ ...withActions, chats: [chats[0]] });
    const before = widthClasses();
    // No hover- or focus-dependent width utility anywhere on the title's chain.
    for (const cls of before) expect(cls).not.toMatch(/(group-hover|focus-within|hover):(max-)?w-/);
    await user.hover(titleBox());
    expect(widthClasses()).toEqual(before);
    await user.unhover(titleBox());
    const pin = screen.getByRole("button", { name: "Pin conversation" });
    pin.focus();
    expect(pin).toHaveFocus();
    expect(widthClasses()).toEqual(before);
  });

  it("keeps every action focusable with an inset ring", () => {
    renderHistory(withActions);
    for (const name of ["Pin conversation", "Rename conversation", "Copy conversation as Markdown", "Delete conversation"]) {
      const btn = screen.getAllByRole("button", { name })[0];
      expect(btn).not.toHaveAttribute("tabindex", "-1");
      expect(btn).toHaveClass("focus-visible:ring-1", "focus-visible:ring-inset");
    }
  });
});
