import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GroupContextMenu } from "./GroupContextMenu";
import { TINT_NAMES } from "../lib/monogram";

const base = {
  x: 10,
  y: 20,
  groupName: "Vulnerability fixes",
  tint: null,
  empty: false,
  onRename: vi.fn(),
  onTint: vi.fn(),
  onUngroup: vi.fn(),
  onDismiss: vi.fn(),
};

describe("GroupContextMenu", () => {
  it("names its subject and offers Rename, Tint and Ungroup", () => {
    render(<GroupContextMenu {...base} />);
    const menu = screen.getByRole("menu", { name: "Group actions" });
    expect(menu).toHaveTextContent("Vulnerability fixes");
    expect(menu.className).toMatch(/octo-menu-enter/);
    expect(screen.getByRole("menuitem", { name: /Rename/ })).toHaveTextContent("F2");
    expect(screen.getByRole("menuitem", { name: /Ungroup/ })).toHaveTextContent("Keeps the missions");
    expect(screen.queryByRole("menuitem", { name: "Remove group" })).toBeNull();
  });

  it("offers the seven existing tints plus None, each with an accessible name", () => {
    render(<GroupContextMenu {...base} tint="rouge" />);
    const swatches = screen.getAllByRole("menuitemradio");
    expect(swatches.map((s) => s.getAttribute("aria-label"))).toEqual([
      "No tint",
      "Brass",
      "Verdigris",
      "Rouge",
      "Indigo",
      "Lavender",
      "Smoke",
      "Bone",
    ]);
    expect(swatches).toHaveLength(TINT_NAMES.length + 1);
    for (const s of swatches) expect(s).toHaveAttribute("title", s.getAttribute("aria-label"));
    expect(swatches.filter((s) => s.getAttribute("aria-checked") === "true")).toEqual([
      screen.getByRole("menuitemradio", { name: "Rouge" }),
    ]);
    expect(screen.getByRole("group", { name: "Tint" })).toContainElement(swatches[0]);
  });

  it("picking a tint reports it and leaves the menu open; None clears it", () => {
    const onTint = vi.fn();
    const onDismiss = vi.fn();
    render(<GroupContextMenu {...base} onTint={onTint} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Lavender" }));
    expect(onTint).toHaveBeenLastCalledWith("lavender");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "No tint" }));
    expect(onTint).toHaveBeenLastCalledWith(null);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("the swatch row is one stop of the ↑/↓ walk, and ←/→ move along it", () => {
    render(<GroupContextMenu {...base} tint="indigo" />);
    const current = screen.getByRole("menuitemradio", { name: "Indigo" });
    // ↓ from Rename lands on the current swatch, then on Ungroup.
    expect(screen.getByRole("menuitem", { name: /Rename/ })).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(current).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /Ungroup/ })).toHaveFocus();
    // Only one swatch is ever a tab stop.
    const stops = () => screen.getAllByRole("menuitemradio").filter((s) => s.tabIndex === 0);
    expect(stops()).toEqual([current]);
  });

  it("after ←/→ onto another swatch, ↓ goes on to the next row and ↑ to the one before", () => {
    render(<GroupContextMenu {...base} tint="indigo" onNewMission={vi.fn()} />);
    const swatch = (name: string) => screen.getByRole("menuitemradio", { name });
    swatch("Indigo").focus();
    fireEvent.keyDown(swatch("Indigo"), { key: "ArrowRight" });
    expect(swatch("Lavender")).toHaveFocus();
    // The stop moved with the focus; the checked tint did not.
    expect(screen.getAllByRole("menuitemradio").filter((s) => s.tabIndex === 0)).toEqual([swatch("Lavender")]);
    expect(swatch("Indigo")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /Ungroup/ })).toHaveFocus();

    // Back up: the row is entered where it was left, then the row above it.
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(swatch("Lavender")).toHaveFocus();
    fireEvent.keyDown(swatch("Lavender"), { key: "ArrowLeft" });
    fireEvent.keyDown(swatch("Indigo"), { key: "ArrowLeft" });
    expect(swatch("Rouge")).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "New mission in this group" })).toHaveFocus();
    // ← from the first swatch wraps to the last.
    swatch("No tint").focus();
    fireEvent.keyDown(swatch("No tint"), { key: "ArrowLeft" });
    expect(swatch("Bone")).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /Ungroup/ })).toHaveFocus();
  });

  it("Rename and Ungroup run and close the menu", () => {
    const onRename = vi.fn();
    const onUngroup = vi.fn();
    const onDismiss = vi.fn();
    render(<GroupContextMenu {...base} onRename={onRename} onUngroup={onUngroup} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    expect(onRename).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("menuitem", { name: /Ungroup/ }));
    expect(onUngroup).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("an empty group offers Remove group instead of Ungroup", () => {
    const onUngroup = vi.fn();
    render(<GroupContextMenu {...base} empty onUngroup={onUngroup} />);
    expect(screen.queryByRole("menuitem", { name: /Ungroup/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove group" }));
    expect(onUngroup).toHaveBeenCalledTimes(1);
  });

  it("offers New mission in this group only when the flow is wired", () => {
    const onNewMission = vi.fn();
    const { rerender } = render(<GroupContextMenu {...base} />);
    expect(screen.queryByRole("menuitem", { name: /New mission/ })).toBeNull();
    rerender(<GroupContextMenu {...base} onNewMission={onNewMission} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "New mission in this group" }));
    expect(onNewMission).toHaveBeenCalledTimes(1);
  });

  it("a project group's Ungroup says it keeps the projects", () => {
    render(<GroupContextMenu {...base} groupName="Client work" holds="projects" />);
    expect(screen.getByRole("menuitem", { name: /Ungroup/ })).toHaveTextContent("Keeps the projects");
    expect(screen.queryByRole("menuitem", { name: /New mission/ })).toBeNull();
  });

  it("offers Move up and Move down only where they are wired, runs them and closes", () => {
    const { unmount } = render(<GroupContextMenu {...base} />);
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Move down" })).toBeNull();
    unmount();
    const onMoveDown = vi.fn();
    const onDismiss = vi.fn();
    render(<GroupContextMenu {...base} holds="projects" onMoveDown={onMoveDown} onDismiss={onDismiss} />);
    // At the top of the rail there is no way up.
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
    expect(onMoveDown).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
