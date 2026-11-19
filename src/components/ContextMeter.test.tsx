/**
 * The context meter shared by Talk's Conversation section and Run's Context
 * section: one figure, one bar, two thresholds.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextMeter, contextTone } from "./ContextMeter";

describe("contextTone", () => {
  it("is calm below 80%, warns from 80% and turns rouge from 95%", () => {
    expect(contextTone(148_000, 1_000_000).pct).toBeCloseTo(14.8);
    expect(contextTone(148_000, 1_000_000).tone).toBe("ok");
    expect(contextTone(799_999, 1_000_000).tone).toBe("ok");
    expect(contextTone(800_000, 1_000_000).tone).toBe("warning");
    expect(contextTone(949_999, 1_000_000).tone).toBe("warning");
    expect(contextTone(950_000, 1_000_000).tone).toBe("rouge");
  });

  it("caps at 100% and treats an unknown window as empty", () => {
    expect(contextTone(300_000, 200_000)).toEqual({ pct: 100, tone: "rouge" });
    expect(contextTone(50_000, 0)).toEqual({ pct: 0, tone: "ok" });
  });
});

describe("ContextMeter", () => {
  it("formats both counts with the shared context formatter", () => {
    render(<ContextMeter used={148_000} limit={1_000_000} testId="m" />);
    expect(screen.getByTestId("m")).toHaveTextContent("148k / 1M");
    expect(screen.getByTestId("m")).not.toHaveTextContent("%");
  });

  it("with a label, the figure takes the tone (Talk's row)", () => {
    render(<ContextMeter label="context" used={190_000} limit={200_000} testId="m" />);
    const meter = screen.getByTestId("m");
    expect(meter).toHaveTextContent("context");
    expect(meter).toHaveAttribute("data-tone", "rouge");
    expect(screen.getByText("190k / 200k").style.color).toBe("var(--color-octo-rouge)");
  });

  it("without a label, the figure stays ivory and only the bar carries the tone", () => {
    render(<ContextMeter used={170_000} limit={200_000} testId="m" />);
    const figure = screen.getByText("170k / 200k");
    expect(figure.className).toContain("text-octo-ivory");
    expect(figure.style.color).toBe("");
    const fill = screen.getByTestId("m").querySelector<HTMLElement>("[style*='width']")!;
    expect(fill.style.background).toBe("var(--color-octo-warning)");
    expect(fill.style.width).toBe("85%");
  });

  it("with no known window, shows the prompt's size alone and no bar", () => {
    render(<ContextMeter used={148_000} limit={null} testId="m" />);
    const meter = screen.getByTestId("m");
    expect(meter).toHaveTextContent("148k");
    expect(meter).not.toHaveTextContent("/");
    expect(meter.querySelector("[style*='width']")).toBeNull();
  });
});
