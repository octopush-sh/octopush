// src/components/primitives/primitives.test.tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Reveal } from "./Reveal";
import { FadeSwap } from "./FadeSwap";
import {
  MidTruncate,
  flatten,
  graphemeBoundaries,
  lastFitting,
  seatEllipsis,
  trimTrailingSpace,
  widthAnchor,
} from "./MidTruncate";
import { readable } from "../../test-utils/readable";

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
    expect(readable(container)).toBe(text);
  });

  it("draws an optional lead glyph inside the box, on both paths", () => {
    // Inside, so a wash or ring on the box covers glyph and text as one chip.
    for (const text of ["main", "a".repeat(40) + "-tail-marker"]) {
      const { container, unmount } = render(
        <MidTruncate text={text} lead={<svg data-testid="lead" />} />,
      );
      const box = container.firstElementChild!;
      const lead = box.querySelector(".octo-midtrunc-lead");
      expect(lead).toBeTruthy();
      expect(lead).toHaveAttribute("aria-hidden");
      expect(box.firstElementChild).toBe(lead);
      expect(lead!.querySelector("[data-testid='lead']")).toBeTruthy();
      expect(readable(box)).toBe(text);
      unmount();
    }
  });

  it("renders no lead slot when none is given, so other uses don't change", () => {
    const short = render(<MidTruncate text="main" />);
    expect(short.container.querySelector(".octo-midtrunc-lead")).toBeNull();
    short.unmount();
    const long = render(<MidTruncate text={"x".repeat(40)} />);
    expect(long.container.querySelector(".octo-midtrunc-lead")).toBeNull();
  });

  it("honours a custom tail length", () => {
    const { container } = render(<MidTruncate text="0123456789abcdef" tail={4} />);
    expect(container.querySelector(".octo-midtrunc-tail")).toHaveTextContent("cdef");
  });
});

describe("MidTruncate — the ellipsis butts against the tail (#750)", () => {
  it("never cuts inside a grapheme", () => {
    expect(graphemeBoundaries("a🐙é")).toEqual([0, 1, 3, 4]);
    expect(graphemeBoundaries("")).toEqual([0]);
  });

  it("finds the last boundary whose prefix fits", () => {
    const widthTo = (i: number) => i * 7; // 7px a character
    expect(lastFitting([0, 1, 2, 3, 4, 5], widthTo, 22)).toBe(3);
    expect(lastFitting([0, 1, 2, 3, 4, 5], widthTo, 20.9)).toBe(2); // no rounding allowance: the cut must fit
    expect(lastFitting([0, 1, 2, 3, 4, 5], widthTo, 100)).toBe(5);
    expect(lastFitting([0, 1, 2], widthTo, 3)).toBe(0);
  });

  it("drops whitespace before the cut, so no stray space precedes the ellipsis", () => {
    expect(trimTrailingSpace("Production deploy (o", 11)).toBe(10);
    expect(trimTrailingSpace("a  b", 3)).toBe(1);
    expect(trimTrailingSpace("abc", 2)).toBe(2);
  });

  it("leaves the CSS ellipsis in place where nothing overflows", () => {
    const { container } = render(<MidTruncate text={"Production deploy (octopush-web)-1"} tail={14} />);
    const box = container.querySelector(".octo-midtrunc")!;
    expect(box).not.toHaveAttribute("data-elided");
    expect(readable(box)).toBe("Production deploy (octopush-web)-1");
  });
});

