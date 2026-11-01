import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Run } from "../lib/ipc";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/ipc", async (orig) => {
  const actual = await orig<any>();
  return {
    ...actual,
    ipc: { ...actual.ipc, listRunsSettledSince: vi.fn() },
  };
});

const { RunsTray } = await import("./RunsTray");
const { useRunsStore } = await import("../stores/runsStore");
const { ipc } = await import("../lib/ipc");

const OVERNIGHT: Run = {
  id: "r9", workspaceId: "w9", pipelineId: "p", task: "overnight", status: "completed",
  costUsd: 0.1, baselineUsd: 0.5, referenceModel: null, linkedIssueKey: null,
  createdAt: "2026-10-30T23:00:00+00:00", finishedAt: "2026-10-31T03:10:00+00:00",
  budgetUsd: null, detached: true,
};

beforeEach(() => {
  useRunsStore.setState({ runsByWs: {}, settledAt: {}, awayRunIds: [], awayStatus: "idle" });
});

describe("RunsTray", () => {
  it("shows '✓ n done' for runs that settled while the app was closed", async () => {
    (ipc.listRunsSettledSince as any).mockResolvedValue([OVERNIGHT]);
    const { container, rerender } = render(<RunsTray onOpen={() => {}} />);
    expect(container.firstChild).toBeNull(); // still loading: nothing to show
    await useRunsStore.getState().loadSettledWhileAway();
    rerender(<RunsTray onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "1 run settled — open Mission Control" }).textContent).toBe(
      "1 done",
    );
  });
});
