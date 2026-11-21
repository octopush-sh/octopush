import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { LogbookRoom, optionLabelFits } from "./LogbookRoom";
import { MidTruncate } from "./primitives/MidTruncate";
import type { ProjectInfo } from "../lib/types";
import { useEntitlementStore } from "../stores/entitlementStore";

vi.mock("../lib/ipc", () => ({
  ipc: { logbookSummary: vi.fn() },
}));

import { ipc } from "../lib/ipc";
const logbookSummaryMock = vi.mocked(ipc.logbookSummary);

function setPlan(features: string[]) {
  useEntitlementStore.setState({
    entitlement: {
      plan: features.length ? "pro" : "free",
      features,
      directRunsPerMonth: null,
    },
    loaded: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  logbookSummaryMock.mockResolvedValue([]);
});

describe("LogbookRoom", () => {
  it("shows the upsell and never fetches for a free user (the Pro boundary)", () => {
    setPlan([]);
    render(<LogbookRoom open onClose={vi.fn()} project={null} />);
    expect(screen.getByText("Open the full logbook with Pro")).toBeInTheDocument();
    expect(logbookSummaryMock).not.toHaveBeenCalled();
  });

  it("draws the upsell CTA as a ceremonial brass-ghost phrase, not a solid-brass button", () => {
    setPlan([]);
    render(<LogbookRoom open onClose={vi.fn()} project={null} />);
    const cta = screen.getByRole("button", { name: "Open the full logbook with Pro" });
    expect(cta.className).toContain("bg-[var(--brass-ghost)]");
    expect(cta.className).toContain("border-[var(--brass-dim)]");
    expect(cta.className).toContain("font-serif");
    expect(cta.className).not.toMatch(/(^|\s)bg-octo-brass(\s|$)/);
    expect(screen.queryByText("Upgrade to Pro")).not.toBeInTheDocument();
  });

  it("fetches the global scope for a Pro user", async () => {
    setPlan(["logbook.reports"]);
    render(<LogbookRoom open onClose={vi.fn()} project={null} />);
    await waitFor(() => expect(logbookSummaryMock).toHaveBeenCalled());
    const [scope, scopeId] = logbookSummaryMock.mock.calls[0];
    expect(scope).toBe("global");
    expect(scopeId).toBeNull();
    // No upsell for an entitled user.
    expect(screen.queryByText("Open the full logbook with Pro")).not.toBeInTheDocument();
  });

  it("middle-truncates a long project name in the scope switch (E1)", () => {
    setPlan(["logbook.reports"]);
    const name = "octopush-enterprise-monorepo";
    render(
      <LogbookRoom open onClose={vi.fn()} project={{ id: "p1", name } as ProjectInfo} />,
    );
    const option = screen.getByTitle(name);
    expect(option).toHaveClass("flex", "w-[160px]", "min-w-0");
    expect(option).not.toHaveClass("truncate");
    expect(option.querySelector(".octo-midtrunc-tail")).toHaveTextContent("e-monorepo");
    // Short labels keep the plain line.
    expect(screen.getByRole("button", { name: "All missions" })).toHaveClass("truncate");
  });

  it("leaves the long project option on its head's own ellipsis after a shared layout pass (#867)", () => {
    // The audit's stress project name, in the same MidTruncate pass as a rail
    // name the engine can't measure: the throw must not strand the option's
    // head at `text-overflow: clip` (cut with no ellipsis, in WebKit).
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.classList.contains("octo-midtrunc-head") ? 60 : 0;
      return { left: 0, right: width, top: 0, bottom: 0, width, height: 0 } as DOMRect;
    });
    const realRangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range) {
      if (this.startContainer.textContent?.startsWith("Ü/ñ")) throw new Error("no layout");
      const w = (this.endOffset - this.startOffset) * 7.5;
      return { left: 0, right: w, top: 0, bottom: 0, width: w, height: 0 } as DOMRect;
    };
    try {
      setPlan(["logbook.reports"]);
      const name = "octopush-enterprise-monorepo-with-a-very-long-name";
      const { container } = render(
        <>
          <MidTruncate text="Ü/ñ émojis 🐙 and CJK 長い名前のパイプライン-5" tail={14} />
          <LogbookRoom open onClose={vi.fn()} project={{ id: "p1", name } as ProjectInfo} />
        </>,
      );
      expect(frames).toHaveLength(1); // one shared pass for both
      act(() => frames.splice(0).forEach((cb) => cb(0)));
      for (const box of container.querySelectorAll(".octo-midtrunc")) {
        expect(box).not.toHaveAttribute("data-measuring");
      }
      // The option is a definite-width box, so the head has room to elide into…
      const option = screen.getByTitle(name);
      expect(option).toHaveClass("flex", "w-[160px]", "min-w-0");
      const box = option.querySelector(".octo-midtrunc")!;
      // …and its head is the one clipping span, cut to its glyphs plus its own `…`.
      expect(box).toHaveAttribute("data-elided");
      const head = box.querySelector<HTMLElement>(":scope > .octo-midtrunc-head")!;
      expect(head).toHaveTextContent("octopush-enterprise-monorepo-with-a-very");
      expect(head.style.maxWidth).not.toBe("");
      expect(box.querySelector(":scope > .octo-midtrunc-tail")).toHaveTextContent("-long-name");
    } finally {
      Range.prototype.getBoundingClientRect = realRangeRect;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("leaves the project option's head on its own ellipsis after every pass, not held at clip (#871)", () => {
    // Safari's audit found the head (`octopush-enterprise-monorepo-with-a-very`)
    // cut with no ellipsis: the pass's measuring hold outlived it. The head must
    // be the ellipsis class alone, and the hold its inline style, released after
    // the first pass and after a re-cut alike.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.classList.contains("octo-midtrunc-head") ? 60 : 0;
      return { left: 0, right: width, top: 0, bottom: 0, width, height: 0 } as DOMRect;
    });
    const realRangeRect = Range.prototype.getBoundingClientRect;
    const heldAtRead: boolean[] = [];
    Range.prototype.getBoundingClientRect = function (this: Range) {
      const parent = this.startContainer.parentElement;
      if (parent?.classList.contains("octo-midtrunc-head")) heldAtRead.push(parent.style.textOverflow === "clip");
      const w = (this.endOffset - this.startOffset) * 7.5;
      return { left: 0, right: w, top: 0, bottom: 0, width: w, height: 0 } as DOMRect;
    };
    try {
      setPlan(["logbook.reports"]);
      const names = [
        "octopush-enterprise-monorepo-with-a-very-long-name",
        "octopush-enterprise-monorepo-with-a-very-long-name-2",
      ];
      const { container, rerender } = render(
        <LogbookRoom open onClose={vi.fn()} project={{ id: "p1", name: names[0] } as ProjectInfo} />,
      );
      for (const name of names) {
        rerender(<LogbookRoom open onClose={vi.fn()} project={{ id: "p1", name } as ProjectInfo} />);
        act(() => frames.splice(0).forEach((cb) => cb(0)));
        const header = container.querySelector("header")!;
        const heads = header.querySelectorAll<HTMLElement>(".octo-midtrunc-head");
        expect(heads).toHaveLength(1);
        const head = heads[0];
        expect(head.className).toBe("octo-midtrunc-head");
        expect(head.style.textOverflow).toBe("");
        expect(head.style.maxWidth).not.toBe("");
        expect(head.closest(".octo-midtrunc")).toHaveAttribute("data-elided");
        expect(head.closest(".octo-midtrunc")).not.toHaveAttribute("data-measuring");
        // Its option is the definite-width box it elides into.
        expect(screen.getByTitle(name)).toHaveClass("flex", "w-[160px]", "min-w-0");
      }
      // Measured under the hold (WebKit clips Range rects at its own ellipsis).
      expect(heldAtRead.length).toBeGreaterThan(0);
      expect(heldAtRead.every(Boolean)).toBe(true);
    } finally {
      Range.prototype.getBoundingClientRect = realRangeRect;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("marks the active scope and period with a brass-ghost fill and ivory ink, not brass text", () => {
    setPlan(["logbook.reports"]);
    render(
      <LogbookRoom open onClose={vi.fn()} project={{ id: "p1", name: "atlas" } as ProjectInfo} />,
    );
    const active = screen.getAllByRole("button", { pressed: true });
    expect(active.map((b) => b.textContent)).toEqual(["atlas", "30 days"]);
    for (const b of active) {
      expect(b).toHaveClass("bg-[var(--brass-ghost)]", "text-octo-ivory");
      expect(b).not.toHaveClass("text-octo-brass");
    }
    const idle = screen.getByRole("button", { name: "All missions" });
    expect(idle).toHaveClass("text-octo-mute");
    expect(idle).not.toHaveClass("bg-[var(--brass-ghost)]");
  });

  it("sets the header spent total in ivory so only the table's spent cells are brass", async () => {
    setPlan(["logbook.reports"]);
    logbookSummaryMock.mockResolvedValue([
      {
        missionId: "m1",
        title: "Refund webhooks",
        intent: "build",
        hoursSecs: 3600,
        costUsd: 12.5,
        savingsUsd: 0,
        runsCount: 1,
        messagesCount: 2,
      } as never,
    ]);
    render(<LogbookRoom open onClose={vi.fn()} project={null} />);
    const total = await screen.findByTitle("Total spend");
    expect(total).toHaveClass("text-octo-ivory");
    expect(total).not.toHaveClass("text-octo-brass");
  });

  it("fits an option label by its mono character count", () => {
    expect(optionLabelFits("x".repeat(19))).toBe(true);
    expect(optionLabelFits("x".repeat(20))).toBe(false);
  });
});
