import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { OctoWatcher, gazeOffset } from "./OctoWatcher";

describe("gazeOffset", () => {
  it("clamps to 2.4 units and points toward the cursor", () => {
    const far = gazeOffset(0, 0, 1000, 0);
    expect(far.x).toBeCloseTo(2.4, 3);
    expect(far.y).toBeCloseTo(0, 3);
    const near = gazeOffset(0, 0, 120, 0); // half the 240px normalization
    expect(near.x).toBeCloseTo(1.2, 3);
    const diag = gazeOffset(0, 0, -1000, -1000);
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(2.4, 3);
    expect(diag.x).toBeLessThan(0);
  });
});

describe("OctoWatcher fidgets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount() {
    const areaRef = createRef<HTMLDivElement>();
    const utils = render(
      <div ref={areaRef}>
        <OctoWatcher areaRef={areaRef} />
      </div>,
    );
    return { areaRef, ...utils };
  }

  it("fires the first gesture after 15s of keyboard silence", () => {
    const { container } = mount();
    expect(container.querySelector("svg")?.getAttribute("data-gesture")).toBe("none");
    act(() => vi.advanceTimersByTime(15_100));
    expect(container.querySelector("svg")?.getAttribute("data-gesture")).not.toBe("none");
  });

  it("a keystroke re-arms the timer", () => {
    const { container } = mount();
    act(() => vi.advanceTimersByTime(10_000));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector("svg")?.getAttribute("data-gesture")).toBe("none");
    act(() => vi.advanceTimersByTime(5_200));
    expect(container.querySelector("svg")?.getAttribute("data-gesture")).not.toBe("none");
  });

  it("cycles look → scratch → peek", () => {
    const { container } = mount();
    const g = () => container.querySelector("svg")?.getAttribute("data-gesture");
    act(() => vi.advanceTimersByTime(15_100));
    expect(g()).toBe("look");
    act(() => vi.advanceTimersByTime(2_000)); // look ends (1.8s) → timer re-arms
    act(() => vi.advanceTimersByTime(15_100));
    expect(g()).toBe("scratch");
    act(() => vi.advanceTimersByTime(3_000)); // scratch ends (2.8s)
    act(() => vi.advanceTimersByTime(15_100));
    expect(g()).toBe("peek");
  });
});
