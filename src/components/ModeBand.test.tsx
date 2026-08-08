import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModeBand } from "./ModeBand";

describe("ModeBand", () => {
  it("switches modes from the band", () => {
    const onChange = vi.fn();
    render(<ModeBand mode="run" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    expect(onChange).toHaveBeenCalledWith("review");
  });

  it("renders the status tail when there is one", () => {
    render(<ModeBand mode="run" onChange={vi.fn()} meta="2 terminals" />);
    expect(screen.getByText("2 terminals")).toBeInTheDocument();
  });

  it("renders no tail when the mode has nothing to report", () => {
    const { container } = render(<ModeBand mode="talk" onChange={vi.fn()} meta={null} />);
    // Only the switcher's own buttons — no empty text node holding a slot open.
    expect(container.querySelectorAll("span.truncate")).toHaveLength(0);
  });
});
