import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ElsewhereFooter } from "./ElsewhereFooter";

describe("ElsewhereFooter", () => {
  it("renders nothing when count is 0", () => {
    const { container } = render(<ElsewhereFooter count={0} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders count and calls onOpen on click", () => {
    const onOpen = vi.fn();
    render(<ElsewhereFooter count={3} onOpen={onOpen} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toMatch(/3 tickets in-progress elsewhere/);
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });

  it("pluralizes: singular for exactly one ticket", () => {
    render(<ElsewhereFooter count={1} onOpen={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toMatch(/1 ticket in-progress elsewhere/);
    expect(button.textContent).not.toMatch(/tickets/);
  });

  it("the whole row is the button (full-width hit target)", () => {
    render(<ElsewhereFooter count={2} onOpen={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("w-full");
  });
});
