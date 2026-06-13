import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PipelineTicket } from "./PipelineTicket";

function mk(isBuiltin: boolean) {
  return {
    pipeline: { id: "p", name: "Feature Factory", description: "d", isBuiltin, createdAt: "t" },
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
});
