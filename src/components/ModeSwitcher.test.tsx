import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModeSwitcher } from "./ModeSwitcher";

describe("ModeSwitcher", () => {
  it("renders all 3 mode buttons", () => {
    render(<ModeSwitcher mode="talk" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /talk/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
  });

  it("marks the active mode with aria-pressed", () => {
    render(<ModeSwitcher mode="run" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /talk/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /run/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /review/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onChange with the clicked mode", () => {
    const onChange = vi.fn();
    render(<ModeSwitcher mode="talk" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    expect(onChange).toHaveBeenCalledWith("review");
  });
});
