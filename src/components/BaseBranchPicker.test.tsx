import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BaseBranchPicker } from "./BaseBranchPicker";

const BRANCHES = ["main", "feat-x", "release/1.0"];
const TRIGGER_TITLE = "Base branch — the new branch starts from here";

describe("BaseBranchPicker", () => {
  it("renders a trigger button with the selected base and an explanatory title", () => {
    render(<BaseBranchPicker branches={BRANCHES} value="main" onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /main/ });
    expect(trigger).toHaveAttribute("title", TRIGGER_TITLE);
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  });

  it("contains no arrow/chevron/caret glyphs in the trigger", () => {
    render(<BaseBranchPicker branches={BRANCHES} value="main" onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /main/ });
    expect(trigger.textContent).not.toMatch(/[→⟶▾▼▲↓↑‹›«»<>⌄ˇ]/);
  });

  it("opens a role=menu portaled to body (fixed) on click", () => {
    const { container } = render(
      <BaseBranchPicker branches={BRANCHES} value="main" onSelect={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /main/ }));
    const menu = screen.getByRole("menu", { name: "Choose base branch" });
    expect(container.contains(menu)).toBe(false);
    expect(menu.className).toContain("fixed");
  });

  it("renders one menuitem per branch", () => {
    render(<BaseBranchPicker branches={BRANCHES} value="main" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /main/ }));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(BRANCHES.length);
    expect(items.map((i) => i.textContent)).toEqual(BRANCHES);
  });

  it("marks only the selected branch with a check glyph", () => {
    render(<BaseBranchPicker branches={BRANCHES} value="release/1.0" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /release\/1\.0/ }));
    const selected = screen.getByRole("menuitem", { name: /release\/1\.0/ });
    const other = screen.getByRole("menuitem", { name: /feat-x/ });
    expect(selected.querySelector("svg")).not.toBeNull();
    expect(other.querySelector("svg")).toBeNull();
  });

  it("selecting a branch calls onSelect and dismisses the menu", () => {
    const onSelect = vi.fn();
    render(<BaseBranchPicker branches={BRANCHES} value="main" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /main/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /release\/1\.0/ }));
    expect(onSelect).toHaveBeenCalledWith("release/1.0");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("gives each menuitem a title so long branch names stay readable", () => {
    render(<BaseBranchPicker branches={BRANCHES} value="main" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /main/ }));
    const item = screen.getByRole("menuitem", { name: /release\/1\.0/ });
    expect(item).toHaveAttribute("title", "release/1.0");
  });

  it("degrades to a static label (no button) when there are no branches", () => {
    render(<BaseBranchPicker branches={[]} value="main" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("main")).toBeInTheDocument();
  });

  it('shows "default" in the degenerate case when value is null', () => {
    render(<BaseBranchPicker branches={[]} value={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it("supports keyboard dismissal with Escape", () => {
    render(<BaseBranchPicker branches={BRANCHES} value="main" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /main/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
