import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("./ModelPicker", () => ({
  ModelPicker: ({ activeModel }: any) => <div data-testid="model">{activeModel}</div>,
}));
const saveMock = vi.fn().mockResolvedValue("saved-id");
const removeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../stores/pipelineStore", () => ({
  usePipelineStore: (sel: any) => sel({ save: saveMock, remove: removeMock }),
}));

const { PipelineBuilder } = await import("./PipelineBuilder");

const stage = (over: Record<string, unknown>) => ({
  id: "s", pipelineId: "p1", position: 0, role: "plan", agentModel: "claude-haiku-4-5",
  substrate: "api", checkpoint: false,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, ...over,
});
const builtin = {
  pipeline: { id: "p1", name: "Feature Factory", description: "d", isBuiltin: true, createdAt: "t" },
  stages: [
    stage({ id: "s0", position: 0, role: "implement" }),
    stage({ id: "s1", position: 1, role: "code_review", loopTargetPosition: 0, loopMaxIterations: 2, loopMode: "gated" }),
  ],
} as any;
const custom = {
  pipeline: { id: "p2", name: "Mine", description: "d", isBuiltin: false, createdAt: "t" },
  stages: [stage({ id: "s0", position: 0, role: "plan" })],
} as any;
// A review stage with NO loop target — the linear case for the S1 stability test.
const linearReview = {
  pipeline: { id: "p4", name: "Linear", description: "d", isBuiltin: false, createdAt: "t" },
  stages: [
    stage({ id: "s0", position: 0, role: "implement" }),
    stage({ id: "s1", position: 1, role: "code_review" }),
  ],
} as any;

/** The loop-cleared notice now lives in fixed Reveal slots that stay mounted
 *  (hidden via aria-hidden when collapsed), so assert on *visible* notices only.
 *  Exact-text match so ancestor containers don't match. */
const visibleLoopNotices = () =>
  screen
    .getAllByText("Loop target removed — review is linear again.")
    .filter((el) => !el.closest('[aria-hidden="true"]'));

describe("PipelineBuilder", () => {
  beforeEach(() => { saveMock.mockClear(); removeMock.mockClear(); });

  it("a builtin opens with the fork label and a pre-filled copy name", () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("Feature Factory (custom)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save as my copy/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete$/ })).not.toBeInTheDocument(); // no delete on builtins
  });

  it("a custom opens with its own name, Save label, and Delete", () => {
    render(<PipelineBuilder pipeline={custom} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("Mine")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save pipeline/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete$/ })).toBeInTheDocument();
  });

  it("compose-new starts with one default stage and Save label", () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Save pipeline/ })).toBeInTheDocument();
    expect(screen.getAllByTestId("model").length).toBe(1); // one default stage
  });

  it("moving the loop target below its review clears the loop with a notice", () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    // implement (0) ↓ → becomes index 1, after the review → loop must clear
    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
    expect(visibleLoopNotices().length).toBe(1);
  });

  it("save serializes loop targets to positions and calls store.save", async () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Save as my copy/ }));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const draft = saveMock.mock.calls[0][0];
    expect(draft.pipelineId).toBe("p1"); // backend decides the fork
    expect(draft.name).toBe("Feature Factory (custom)");
    expect(draft.stages[1].loopTargetPosition).toBe(0);
    expect(draft.stages[1].loopMode).toBe("gated");
  });

  it("add stage appends a card", () => {
    render(<PipelineBuilder pipeline={custom} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Add another stage/ }));
    expect(screen.getAllByTestId("model").length).toBe(2);
  });

  it("a stored forward loop target loads normalized (cleared) and saves a valid draft", async () => {
    const corrupt = {
      pipeline: { id: "p3", name: "Corrupt", description: "d", isBuiltin: false, createdAt: "t" },
      stages: [
        stage({ id: "s0", position: 0, role: "code_review", loopTargetPosition: 1, loopMaxIterations: 2, loopMode: "gated" }),
        stage({ id: "s1", position: 1, role: "implement" }),
      ],
    } as any;
    render(<PipelineBuilder pipeline={corrupt} onClose={vi.fn()} />);
    expect(visibleLoopNotices().length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Save pipeline/ }));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls[0][0].stages[0].loopTargetPosition).toBe(null); // cleared, valid
  });

  it("changing a review role to a non-review role clears the loop with a visible notice", () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    // open the second stage's role Listbox, pick "Implement"
    fireEvent.click(screen.getAllByRole("button", { name: "Stage role" })[1]);
    fireEvent.click(screen.getByRole("option", { name: /^Implement/ }));
    expect(visibleLoopNotices().length).toBe(1);
  });

  it("picking '— linear —' in the loop target clears the loop on save", async () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Loop target" }));
    fireEvent.click(screen.getByRole("option", { name: "— linear —" }));
    fireEvent.click(screen.getByRole("button", { name: /Save as my copy/ }));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const draft = saveMock.mock.calls[0][0];
    expect(draft.stages[1].loopTargetPosition).toBe(null);
    expect(draft.stages[1].loopMode).toBe(null);
  });

  it("renders the live preview rail with loop-back annotation", () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    // the builtin's code_review loops back to stage I with ×2
    expect(screen.getByText("⟜ back to I · ×2")).toBeInTheDocument();
  });

  it("keeps loop sub-controls mounted but inert when linear (S1)", () => {
    render(<PipelineBuilder pipeline={linearReview} onClose={vi.fn()} />);
    // Steppers stay mounted (hidden:true — the dim wrapper is aria-hidden while linear);
    // scope to the one inside the OPEN review loop panel (Reveal aria-hidden="false").
    const incs = screen.getAllByRole("button", { name: "Increase", hidden: true });
    const inOpenPanel = incs.filter((b) => b.closest('[aria-hidden="false"]'));
    expect(inOpenPanel.length).toBe(1);
    const wrapper = inOpenPanel[0].closest(".pointer-events-none");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("opacity-30");
  });

  it("removing a stage fades it out, then deletes it after the exit timer", () => {
    vi.useFakeTimers();
    try {
      render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
      fireEvent.click(screen.getAllByRole("button", { name: "Remove stage" })[1]);
      expect(screen.getAllByTestId("model").length).toBe(2); // still mounted during the exit fade
      act(() => { vi.advanceTimersByTime(130); });
      expect(screen.getAllByTestId("model").length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("two-step delete still works", async () => {
    const onClose = vi.fn();
    render(<PipelineBuilder pipeline={custom} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm delete/ }));
    await vi.waitFor(() => expect(removeMock).toHaveBeenCalledWith("p2"));
    expect(onClose).toHaveBeenCalled();
  });
});