describe("MidTruncate — review fixes (#807)", () => {
  // A hand-cranked frame and observer, so each layout pass is explicit.
  let frames: FrameRequestCallback[] = [];
  let observed: Element[] = [];
  let resize: ResizeObserverCallback | null = null;
  const flushFrames = () => {
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(0));
  };
  // Fake layout, 7px a glyph and 9px for the `…`: `room` is the head's own
  // width (with the `…` span taking none, as in CSS until the cut). The head's
  // natural width follows from its text.
  const GLYPH = 7;
  const ELL = 9;
  let room = 0;
  const realRangeRect = Range.prototype.getBoundingClientRect;

  beforeEach(() => {
    frames = [];
    observed = [];
    resize = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          resize = cb;
        }
        observe(el: Element) {
          observed.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.classList.contains("octo-midtrunc-head") ? room : 0;
      return { left: 0, right: width, top: 0, bottom: 0, width, height: 0 } as DOMRect;
    });
    Range.prototype.getBoundingClientRect = function (this: Range) {
      const inEll = this.startContainer.parentElement?.classList.contains("octo-midtrunc-ell");
      const w = (this.endOffset - this.startOffset) * (inEll ? ELL : GLYPH);
      return { left: 0, right: w, top: 0, bottom: 0, width: w, height: 0 } as DOMRect;
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Range.prototype.getBoundingClientRect = realRangeRect;
  });

  const text = "Production deploy (octopush-web)-12345";
  const ROW = { display: "flex" } as const;
  const SHRINK = { display: "flex", minWidth: 0 } as const; // a cell that doesn't grow
  const fire = (target: Element, width: number) =>
    act(() => resize!([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver));

  it("observes the row, not a parent that sizes to its content, and re-cuts when it widens", () => {
    room = 70;
    const { getByTestId, container } = render(
      <div data-testid="row" style={ROW}>
        <span data-testid="cell" style={SHRINK}>
          <MidTruncate text={text} tail={14} />
        </span>
      </div>,
    );
    expect(observed).toEqual([getByTestId("row")]);
    expect(widthAnchor(container.querySelector(".octo-midtrunc") as HTMLElement)).toBe(getByTestId("row"));
    act(flushFrames);
    const box = container.querySelector(".octo-midtrunc")!;
    const head = container.querySelector<HTMLElement>(".octo-midtrunc-head")!;
    expect(box).toHaveAttribute("data-elided");
    // 70px of room, 9 of them reserved for the `…`: 8 glyphs (56px) fit, and
    // the head is sized to hold them and its own `…` (+ the rounding slack).
    expect(head.style.maxWidth).toBe("65.5px");

    // The row widens until the whole head fits: the stale cut must go.
    room = (text.length - 14) * GLYPH;
    fire(getByTestId("row"), 900);
    act(flushFrames);
    expect(box).not.toHaveAttribute("data-elided");
    expect(head.style.maxWidth).toBe("");
  });

  it("observes a parent that grows into the row (flex-1), as before", () => {
    const { getByTestId } = render(
      <div style={ROW}>
        <span data-testid="grown" style={{ display: "flex", flexGrow: 1, minWidth: 0 }}>
          <MidTruncate text={text} tail={14} />
        </span>
      </div>,
    );
    expect(observed).toEqual([getByTestId("grown")]);
  });

  it("skips the re-cut when the row moves by less than a pixel", () => {
    room = 70;
    const { getByTestId } = render(
      <div data-testid="row" style={ROW}>
        <MidTruncate text={text} tail={14} />
      </div>,
    );
    act(flushFrames);
    fire(getByTestId("row"), 400);
    act(flushFrames);
    fire(getByTestId("row"), 400.6);
    expect(frames).toHaveLength(0);
    fire(getByTestId("row"), 402);
    expect(frames).toHaveLength(1);
  });

  it("adds up sub-pixel steps until they reach a pixel, then re-cuts", () => {
    room = 70;
    const { getByTestId } = render(
      <div data-testid="row" style={ROW}>
        <MidTruncate text={text} tail={14} />
      </div>,
    );
    act(flushFrames);
    fire(getByTestId("row"), 400);
    act(flushFrames);
    fire(getByTestId("row"), 400.6);
    expect(frames).toHaveLength(0);
    // 1.2px from the last re-cut, though only 0.6px from the last report.
    fire(getByTestId("row"), 401.2);
    expect(frames).toHaveLength(1);
  });

  it("reserves the ellipsis: head + `…` + tail never exceed the box", () => {
    // No spaces, so every cut is a whole-glyph boundary the trim leaves alone.
    const ident = "intermittent-component-not-per-shard-guard";
    const TAIL = 14;
    const tailPx = TAIL * GLYPH;
    for (const boxPx of [120, 151, 163.5, 200, 233.3]) {
      room = boxPx - tailPx; // the head takes what the pinned tail leaves
      const { container, unmount } = render(<MidTruncate text={ident} tail={TAIL} />);
      act(flushFrames);
      const head = container.querySelector<HTMLElement>(".octo-midtrunc-head")!;
      expect(container.querySelector(".octo-midtrunc")).toHaveAttribute("data-elided");
      // The head holds its kept glyphs, then its own `…` (and the slack).
      const glyphsPx = parseFloat(head.style.maxWidth) - ELL - 0.5;
      // Whole glyphs only, so the head's last glyph is never clipped…
      expect(glyphsPx % GLYPH).toBe(0);
      // …and with the `…` after them, everything fits.
      expect(glyphsPx + ELL + tailPx).toBeLessThanOrEqual(boxPx);
      // As much head as fits: one more glyph would overflow.
      expect(glyphsPx + GLYPH + ELL + tailPx).toBeGreaterThan(boxPx);
      unmount();
    }
  });

  it("shows no ellipsis when nothing had to be cut", () => {
    const tailText = " (octopush-web)";
    const raw = `release candidate for${tailText}`;
    const headLen = raw.length - tailText.length; // the seam space starts the tail
    for (const r of [headLen * GLYPH, headLen * GLYPH + 3]) {
      room = r; // the whole head fits, exactly or with room to spare
      const { container, unmount } = render(<MidTruncate text={raw} tail={15} />);
      act(flushFrames);
      const box = container.querySelector(".octo-midtrunc")!;
      expect(box).not.toHaveAttribute("data-elided");
      expect(container.querySelector<HTMLElement>(".octo-midtrunc-head")!.style.maxWidth).toBe("");
      // The seam space is untouched: a plain space, at the start of the tail.
      expect(container.querySelector(".octo-midtrunc-tail")!.textContent).toBe(tailText);
      unmount();
    }
  });

  it("copies and names as the original string exactly — plain spaces, elided or not", () => {
    // The tail boundary lands right after a space, so the seam holds one.
    const raw = "Production deploy (octopush-web)";
    for (const r of [400, 40]) {
      room = r;
      const { container, unmount } = render(
        <button type="button">
          <MidTruncate text={raw} tail={13} />
        </button>,
      );
      act(flushFrames);
      expect(container.querySelector(".octo-midtrunc")!.hasAttribute("data-elided")).toBe(r === 40);
      expect(screen.getByRole("button", { name: raw })).toBeInTheDocument();
      expect(readable(container)).toBe(raw);
      expect(container.textContent).not.toMatch(/\u00a0/);
      unmount();
    }
  });

  it("shares one frame across every instance", () => {
    room = 70;
    const { container } = render(
      <div style={ROW}>
        {[1, 2, 3].map((n) => (
          <div key={n} style={{ display: "flex", flexGrow: 1 }}>
            <MidTruncate text={`${text}-${n}`} tail={14} />
          </div>
        ))}
      </div>,
    );
    expect(frames).toHaveLength(1);
    act(flushFrames);
    expect(container.querySelectorAll(".octo-midtrunc[data-elided]")).toHaveLength(3);
  });

  it("keeps the accessible name the clean full string, elided or not", () => {
    room = 70;
    const { container } = render(
      <button type="button">
        <MidTruncate text={text} tail={14} />
      </button>,
    );
    expect(screen.getByRole("button", { name: text })).toBeInTheDocument();
    act(flushFrames);
    expect(container.querySelector(".octo-midtrunc")).toHaveAttribute("data-elided");
    // The `…` ruler is a real glyph, hidden from assistive tech.
    const ell = container.querySelector(".octo-midtrunc-ell")!;
    expect(ell).toHaveAttribute("aria-hidden", "true");
    expect(ell.textContent).toBe("…");
    expect(screen.getByRole("button", { name: text })).toBeInTheDocument();
  });

  it("keeps the CSS ellipsis for right-to-left text", () => {
    room = 70;
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const cs = real(el, pseudo);
      return (el as Element).classList?.contains("octo-midtrunc")
        ? ({ ...cs, display: cs.display, direction: "rtl" } as CSSStyleDeclaration)
        : cs;
    });
    const { container } = render(<MidTruncate text={text} tail={14} />);
    act(flushFrames);
    expect(container.querySelector(".octo-midtrunc")).not.toHaveAttribute("data-elided");
    expect(container.querySelector<HTMLElement>(".octo-midtrunc-head")!.style.maxWidth).toBe("");
  });

  it("renders line breaks and tabs as a space and keeps the seam's spaces", () => {
    expect(flatten("a\nb\tc\r\nd")).toBe("a b c d");
    const raw = "fix: the\tseam\nhandling (octopush-web)";
    const { container } = render(<MidTruncate text={raw} tail={15} />);
    expect(readable(container)).toBe(flatten(raw));
    expect(container.textContent).not.toMatch(/[\n\t]/);
    // A space at the seam would collapse at the head's edge under `nowrap`, so
    // it starts the tail, which is `white-space: pre`. Still a plain space.
    expect(container.querySelector(".octo-midtrunc-tail")!.textContent).toBe(" (octopush-web)");
    const { container: c2 } = render(<MidTruncate text={raw} tail={14} />);
    expect(c2.querySelector(".octo-midtrunc-head")!.textContent).toBe("fix: the seam handling");
    expect(c2.querySelector(".octo-midtrunc-tail")!.textContent).toBe(" (octopush-web)");
  });

  it("re-seats when the lead or className changes", () => {
    const { rerender } = render(<MidTruncate text={text} tail={14} className="a" />);
    act(flushFrames);
    rerender(<MidTruncate text={text} tail={14} className="b" />);
    expect(frames).toHaveLength(1);
  });
});

