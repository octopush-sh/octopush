import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Run, RunStatus } from "../../lib/ipc";
import { RunCard } from "./RunCard";

const mkRun = (status: RunStatus, over: Partial<Run> = {}): Run => ({
  id: "r1",
  workspaceId: "w1",
  pipelineId: "p1",
  task: "Refactor the auth flow",
  status,
  costUsd: 0.1,
  baselineUsd: 0,
  referenceModel: null,
  linkedIssueKey: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  budgetUsd: null,
  ...over,
});

describe("RunCard", () => {
  it("renders a completed run that saved, with status word, cost, and savings", () => {
    const run = mkRun("completed", { costUsd: 0.1, baselineUsd: 0.5 }); // saved 0.40 = 80%
    render(<RunCard run={run} pipelineName="Bugfix" selected={false} onSelect={() => {}} />);

    expect(screen.getByText("Refactor the auth flow")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    const card = screen.getByText("Refactor the auth flow").closest("button")!;
    expect(card.textContent).toContain("$0.10");
    expect(card.textContent).toContain("saved $0.40");
    expect(card.textContent).toContain("(80%)");
  });

  it("omits the savings line when baselineUsd is 0", () => {
    const run = mkRun("completed", { costUsd: 0.1, baselineUsd: 0 });
    render(<RunCard run={run} pipelineName="Bugfix" selected={false} onSelect={() => {}} />);
    const card = screen.getByText("Refactor the auth flow").closest("button")!;
    expect(card.textContent).not.toContain("saved");
    expect(card.textContent).toContain("$0.10");
  });

  it("shows a 'decide' hint for a paused run", () => {
    const run = mkRun("paused");
    render(<RunCard run={run} pipelineName={null} selected={false} onSelect={() => {}} />);
    expect(screen.getByText("decide")).toBeInTheDocument();
  });

  it("falls back to (untitled run) for an empty task", () => {
    const run = mkRun("completed", { task: "" });
    render(<RunCard run={run} pipelineName={null} selected={false} onSelect={() => {}} />);
    expect(screen.getByText("(untitled run)")).toBeInTheDocument();
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    const run = mkRun("completed");
    render(<RunCard run={run} pipelineName={null} selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Refactor the auth flow"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
