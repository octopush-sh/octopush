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

  it("centres the switcher in a track the tail cannot shift", () => {
    // The tail lives in its own grid track, so a long tail truncates instead
    // of pushing the pill off centre. jsdom has no layout, so this asserts the
    // structure that guarantees it: equal 1fr side tracks around an auto one.
    const { container } = render(
      <ModeBand mode="review" onChange={vi.fn()} meta="7 files changed · +214 −61" />,
    );
    const band = container.firstElementChild as HTMLElement;
    expect(band.className).toContain("grid-cols-[1fr_auto_1fr]");
    expect(band.children).toHaveLength(3);
    expect(band.children[1]).toContainElement(screen.getByRole("button", { name: /review/i }));
  });
});