describe("MidTruncate — follow-ups (#833)", () => {
  let frames: FrameRequestCallback[] = [];
  const flushFrames = () => {
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(0));
  };
  const GLYPH = 7;
  let room = 0;
  const realRangeRect = Range.prototype.getBoundingClientRect;
  // `data-measuring` on the box at each Range read of the head's text.
  let measuringAtRead: boolean[] = [];

  beforeEach(() => {
    frames = [];
    measuringAtRead = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.classList.contains("octo-midtrunc-head") ? room : 0;
      return { left: 0, right: width, top: 0, bottom: 0, width, height: 0 } as DOMRect;
    });
    Range.prototype.getBoundingClientRect = function (this: Range) {
      const parent = this.startContainer.parentElement;
      if (parent?.classList.contains("octo-midtrunc-head")) {
        measuringAtRead.push(parent.parentElement!.hasAttribute("data-measuring"));
      }
      const w = (this.endOffset - this.startOffset) * GLYPH;
      return { left: 0, right: w, top: 0, bottom: 0, width: w, height: 0 } as DOMRect;
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Range.prototype.getBoundingClientRect = realRangeRect;
  });

  const text = "Production deploy (octopush-web)-12345";

  it("measures with the head held at clip, and clears the hold after the cut", () => {
    for (const r of [70, 2000]) {
      room = r; // cut, then nothing to cut
      const { container, unmount } = render(<MidTruncate text={text} tail={14} />);
      act(flushFrames);
      const box = container.querySelector(".octo-midtrunc")!;
      expect(measuringAtRead.length).toBeGreaterThan(0);
      expect(measuringAtRead.every(Boolean)).toBe(true);
      expect(box).not.toHaveAttribute("data-measuring");
      expect(box.hasAttribute("data-elided")).toBe(r === 70);
      measuringAtRead = [];
      unmount();
    }
  });

  it("holds the head at clip during a synchronous seatEllipsis too", () => {
    room = 70;
    const { container } = render(<MidTruncate text={text} tail={14} />);
    const box = container.querySelector<HTMLElement>(".octo-midtrunc")!;
    const head = container.querySelector<HTMLElement>(".octo-midtrunc-head")!;
    measuringAtRead = [];
    seatEllipsis(box, head);
    expect(measuringAtRead.length).toBeGreaterThan(0);
    expect(measuringAtRead.every(Boolean)).toBe(true);
    expect(box).not.toHaveAttribute("data-measuring");
    expect(box).toHaveAttribute("data-elided");
  });

  it("flattens form feeds, vertical tabs and the Unicode line and paragraph separators", () => {
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    expect(flatten(`a\fb\vc${LS}d${PS}e`)).toBe("a b c d e");
    const raw = `fix: the${LS}seam${PS}handling (octopush-web)`;
    const { container } = render(<MidTruncate text={raw} tail={15} />);
    expect(container.textContent).not.toMatch(/[\f\v\p{Zl}\p{Zp}]/u);
    expect(container.querySelector(".octo-midtrunc-head")!.textContent).toBe("fix: the seam handling");
  });

  it("keeps tracking across renders with a new inline lead element", () => {
    const { rerender } = render(<MidTruncate text={text} tail={14} lead={<svg />} />);
    act(flushFrames);
    rerender(<MidTruncate text={text} tail={14} lead={<svg />} />);
    expect(frames).toHaveLength(0);
    // Adding or dropping the lead still re-seats: it changes the box.
    rerender(<MidTruncate text={text} tail={14} />);
    expect(frames).toHaveLength(1);
  });
});

