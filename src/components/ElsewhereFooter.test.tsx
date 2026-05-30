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
    expect(screen.getByText(/3 tickets in-progress en otros proyectos/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalled();
  });
});
