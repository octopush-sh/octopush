import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModeSwitcher } from "./ModeSwitcher";

describe("ModeSwitcher", () => {
  it("renders all 4 mode buttons", () => {
    render(<ModeSwitcher mode="talk" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /talk/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /direct/i })).toBeInTheDocument();
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

  it("names every mode without its label, so an icon-only segment still has a name and a tooltip", () => {
    render(<ModeSwitcher mode="run" onChange={vi.fn()} />);
    for (const [name, title] of [
      ["Run", "Run (⌘⇧2)"],
      ["Talk", "Talk (⌘⇧1)"],
      ["Review", "Review (⌘⇧3)"],
      ["Direct", "Direct (⌘⇧D)"],
    ]) {
      const segment = screen.getByRole("button", { name });
      expect(segment).toHaveAttribute("aria-label", name);
      expect(segment).toHaveAttribute("title", title);
      expect(segment.querySelector("svg")).not.toBeNull();
    }
  });

  it("puts each label on the band's ladder; the pressed one is the rung that never sheds", () => {
    render(<ModeSwitcher mode="review" onChange={vi.fn()} />);
    const segments = screen.getAllByRole("button");
    expect(segments).toHaveLength(4);
    for (const segment of segments) {
      expect(segment.className).toContain("octo-mode-seg");
      const label = segment.querySelector(".octo-demote-mode-label")!;
      expect(label.className).toContain("octo-demote");
      expect(label).toHaveTextContent(segment.getAttribute("aria-label")!);
    }
    // The sheet sheds `.octo-mode-seg:not([aria-pressed="true"])` labels only.
    expect(segments.filter((s) => s.getAttribute("aria-pressed") === "true").map((s) => s.textContent)).toEqual(["Review"]);
  });
});
