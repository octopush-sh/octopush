import { describe, it, expect } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { railEdgeFade, useRailEdges } from "./RunFlowNav";

function Probe({ scrollLeft }: { scrollLeft: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const edges = useRailEdges(ref, 3);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (!el) return;
        Object.defineProperty(el, "scrollWidth", { configurable: true, value: 900 });
        Object.defineProperty(el, "clientWidth", { configurable: true, value: 600 });
        // jsdom doesn't scroll: hold the offset in a plain writable property.
        if (!Object.prototype.hasOwnProperty.call(el, "scrollLeft")) {
          Object.defineProperty(el, "scrollLeft", { configurable: true, writable: true, value: scrollLeft });
        }
      }}
      data-testid="rail"
      data-edges={JSON.stringify(edges)}
    />
  );
}

const edgesOf = () => JSON.parse(screen.getByTestId("rail").getAttribute("data-edges")!);

describe("useRailEdges (#1053)", () => {
  it("reads a rail scrolled past its first stage as hiding its start", () => {
    render(<Probe scrollLeft={120} />);
    expect(edgesOf()).toEqual({ overflowing: true, atStart: false, atEnd: false });
  });

  it("follows the rail as it scrolls to its end", () => {
    render(<Probe scrollLeft={0} />);
    expect(edgesOf()).toEqual({ overflowing: true, atStart: true, atEnd: false });
    const rail = screen.getByTestId("rail");
    act(() => {
      rail.scrollLeft = 300;
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(edgesOf()).toEqual({ overflowing: true, atStart: false, atEnd: true });
  });
});

describe("railEdgeFade (#1053)", () => {
  it("fades nothing when every stage fits", () => {
    expect(railEdgeFade({ overflowing: false, atStart: true, atEnd: true })).toBe("");
  });

  it("fades only the edge that hides stages", () => {
    expect(railEdgeFade({ overflowing: true, atStart: false, atEnd: true })).toContain("to_right,transparent,black_32px)");
    expect(railEdgeFade({ overflowing: true, atStart: true, atEnd: false })).toContain("to_left,transparent,black_32px)");
    expect(railEdgeFade({ overflowing: true, atStart: false, atEnd: false })).toContain(
      "transparent,black_32px,black_calc(100%_-_32px),transparent",
    );
  });
});
