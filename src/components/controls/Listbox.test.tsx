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
    const anchor = screen.getByRole("button", { name: "Stage role" });
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

  it("shows the placeholder when value is null and closes on Escape", () => {
    render(<Listbox value={null} options={OPTIONS} onChange={() => {}} placeholder="— linear —" ariaLabel="Loop target" />);
    expect(screen.getByRole("button", { name: "Loop target" })).toHaveTextContent("— linear —");
    fireEvent.click(screen.getByRole("button", { name: "Loop target" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("marks the active option aria-selected", () => {
    render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
    fireEvent.click(screen.getByRole("button", { name: "Stage role" }));
    expect(screen.getByRole("option", { name: /Plan/ })).toHaveAttribute("aria-selected", "true");
  });

  it("opens with ArrowDown when closed and highlights the current option", () => {
    render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
    const anchor = screen.getByRole("button", { name: "Stage role" });
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
    const anchor = screen.getByRole("button", { name: "Stage role" });
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
    const anchor = screen.getByRole("button", { name: "Stage role" });
    fireEvent.keyDown(anchor, { key: "ArrowDown" });
    fireEvent.keyDown(anchor, { key: "End" });
    const implId = screen.getByRole("option", { name: /Implement/ }).id;
    expect(anchor).toHaveAttribute("aria-activedescendant", implId);
  });

  it("closes on Escape while open (via the trigger keydown)", () => {
    render(<Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />);
    const anchor = screen.getByRole("button", { name: "Stage role" });
    fireEvent.keyDown(anchor, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(anchor, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("uses the default onyx surface but lets triggerClassName replace it", () => {
    const { rerender } = render(
      <Listbox value="plan" options={OPTIONS} onChange={() => {}} ariaLabel="Stage role" />,
    );
    const anchor = screen.getByRole("button", { name: "Stage role" });
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
