import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReviewTail, rungsToShed } from "./ReviewTail";
import { modeMetaLabel, reviewTailParts, type ModeMetaInput } from "../lib/modeMeta";

const input: ModeMetaInput = {
  terminalCount: 0,
  tokensUsed: 0,
  tokensLimit: 0,
  changedCount: 2,
  diffStat: { added: 2, removed: 1 },
  runState: "none",
};

describe("rungsToShed", () => {
  // floor "2 files" 52px, rungs "changed" 52px then "· +2 −1" 52px; gaps 8px.
  it("keeps every rung while the whole tail fits", () => {
    expect(rungsToShed(172, 52, [52, 52])).toBe(0);
  });

  it("sheds whole rungs in order instead of squeezing one", () => {
    expect(rungsToShed(171, 52, [52, 52])).toBe(1);
    expect(rungsToShed(112, 52, [52, 52])).toBe(1);
    expect(rungsToShed(111, 52, [52, 52])).toBe(2);
  });

  it("never sheds the floor, even when it doesn't fit", () => {
    expect(rungsToShed(10, 52, [52, 52])).toBe(2);
    expect(rungsToShed(10, 52, [])).toBe(0);
  });
});

describe("ReviewTail", () => {
  const widths = new Map<string, number>();
  const realClient = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
  const realScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth")!;

  function layout(box: number, perText: Record<string, number>) {
    widths.clear();
    for (const [text, w] of Object.entries(perText)) widths.set(text, w);
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        return this.getAttribute("data-tour") === "review-mode-tail" ? box : 0;
      },
    });
    Object.defineProperty(Element.prototype, "scrollWidth", {
      configurable: true,
      get(this: Element) {
        return widths.get(this.textContent ?? "") ?? 0;
      },
    });
  }

  afterEach(() => {
    Object.defineProperty(Element.prototype, "clientWidth", realClient);
    Object.defineProperty(Element.prototype, "scrollWidth", realScroll);
  });

  function renderTail() {
    const parts = reviewTailParts(input.changedCount, input.diffStat)!;
    return render(<ReviewTail parts={parts} label={modeMetaLabel("review", input)!} />);
  }

  const rung = (name: string) =>
    document.querySelector(`[data-rung="${name}"]`) as HTMLElement;

  it("shows every atom, with the full reading in the tooltip", () => {
    renderTail();
    const tail = screen.getByTitle("2 files changed · +2 −1");
    expect(tail).toHaveTextContent("2 files");
    expect(rung("verb")).toHaveTextContent("changed");
    expect(rung("stat")).toHaveTextContent("· +2 −1");
    expect(rung("verb").className).not.toContain("octo-demote-shed");
    expect(rung("stat").className).not.toContain("octo-demote-shed");
  });

  it("makes every sheddable atom a flex:none rung, never a truncating stub", () => {
    renderTail();
    for (const name of ["verb", "stat"]) {
      expect(rung(name).className).toContain("octo-demote");
      expect(rung(name).className).not.toContain("truncate");
    }
  });

  // Regression (visual audit #481): at 1280×800 the 152px track read
  // "2 FILES CHANGED · …" — the fixed prefix survived and the value was cut.
  it("sheds 'changed' first so a narrow track ends on a complete value", () => {
    layout(152, { "2 files": 52, changed: 52, "· +2 −1": 52 });
    renderTail();
    expect(rung("verb").className).toContain("octo-demote-shed");
    expect(rung("stat").className).not.toContain("octo-demote-shed");
  });

  it("sheds the diff stat next, down to the floor", () => {
    layout(90, { "2 files": 52, changed: 52, "· +2 −1": 52 });
    renderTail();
    expect(rung("verb").className).toContain("octo-demote-shed");
    expect(rung("stat").className).toContain("octo-demote-shed");
    expect(screen.getByText("2 files")).toBeVisible();
  });
});
