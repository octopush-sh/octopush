import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BaseBranchPicker } from "./BaseBranchPicker";

const BRANCHES = ["main", "feat-x", "release/1.0"];
const TRIGGER_TITLE = "Base branch: main — the new branch starts from here";

describe("BaseBranchPicker", () => {
  it("renders a trigger button with the selected base and an explanatory title", () => {
    render(<BaseBranchPicker branches={BRANCHES} value="main" onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /main/ });
    expect(trigger).toHaveAttribute("title", TRIGGER_TITLE);
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // The inner label span must NOT carry its own title — it would shadow
    // the button tooltip on hover.
    expect(trigger.querySelector("[title]")).toBeNull();
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
    expect(screen.getByRole("button", { name: /main/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
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

  describe("scroll & filter", () => {
    const MANY = [
      "main",
      "feat-a",
      "feat-b",
      "feat-c",
      "feat-d",
      "fix-e",
      "fix-f",
      "release/1.0",
      "release/2.0",
    ]; // 9 branches — above the filter threshold

    function openMenu(branches: string[], value = branches[0]) {
      render(<BaseBranchPicker branches={branches} value={value} onSelect={vi.fn()} />);
      fireEvent.click(screen.getByRole("button"));
    }

    it("the items container scrolls (max-height + overflow) so long lists never overflow the viewport", () => {
      openMenu(MANY);
      const menu = screen.getByRole("menu", { name: "Choose base branch" });
      const scroller = menu.querySelector(".overflow-y-auto");
      expect(scroller).not.toBeNull();
      expect(scroller!.className).toContain("max-h-[40vh]");
      // The menuitems live inside the scroll container.
      expect(scroller!.querySelectorAll('[role="menuitem"]')).toHaveLength(MANY.length);
    });

    it("renders a filter input when there are more than 8 branches", () => {
      openMenu(MANY);
      expect(screen.getByPlaceholderText("Filter branches")).toBeInTheDocument();
    });

    it("hides the filter input at 8 branches or fewer", () => {
      openMenu(MANY.slice(0, 8));
      expect(screen.queryByPlaceholderText("Filter branches")).toBeNull();
    });

    it("typing in the filter narrows the items case-insensitively", () => {
      openMenu(MANY);
      fireEvent.change(screen.getByPlaceholderText("Filter branches"), {
        target: { value: "RELEASE" },
      });
      const items = screen.getAllByRole("menuitem");
      expect(items.map((i) => i.textContent)).toEqual(["release/1.0", "release/2.0"]);
    });

    it("shows a quiet 'No branches match' line when the filter eliminates everything", () => {
      openMenu(MANY);
      fireEvent.change(screen.getByPlaceholderText("Filter branches"), {
        target: { value: "zzz-nope" },
      });
      expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
      expect(screen.getByText("No branches match")).toBeInTheDocument();
    });

    it("clearing the filter restores the full list", () => {
      openMenu(MANY);
      const input = screen.getByPlaceholderText("Filter branches");
      fireEvent.change(input, { target: { value: "release" } });
      expect(screen.getAllByRole("menuitem")).toHaveLength(2);
      fireEvent.change(input, { target: { value: "" } });
      expect(screen.getAllByRole("menuitem")).toHaveLength(MANY.length);
    });

    it("the filter input keeps focus on open (it wins over the menu's first-item autofocus)", () => {
      openMenu(MANY);
      expect(document.activeElement).toBe(screen.getByPlaceholderText("Filter branches"));
    });

    it("ArrowDown from the filter input moves focus into the first menuitem", () => {
      openMenu(MANY);
      const input = screen.getByPlaceholderText("Filter branches");
      expect(document.activeElement).toBe(input);
      fireEvent.keyDown(window, { key: "ArrowDown" });
      const items = screen.getAllByRole("menuitem");
      expect(document.activeElement).toBe(items[0]);
    });

    it("scrolls the selected branch into view on open", () => {
      const spy = vi.fn();
      const proto = window.HTMLElement.prototype as unknown as {
        scrollIntoView?: (opts?: unknown) => void;
      };
      const original = proto.scrollIntoView;
      proto.scrollIntoView = spy;
      try {
        openMenu(MANY, "release/2.0");
        expect(spy).toHaveBeenCalledWith({ block: "nearest" });
      } finally {
        if (original) proto.scrollIntoView = original;
        else delete proto.scrollIntoView;
      }
    });
  });
});
