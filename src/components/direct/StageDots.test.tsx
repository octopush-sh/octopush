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
    expect(dots[1].className).toContain("bg-octo-verdigris");
    expect(dots[2].className).toContain("bg-octo-warning");
    expect(dots[3].className).toContain("bg-octo-rouge");
    expect(dots[4].className).toContain("bg-octo-hairline");
    expect(dots[4].className).toContain("ring-1");
  });

  it("titles each dot with its stage word when a title is given", () => {
    const { container } = render(<StageDots stages={[{ status: "running", title: "implementer" }]} />);
    expect(container.querySelector("span[data-dot]")!.getAttribute("title")).toBe("implementer — running");
  });

  it("renders the hairline pending fallback for an unknown status", () => {
    const { container } = render(<StageDots stages={[{ status: "mystery" }]} />);
    expect(container.querySelector("span[data-dot]")!.className).toContain("bg-octo-hairline");
  });

  it("renders awaiting_checkpoint in brass", () => {
    const { container } = render(<StageDots stages={[{ status: "awaiting_checkpoint" }]} />);
    expect(container.querySelector("span[data-dot]")!.className).toContain("bg-octo-brass");
  });

  it("keeps brass off running dots — only the gate is brass", () => {
    const { container } = render(
      <StageDots
        stages={[
          { status: "done" },
          { status: "running" },
          { status: "running", checkpoint: true },
          { status: "awaiting_checkpoint" },
        ]}
      />,
    );
    const dots = container.querySelectorAll("span[data-dot]");
    expect(dots[1].className).not.toContain("bg-octo-brass");
    // A running dot reads apart from done through its verdigris halo.
    expect(dots[0].className).not.toContain("ring-1");
    expect(dots[1].className).toContain("ring-[var(--verdigris-strong)]");
    // A gated stage keeps its gate ring while it runs.
    expect(dots[2].className).toContain("ring-[var(--brass-dim)]");
    expect(dots[2].className).not.toContain("ring-[var(--verdigris-strong)]");
    expect(container.querySelectorAll("span[data-dot].bg-octo-brass")).toHaveLength(1);
  });

  it("shape tone renders neutral sage dots regardless of status, keeping gate rings", () => {
    const { container } = render(
      <StageDots
        tone="shape"
        stages={[{ status: "pending" }, { status: "pending", checkpoint: true }]}
      />,
    );
    const dots = container.querySelectorAll("span[data-dot]");
    expect(dots[0].className).toContain("bg-octo-sage");
    expect(dots[1].className).toContain("bg-octo-sage");
    expect(dots[1].className).toContain("ring-1");
    expect(dots[1].getAttribute("title")).toBe("Pauses for your approval");
  });
});
