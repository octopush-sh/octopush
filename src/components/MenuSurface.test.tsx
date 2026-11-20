import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MenuSurface } from "./MenuSurface";
import { MENU_ITEM } from "../lib/menuStyles";

afterEach(cleanup);

function renderSurface(onDismiss = vi.fn()) {
  const utils = render(
    <MenuSurface x={40} y={60} ariaLabel="Test actions" onDismiss={onDismiss}>
      <button type="button" role="menuitem" className={MENU_ITEM}>
        First
      </button>
      <button type="button" role="menuitem" className={MENU_ITEM}>
        Second
      </button>
    </MenuSurface>,
  );
  return { ...utils, onDismiss };
}

describe("MenuSurface", () => {
  it("renders a role=menu portaled to document.body with fixed z-[60] chrome", () => {
    const { container } = renderSurface();
    const menu = screen.getByRole("menu", { name: "Test actions" });
    // Portal: the menu must NOT live inside the render container.
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    expect(menu.className).toContain("fixed");
    expect(menu.className).toContain("z-[60]");
    expect(menu.className).toContain("octo-menu-enter");
  });

  it("focuses the first menuitem on open (useMenuChrome behavior)", () => {
    renderSurface();
    expect(document.activeElement?.textContent).toBe("First");
  });

  it("dismisses on Escape", () => {
    const { onDismiss } = renderSurface();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses on outside mousedown but not on inside clicks", () => {
    const { onDismiss } = renderSurface();
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "First" }));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("supports a custom width class", () => {
    render(
      <MenuSurface x={0} y={0} ariaLabel="Wide" onDismiss={() => {}} widthClass="w-[244px]">
        <button type="button" role="menuitem">
          Only
        </button>
      </MenuSurface>,
    );
    expect(screen.getByRole("menu", { name: "Wide" }).className).toContain("w-[244px]");
  });

  it("↑/↓ from a focused control that is not a row go on from where it stands", () => {
    render(
      <MenuSurface x={0} y={0} ariaLabel="Walk" onDismiss={vi.fn()}>
        <button type="button" role="menuitem">One</button>
        <button type="button" data-testid="aside">Not a row</button>
        <button type="button" role="menuitem">Two</button>
        <button type="button" role="menuitem">Three</button>
      </MenuSurface>,
    );
    const aside = screen.getByTestId("aside");
    aside.focus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Two" })).toHaveFocus();
    aside.focus();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
  });

  it("walks radio and checkbox rows, and skips rows out of the tab order and plain controls", () => {
    render(
      <MenuSurface x={0} y={0} ariaLabel="Walk" onDismiss={vi.fn()}>
        <button type="button" role="menuitemradio" aria-checked="false" tabIndex={-1}>Swatch a</button>
        <button type="button" role="menuitemradio" aria-checked="true" tabIndex={0}>Swatch b</button>
        <button type="button" role="menuitem">One</button>
        <button type="button" role="menuitemcheckbox" aria-checked="false">Check</button>
        <button type="button">Plain</button>
        <button type="button" role="menuitem" disabled>Off</button>
      </MenuSurface>,
    );
    const focusedName = () => document.activeElement?.textContent;
    // The first focus uses the same rule as the walk: not the row at -1.
    expect(focusedName()).toBe("Swatch b");
    const seen = [focusedName()];
    for (let i = 0; i < 3; i++) {
      fireEvent.keyDown(window, { key: "ArrowDown" });
      seen.push(focusedName());
    }
    expect(seen).toEqual(["Swatch b", "One", "Check", "Swatch b"]);
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(focusedName()).toBe("Check");
  });

  it("walks a nested menu on its own", () => {
    render(
      <MenuSurface x={0} y={0} ariaLabel="Walk" onDismiss={vi.fn()}>
        <button type="button" role="menuitem">One</button>
        <div role="menu" aria-label="Inner">
          <button type="button" role="menuitemradio" aria-checked="true">Inner one</button>
          <button type="button" role="menuitem">Inner two</button>
        </div>
        <button type="button" role="menuitem">Two</button>
      </MenuSurface>,
    );
    const item = (name: string) => screen.getByRole("menuitem", { name });
    const inner = screen.getByRole("menuitemradio", { name: "Inner one" });
    expect(item("One")).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(item("Two")).toHaveFocus(); // the nested menu's rows are not the parent's
    item("Inner two").focus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(inner).toHaveFocus(); // and it wraps inside itself
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(item("Inner two")).toHaveFocus();
  });
});
