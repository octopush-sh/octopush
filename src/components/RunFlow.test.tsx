import { describe, it, expect, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";

const live: { liveByStage: Record<string, unknown[]> } = vi.hoisted(() => ({ liveByStage: {} }));
vi.mock("../stores/runsStore", () => ({
  useRunsStore: (sel: any) => sel(live),
}));
vi.mock("../stores/rolesStore", () => ({
  useRolesStore: { getState: () => ({ roles: [] }) },
}));
vi.mock("../hooks/useElapsed", () => ({ useElapsed: () => "00:00" }));
vi.mock("./RunFlowNav", () => ({ RunFlowNav: () => null }));

const { RunFlow } = await import("./RunFlow");

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

const mk = (over: Record<string, unknown>) =>
  ({
    id: "x", runId: "r", position: 0, role: "implement", agentModel: "sonnet",
    substrate: "api", checkpoint: false, status: "pending", inputTokens: 0,
    outputTokens: 0, costUsd: 0, artifact: null, feedback: null, error: null,
    startedAt: null, finishedAt: null, loopTargetPosition: null,
    loopMaxIterations: 0, loopMode: null, loopIterations: 0, maxIterations: 25,
    diffSnapshot: null, ...over,
  }) as any;

const stages = [
  mk({ id: "a", position: 0, status: "done", costUsd: 0.01 }),
  mk({ id: "b", position: 1, status: "running", startedAt: 1 }),
  mk({ id: "c", position: 2, status: "pending", checkpoint: true }),
];

describe("RunFlow — depth of field & the single beacon", () => {
  it("pulses exactly one element: the beacon stage", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId="b" onSelectStage={() => {}} />,
    );
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(1);
  });

  it("never pulses without a beacon, even while running", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(0);
  });

  it("recedes non-subject cards to a dimmed essence", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId="b" onSelectStage={() => {}} />,
    );
    // done + pending recede; the running subject keeps full ink
    expect(container.querySelectorAll(".opacity-\\[0\\.38\\]")).toHaveLength(2);
  });

  it("renders no connector for a single-stage run", () => {
    const { container } = render(
      <RunFlow stages={[mk({ id: "solo" })]} selectedStageId={null} beaconStageId={null} onSelectStage={() => {}} />,
    );
    // Connectors are the only aria-hidden spans in RunFlow.
    expect(container.querySelectorAll("span[aria-hidden]")).toHaveLength(0);
  });

  it("draws connectors as lines — no arrows, no romans", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId={null} beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(container.textContent).not.toContain("⟶");
    expect(container.textContent).not.toMatch(/\b(II|III|IV|V|VI)\b/);
    // the gate mark lives on the gated card, not the connector
    expect(container.textContent).toContain("⟜");
  });

  it("shows the escalated badge on a stage that escalated (and only then)", () => {
    const escalated = mk({
      id: "e", position: 0, status: "failed",
      escalated: true, escalateModel: "claude-opus-4-6",
    });
    const plain = mk({ id: "p", position: 1, status: "running", startedAt: 1 });
    const { container } = render(
      <RunFlow stages={[escalated, plain]} selectedStageId="e" beaconStageId={null} onSelectStage={() => {}} />,
    );
    // Brass ↑ escalated badge names the strong model (short form).
    expect(container.textContent).toContain("↑ opus-4-6");
    // A non-escalated stage carries no badge.
    expect(container.querySelector('[title*="Escalated"]')).toBeTruthy();
    const titles = Array.from(container.querySelectorAll('[title*="Escalated"]'));
    expect(titles).toHaveLength(1);
  });

  it("shows the effort pill whichever CLI the stage ran on", () => {
    const pill = '[title="Reasoning effort for this stage"]';
    const base = { id: "e", position: 0, status: "running", startedAt: 1, substrate: "cli", effort: "high" };
    const onCodex = mk({ ...base, agentModel: "claude-sonnet-5-5", escalated: true, escalateModel: "gpt-5.5" });
    const { container, unmount } = render(
      <RunFlow stages={[onCodex]} selectedStageId="e" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(container.querySelector(pill)?.textContent).toBe("high");
    unmount();
    // Not escalated: the base model (Claude Code) decides, whatever the policy says.
    const notYet = mk({ ...base, agentModel: "claude-sonnet-5-5", escalated: false, escalateModel: "gpt-5.5" });
    const again = render(
      <RunFlow stages={[notYet]} selectedStageId="e" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(again.container.querySelector(pill)?.textContent).toBe("high");
  });

  it("shows no effort pill on a Codex stage that ran without one", () => {
    // Codex stages that ran before they took an effort had it cleared by the
    // backend migration (#613), so they read as Codex's default — no pill.
    const pill = '[title="Reasoning effort for this stage"]';
    const base = { id: "c", position: 0, status: "done", startedAt: 1, substrate: "cli", agentModel: "gpt-5.5" };
    const before = render(
      <RunFlow stages={[mk({ ...base, effort: null })]} selectedStageId="c" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(before.container.querySelector(pill)).toBeNull();
    before.unmount();
    const after = render(
      <RunFlow stages={[mk({ ...base, effort: "xhigh" })]} selectedStageId="c" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(after.container.querySelector(pill)?.textContent).toBe("xhigh");
  });

  it("says a running stage waits for its first tool call in the card's live line", () => {
    const { container, unmount } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId={null} onSelectStage={() => {}} />,
    );
    const slot = container.querySelector('[data-tour="direct-stage-waiting"]');
    expect(slot?.textContent).toBe("waiting for first tool call");
    expect(slot).toHaveClass("h-4", "text-octo-mute");
    unmount();
    // Once activity lands, the same slot carries it instead.
    live.liveByStage = { b: [{ kind: "tool", tool: "Read", hint: "src/a.ts" }] };
    try {
      const again = render(
        <RunFlow stages={stages} selectedStageId="b" beaconStageId={null} onSelectStage={() => {}} />,
      );
      expect(again.container.querySelector('[data-tour="direct-stage-waiting"]')).toBeNull();
      expect(again.container.textContent).toContain("Read src/a.ts");
      expect(again.container.textContent).not.toContain("waiting for first tool call");
    } finally {
      live.liveByStage = {};
    }
  });

  // #312: a flex <button> card must hand its width to its rows in WebKit too,
  // so the truncating rows are `w-full min-w-0` and the card clips.
  it("clips long stage titles and models against the card", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId={null} onSelectStage={() => {}} />,
    );
    const cards = Array.from(container.querySelectorAll("button.flex-col"));
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card).toHaveClass("overflow-hidden");
      for (const truncating of Array.from(card.querySelectorAll(".truncate"))) {
        let row = truncating.parentElement!;
        while (row !== card) {
          if (row.classList.contains("flex")) expect(row).toHaveClass("w-full", "min-w-0");
          row = row.parentElement!;
        }
      }
    }
  });
});
