import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PipelineTicket } from "./PipelineTicket";

function mk(isBuiltin: boolean, name = "Feature Factory") {
  return {
    pipeline: { id: "p", name, description: "d", isBuiltin, createdAt: "t" },
    stages: [
      { id: "s0", position: 0, checkpoint: false },
      { id: "s1", position: 1, checkpoint: true },
    ],
  } as any;
}

describe("PipelineTicket", () => {
  it("shows the Octopush '&' seal only for builtins", () => {
    const { rerender } = render(
      <PipelineTicket pipeline={mk(true)} selected={false} onSelect={vi.fn()} onEdit={vi.fn()} />,
    );
    expect(screen.getByTitle("An Octopush original")).toBeInTheDocument();
    rerender(<PipelineTicket pipeline={mk(false)} selected={false} onSelect={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.queryByTitle("An Octopush original")).not.toBeInTheDocument();
  });

  it("renders the name and a readable stage count", () => {
    render(<PipelineTicket pipeline={mk(true)} selected={false} onSelect={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("Feature Factory")).toBeInTheDocument();
    expect(screen.getByText(/2 stages/)).toBeInTheDocument();
  });

  it("fires onSelect when picked and onEdit from the edit affordance", () => {
    const onSelect = vi.fn();
    const onEdit = vi.fn();
    render(<PipelineTicket pipeline={mk(true)} selected={false} onSelect={onSelect} onEdit={onEdit} />);
    fireEvent.click(screen.getByText("Feature Factory")); // bubbles to the select button
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit Feature Factory" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  // #312: in some WebKit builds a flex <button> doesn't hand its width to its
  // rows, so `truncate` had nothing to clip against and long names ran over
  // the next ticket. Every row must be `w-full min-w-0` and the card must clip.
  it("clips a long name against the card in every engine", () => {
    const long = "Production deploy (octopush-api) with a very long tail";
    render(<PipelineTicket pipeline={mk(true, long)} selected={false} onSelect={vi.fn()} onEdit={vi.fn()} />);
    const name = screen.getByText(long);
    expect(name).toHaveClass("min-w-0", "flex-1", "truncate");
    const card = name.closest("button")!;
    expect(card).toHaveClass("w-[184px]", "overflow-hidden");
    const rows = Array.from(card.children);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row).toHaveClass("w-full", "min-w-0");
    // The focus ring is the card's own box-shadow, so the clip can't hide it.
    expect(card).toHaveClass("focus-visible:ring-1");
  });
});
