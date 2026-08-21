// src/components/primitives/primitives.test.tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Reveal } from "./Reveal";
import { FadeSwap } from "./FadeSwap";
import { MidTruncate } from "./MidTruncate";

describe("Reveal", () => {
  it("renders children and reflects open state via grid-template-rows + aria-hidden", () => {
    const { rerender, container } = render(<Reveal open={false}><p>hidden content</p></Reveal>);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.style.gridTemplateRows).toBe("0fr");
    expect(outer.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("hidden content")).toBeInTheDocument(); // stays mounted
    rerender(<Reveal open><p>hidden content</p></Reveal>);
    expect(outer.style.gridTemplateRows).toBe("1fr");
    expect(outer.getAttribute("aria-hidden")).toBe("false");
  });

  it("makes closed content inert", () => {
    const { container } = render(<Reveal open={false}><button>act</button></Reveal>);
    // `container` itself is a div, so "div > div" would match the outer Reveal
    // element — grab the inner content wrapper explicitly instead.
    const inner = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement;
    expect(inner.hasAttribute("inert")).toBe(true);
  });
});

describe("FadeSwap", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders children straight through for a stable key", () => {
    const { rerender } = render(<FadeSwap swapKey="a"><p>one</p></FadeSwap>);
    rerender(<FadeSwap swapKey="a"><p>two</p></FadeSwap>);
    expect(screen.getByText("two")).toBeInTheDocument(); // live content passes through
  });

  it("holds the old subtree during exit, then mounts the new one", () => {
    const { rerender, container } = render(<FadeSwap swapKey="a"><p>old view</p></FadeSwap>);
    rerender(<FadeSwap swapKey="b"><p>new view</p></FadeSwap>);
    // exit phase: old content still visible, fade-out class applied
    expect(screen.getByText("old view")).toBeInTheDocument();
    expect(screen.queryByText("new view")).not.toBeInTheDocument();
    expect((container.firstElementChild as HTMLElement).className).toContain("octo-fade-out");
    act(() => { vi.advanceTimersByTime(130); });
    expect(screen.getByText("new view")).toBeInTheDocument();
    expect(screen.queryByText("old view")).not.toBeInTheDocument();
    expect((container.firstElementChild as HTMLElement).className).toContain("octo-fade-in");
  });

  it("settles on the latest key when keys change rapidly", () => {
    const { rerender } = render(<FadeSwap swapKey="a"><p>A</p></FadeSwap>);
    rerender(<FadeSwap swapKey="b"><p>B</p></FadeSwap>);
    rerender(<FadeSwap swapKey="c"><p>C</p></FadeSwap>);
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByText("C")).toBeInTheDocument();
  });
});

describe("MidTruncate", () => {
  it("renders a short string whole — eliding it would cost more than it buys", () => {
    const { container } = render(<MidTruncate text="feat/auth" />);
    expect(container.textContent).toBe("feat/auth");
    expect(container.querySelector(".octo-midtrunc-head")).toBeNull();
  });

  it("gives the whole path its own non-flex box, so a hyphenated name can't wrap", () => {
    // Regression: the short path used to reuse `.octo-midtrunc`, whose bare
    // text became an anonymous flex item. `check-in` then broke at the hyphen
    // into two lines inside a 14px row, and `main` — with no break
    // opportunity at all — was hard-cut to `mai` instead.
    for (const text of ["main", "check-in", "post-app-release"]) {
      const { container, unmount } = render(<MidTruncate text={text} />);
      const el = container.firstElementChild!;
      expect(el).toHaveClass("octo-midtrunc-whole");
      expect(el).not.toHaveClass("octo-midtrunc");
      expect(el.textContent).toBe(text);
      unmount();
    }
  });

  it("keeps the caller's className on both paths", () => {
    const short = render(<MidTruncate text="main" className="text-[10px]" />);
    expect(short.container.firstElementChild).toHaveClass("text-[10px]");
    short.unmount();
    const long = render(<MidTruncate text={"x".repeat(40)} className="text-[10px]" />);
    expect(long.container.firstElementChild).toHaveClass("octo-midtrunc", "text-[10px]");
  });

  it("splits a long string into an ellipsizing head and a pinned tail", () => {
    const text = "a".repeat(40) + "-tail-marker";
    const { container } = render(<MidTruncate text={text} tail={12} />);
    expect(container.querySelector(".octo-midtrunc-head")).toHaveTextContent("a".repeat(40));
    expect(container.querySelector(".octo-midtrunc-tail")).toHaveTextContent("-tail-marker");
    // Nothing is dropped from the DOM — the elision is CSS, so the full string
    // is still selectable and still what a copy would yield.
    expect(container.textContent).toBe(text);
  });

  it("honours a custom tail length", () => {
    const { container } = render(<MidTruncate text="0123456789abcdef" tail={4} />);
    expect(container.querySelector(".octo-midtrunc-tail")).toHaveTextContent("cdef");
  });
});
