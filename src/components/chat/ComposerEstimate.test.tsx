import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComposerEstimate } from "./ComposerEstimate";
import { formatTokenCount, formatTokens } from "../../lib/cost";

describe("ComposerEstimate", () => {
  it("is one fixed slot whose unit and count are demotion rungs, the cost the floor", () => {
    render(<ComposerEstimate cost={0.02} tokens={3200} modelName="Sonnet" />);
    const slot = screen.getByTestId("composer-estimate");
    expect(slot).toHaveClass("octo-estimate", "octo-tabular");
    expect(slot.textContent).toBe("≈ $0.02 · 3k tokens");
    expect(screen.getByText("≈ $0.02").closest(".octo-estimate-rung")).toBeNull();
    const count = slot.querySelector(".octo-estimate-count");
    // No-break spaces only: a plain one would be dropped at the rung's edge.
    expect(count?.textContent).toBe(" · 3k tokens");
    expect(count?.textContent).not.toContain(" ");
    expect(count?.querySelector(".octo-estimate-unit")?.textContent).toBe(" tokens");
    expect(slot).toHaveAttribute("title", expect.stringContaining("Estimate for Sonnet"));
    expect(slot).toHaveAttribute("data-tour", "talk-composer-estimate");
  });

  it("keeps the slot, empty and with the same metrics, when there is nothing to estimate", () => {
    const { rerender } = render(<ComposerEstimate cost={0.02} tokens={3200} modelName="Sonnet" />);
    const full = screen.getByTestId("composer-estimate").className;
    rerender(<ComposerEstimate cost={null} tokens={0} modelName="" />);
    const empty = screen.getByTestId("composer-estimate");
    expect(empty.textContent).toBe("");
    expect(empty.className).toBe(full);
    expect(empty).toHaveAttribute("aria-hidden");
  });
});

describe("formatTokenCount", () => {
  it("is the bare count formatTokens labels", () => {
    expect(formatTokenCount(850)).toBe("850");
    expect(formatTokenCount(3200)).toBe("3k");
    expect(formatTokenCount(1_234_567)).toBe("1.2M");
    expect(formatTokens(3200)).toBe("3k tokens");
  });
});