/** The real stylesheet, comments stripped. Vitest blanks CSS imports, so read
 *  the file (Vitest runs from the repo root); the app ships no @types/node. */
async function stylesCss(): Promise<string> {
  // @ts-expect-error node:fs is untyped in this project
  const fs = await import("node:fs");
  return (fs.readFileSync("src/styles.css", "utf8") as string).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("MidTruncate — a cut head keeps its own ellipsis (#864)", () => {
  let frames: FrameRequestCallback[] = [];
  const flushFrames = () => {
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(0));
  };
  const GLYPH = 7;
  const ELL = 9;
  let room = 0;
  const realRangeRect = Range.prototype.getBoundingClientRect;
  const text865 = "Production deploy (octopush-api)-1";

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.classList.contains("octo-midtrunc-head") ? room : 0;
      return { left: 0, right: width, top: 0, bottom: 0, width, height: 0 } as DOMRect;
    });
    Range.prototype.getBoundingClientRect = function (this: Range) {
      const inEll = this.startContainer.parentElement?.classList.contains("octo-midtrunc-ell");
      const w = (this.endOffset - this.startOffset) * (inEll ? ELL : GLYPH);
      return { left: 0, right: w, top: 0, bottom: 0, width: w, height: 0 } as DOMRect;
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Range.prototype.getBoundingClientRect = realRangeRect;
  });

  it("holds the head at clip only while measuring, never once it is cut", async () => {
    const css = await stylesCss();
    const head = /([^{}]*\.octo-midtrunc-head[^{]*)\{([^}]*)\}/g;
    const clips = Array.from(css.matchAll(head))
      .filter((m) => /text-overflow\s*:\s*clip/.test(m[2]))
      .map((m) => m[1].trim());
    expect(clips).toEqual([".octo-midtrunc[data-measuring] .octo-midtrunc-head"]);
    // The base head rule clips its overflow WITH an ellipsis.
    expect(css).toMatch(/\.octo-midtrunc-head\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/);
  });

  it("never shows the `…` ruler: the head's ellipsis is the only one drawn", async () => {
    const css = await stylesCss();
    const rules = Array.from(css.matchAll(/([^{}]*\.octo-midtrunc-ell[^{]*)\{([^}]*)\}/g));
    expect(rules.map((m) => m[1].trim())).toEqual([".octo-midtrunc-ell"]);
    expect(rules[0][2]).toMatch(/width:\s*0;/);
    expect(rules[0][2]).toMatch(/visibility:\s*hidden;/);
    expect(css).not.toMatch(/\[data-elided\]/);
  });

  it("never strands a head at clip when one box in the pass can't be measured (#865)", () => {
    room = 70;
    const broken = "Ü/ñ émojis 🐙 and CJK 長い名前のパイプライン-5";
    const rangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range) {
      if (this.startContainer.textContent?.startsWith("Ü/ñ")) throw new Error("no layout");
      return rangeRect.call(this);
    };
    const names = ["Production deploy (octopush-api)-1", broken, "New Model Rollout with staged canaries and rollback-3"];
    const { container } = render(
      <div style={{ display: "flex" }}>
        {names.map((n) => (
          <div key={n} style={{ display: "flex", flexGrow: 1 }}>
            <MidTruncate text={n} tail={14} />
          </div>
        ))}
      </div>,
    );
    expect(frames).toHaveLength(1); // one shared pass for all three
    act(flushFrames);
    const boxes = [...container.querySelectorAll(".octo-midtrunc")];
    expect(boxes).toHaveLength(3);
    // The hold is released everywhere, so every head is back on its ellipsis…
    for (const box of boxes) expect(box).not.toHaveAttribute("data-measuring");
    // …the boxes measured around the broken one are still cut…
    expect(boxes.map((b) => b.hasAttribute("data-elided"))).toEqual([true, false, true]);
    // …and the broken one keeps the plain CSS ellipsis, uncut by hand.
    expect(boxes[1].querySelector<HTMLElement>(".octo-midtrunc-head")!.style.maxWidth).toBe("");
  });

  it("releases the hold in a synchronous seatEllipsis that can't measure", () => {
    room = 70;
    const { container } = render(<MidTruncate text={text865} tail={14} />);
    act(flushFrames);
    const box = container.querySelector<HTMLElement>(".octo-midtrunc")!;
    const head = container.querySelector<HTMLElement>(".octo-midtrunc-head")!;
    Range.prototype.getBoundingClientRect = () => {
      throw new Error("no layout");
    };
    seatEllipsis(box, head);
    expect(box).not.toHaveAttribute("data-measuring");
    expect(box).not.toHaveAttribute("data-elided");
    expect(head.style.maxWidth).toBe("");
  });

  it("sizes the cut head to its kept glyphs plus its own `…`", () => {
    // The top bar's long project name, in a box the head can't fill.
    const name = "octopush-enterprise-monorepo-with-a-very-long-name";
    room = 80;
    const { container } = render(<MidTruncate text={name} tail={12} />);
    act(flushFrames);
    const box = container.querySelector(".octo-midtrunc")!;
    const head = container.querySelector<HTMLElement>(".octo-midtrunc-head")!;
    expect(box).toHaveAttribute("data-elided");
    expect(box).not.toHaveAttribute("data-measuring");
    // 80px less 9 for the `…`: 10 glyphs (70px) fit; the head holds them,
    // then the engine's `…`, so it ends exactly where the tail starts.
    expect(head.style.maxWidth).toBe(`${10 * GLYPH + ELL + 0.5}px`);
    expect(readable(container)).toBe(name);
  });
});
