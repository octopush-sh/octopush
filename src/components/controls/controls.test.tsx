// src/components/controls/controls.test.tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SegmentedControl } from "./SegmentedControl";
import { TogglePill } from "./TogglePill";
import { Stepper } from "./Stepper";
import { IconButton } from "./IconButton";

describe("SegmentedControl", () => {
  const opts = [
    { value: "api", label: "API" },
    { value: "cli", label: "CLI" },
  ];
  it("marks the active option and fires onChange", () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={opts} value="api" onChange={onChange} ariaLabel="Substrate" />);
    expect(screen.getByRole("radio", { name: "API" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "CLI" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("radio", { name: "CLI" }));
    expect(onChange).toHaveBeenCalledWith("cli");
  });
});

describe("TogglePill", () => {
  it("is a switch reflecting its state and toggling", () => {
    const onChange = vi.fn();
    render(<TogglePill on={false} onChange={onChange} label="⟜ gate" />);
    const sw = screen.getByRole("switch", { name: "⟜ gate" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Stepper", () => {
  it("clamps at min and steps value", () => {
    const onChange = vi.fn();
    render(<Stepper value={1} min={1} max={9} onChange={onChange} ariaLabel="Max loop-backs" />);
    expect(screen.getByRole("button", { name: "Decrease" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(onChange).toHaveBeenCalledWith(2);
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});

describe("IconButton", () => {
  it("exposes its label and respects disabled", () => {
    const onClick = vi.fn();
    render(<IconButton label="Move up" onClick={onClick} disabled>x</IconButton>);
    const btn = screen.getByRole("button", { name: "Move up" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
