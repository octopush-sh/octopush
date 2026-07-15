// src/components/controls/Listbox.test.tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Listbox } from "./Listbox";

const OPTIONS = [
  { value: "plan", label: "Plan", description: "Outline the approach" },
  { value: "implement", label: "Implement" },
];

describe("Listbox", () => {
  it("shows the current label, opens a portal listbox, selects, and closes", () => {
    const onChange = vi.fn();
    render(<Listbox value="plan" options={OPTIONS} onChange={onChange} ariaLabel="Stage role" />);
    const anchor = screen.getByRole("combobox", { name: "Stage role" });
    expect(anchor).toHaveTextContent("Plan");
    fireEvent.click(anchor);
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(document.body.contains(listbox)).toBe(true); // portaled
    expect(screen.getByText("Outline the approach")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Implement/ }));
    expect(onChange).toHaveBeenCalledWith("implement");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows the placeholder when value is null", () => {
    render(<Listbox value={null} options={OPTIONS} onChange={() => {}} placeholder="— linear —" ariaLabel="Loop target" />);
    expect(screen.getByRole("combobox", { name: "Loop target" })).toHaveTextContent("— linear —");
  });

  it("marks the active option aria-selected", () => {
    render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
    fireEvent.click(screen.getByRole("combobox", { name: "Stage role" }));
    expect(screen.getByRole("option", { name: /Plan/ })).toHaveAttribute("aria-selected", "true");
  });

  it("is a combobox that controls the portaled listbox panel", () => {
    render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
    const anchor = screen.getByRole("combobox", { name: "Stage role" });
    expect(anchor).toHaveAttribute("aria-haspopup", "listbox");
    fireEvent.click(anchor);
    const panelId = anchor.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(screen.getByRole("listbox").id).toBe(panelId);
  });

  it("focuses the trigger on open (WebKit click-focus workaround)", () => {
    render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
    const anchor = screen.getByRole("combobox", { name: "Stage role" });
    anchor.blur();
    fireEvent.click(anchor);
    expect(anchor).toHaveFocus();
  });

  it("opens with ArrowDown when closed and highlights the current option", () => {
    render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
    const anchor = screen.getByRole("combobox", { name: "Stage role" });
    expect(anchor).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(anchor, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(anchor).toHaveAttribute("aria-expanded", "true");
    // The current selection ("plan") is highlighted via aria-activedescendant.
    const planId = screen.getByRole("option", { name: /Plan/ }).id;
    expect(anchor).toHaveAttribute("aria-activedescendant", planId);
  });

  it("moves the highlight with arrows and selects with Enter", () => {
    const onChange = vi.fn();
    render(<Listbox value="plan" options={OPTIONS} onChange={onChange} ariaLabel="Stage role" />);
    const anchor = screen.getByRole("combobox", { name: "Stage role" });
    fireEvent.keyDown(anchor, { key: "Enter" }); // open (highlights "plan")
    fireEvent.keyDown(anchor, { key: "ArrowDown" }); // move to "implement"
    const implId = screen.getByRole("option", { name: /Implement/ }).id;
    expect(anchor).toHaveAttribute("aria-activedescendant", implId);
    fireEvent.keyDown(anchor, { key: "Enter" }); // select highlighted
    expect(onChange).toHaveBeenCalledWith("implement");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("jumps the highlight to the last option with End", () => {
    render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
    const anchor = screen.getByRole("combobox", { name: "Stage role" });
    fireEvent.keyDown(anchor, { key: "ArrowDown" });
    fireEvent.keyDown(anchor, { key: "End" });
    const implId = screen.getByRole("option", { name: /Implement/ }).id;
    expect(anchor).toHaveAttribute("aria-activedescendant", implId);
  });

  it("type-ahead cycles through options that share a starting letter", () => {
    const opts = [
      { value: "a1", label: "Apple" },
      { value: "a2", label: "Avocado" },
      { value: "b", label: "Banana" },
    ];
    render(<Listbox value="a1" options={opts} onChange={() => {}} ariaLabel="Fruit" />);
    const anchor = screen.getByRole("combobox", { name: "Fruit" });
    fireEvent.keyDown(anchor, { key: "ArrowDown" }); // open, highlight "Apple"
    fireEvent.keyDown(anchor, { key: "a" }); // → next "a": Avocado
    expect(anchor).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: /Avocado/ }).id);
    fireEvent.keyDown(anchor, { key: "a" }); // → wraps to Apple
    expect(anchor).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: /Apple/ }).id);
  });

  it("closes on Escape while open and does NOT let it bubble to window (ModalShell shield)", () => {
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    try {
      render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
      const anchor = screen.getByRole("combobox", { name: "Stage role" });
      fireEvent.keyDown(anchor, { key: "ArrowDown" }); // open
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      windowEsc.mockClear();
      fireEvent.keyDown(anchor, { key: "Escape" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      // stopPropagation kept Escape from reaching a surrounding modal's window listener.
      expect(windowEsc).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowEsc);
    }
  });

  it("renders a non-interactive empty state when there are no options", () => {
    render(<Listbox value={null} options={[]} onChange={() => {}} ariaLabel="Nothing" />);
    const anchor = screen.getByRole("combobox", { name: "Nothing" });
    fireEvent.click(anchor);
    expect(screen.getByText("No options")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(anchor).not.toHaveAttribute("aria-activedescendant");
  });

  it("uses the default onyx surface but lets triggerClassName replace it", () => {
    const { rerender } = render(
      <Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />,
    );
    const anchor = screen.getByRole("combobox", { name: "Stage role" });
    // Default surface is applied; structural classes are always present.
    expect(anchor.className).toContain("bg-octo-onyx");
    expect(anchor.className).toContain("rounded-md");

    rerender(
      <Listbox
        value="plan"
        options={OPTIONS}
        onChange={() => {}}
        ariaLabel="Stage role"
        triggerClassName="border border-octo-hairline bg-octo-bg focus:border-octo-brass"
      />,
    );
    // Override replaces the surface (no onyx) but keeps the structural classes.
    expect(anchor.className).not.toContain("bg-octo-onyx");
    expect(anchor.className).toContain("bg-octo-bg");
    expect(anchor.className).toContain("focus:border-octo-brass");
    expect(anchor.className).toContain("rounded-md");
  });
});
