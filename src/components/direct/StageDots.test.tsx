import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StageDots } from "./StageDots";

describe("StageDots — the universal micro-track", () => {
  it("renders one dot per stage in the status colour family", () => {
    const { container } = render(
      <StageDots
        stages={[
          { status: "done" },
          { status: "running" },
          { status: "failed", error: "rate limit exceeded" }, // transient → amber
          { status: "failed", error: "assertion failed" },    // hard → rouge
          { status: "pending", checkpoint: true },            // gate → ring
        ]}
      />,
    );
    const dots = container.querySelectorAll("span[data-dot]");
    expect(dots).toHaveLength(5);
    expect(dots[0].className).toContain("bg-octo-verdigris");
    expect(dots[1].className).toContain("bg-octo-brass");
    expect(dots[2].className).toContain("bg-octo-warning");
    expect(dots[3].className).toContain("bg-octo-rouge");
    expect(dots[4].className).toContain("bg-octo-hairline");
    expect(dots[4].className).toContain("ring-1");
  });

  it("titles each dot with its stage word when a title is given", () => {
    const { container } = render(<StageDots stages={[{ status: "running", title: "implementer" }]} />);
    expect(container.querySelector("span[data-dot]")!.getAttribute("title")).toBe("implementer — running");
  });
});
