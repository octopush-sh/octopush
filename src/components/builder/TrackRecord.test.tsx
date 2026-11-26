import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CrewSuggestion, StageOutcome } from "../../lib/ipc";
import { TrackRecord, type StageRecord } from "./TrackRecord";

const outcome = (over: Partial<StageOutcome> = {}): StageOutcome => ({
  position: 1, role: "implement", runs: 20, firstPass: 17, loopBacks: 6, escalated: 2, halted: 1, medianUsd: 0.42,
  byModel: [{ model: "claude-sonnet-5-5", runs: 20, medianUsd: 0.42 }],
  recent: ["pass", "rework", "halt", ...Array<"pass">(7).fill("pass")], ...over,
});

const lighter: CrewSuggestion = {
  kind: "lighterTier", position: 1, role: "implement", runs: 20, count: 19, model: "claude-haiku-5-5", modelLabel: "Haiku 5.5",
  escalateModel: "claude-sonnet-5-5", escalateLabel: "Sonnet 5.5", savingUsd: 0.2, senderPosition: null, meanLoops: null,
};

const record = (over: Partial<StageRecord> = {}): StageRecord => ({
  outcome: outcome(), minRuns: 8, suggestions: [], name: "Implement", senderName: () => "", ...over,
});

describe("TrackRecord", () => {
  it("shows the record and an outcome micro-history with no brass", () => {
    render(<TrackRecord record={record()} onPatch={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Track record" }));
    expect(screen.getByText("20 runs · first pass 85% · loops 0.3 · escalated 10% · median $0.42")).toBeInTheDocument();
    const dots = document.querySelectorAll("[data-dot]");
    expect(dots).toHaveLength(10);
    expect([...dots].some((d) => d.className.includes("brass"))).toBe(false);
    // Oldest left: the newest outcome (a pass) is the last dot; the halt is third from the right.
    expect(dots[7].className).toContain("bg-octo-rouge");
    expect(dots[8].className).toContain("bg-octo-warning");
  });

  it("never prints $0 for an unpriced stage", () => {
    render(<TrackRecord record={record({ outcome: outcome({ medianUsd: null }) })} onPatch={vi.fn()} />);
    expect(screen.getByText(/median unpriced$/)).toBeInTheDocument();
  });

  it("stays quiet below the floor", () => {
    render(<TrackRecord record={record({ outcome: outcome({ runs: 7 }), suggestions: [lighter] })} onPatch={vi.fn()} />);
    expect(screen.getByText("Track record appears after 8 runs of this crew.")).toBeInTheDocument();
    expect(screen.queryByText(/Try Haiku/)).not.toBeInTheDocument();
  });

  it("a suggestion edits the draft, keeping the safety net", () => {
    const onPatch = vi.fn();
    render(<TrackRecord record={record({ suggestions: [lighter] })} onPatch={onPatch} />);
    expect(screen.getByText(/About \$0\.20 less per run \(estimate\)\.$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try Haiku 5.5 on Implement" }));
    expect(onPatch).toHaveBeenCalledWith({ agentModel: "claude-haiku-5-5", escalateModel: "claude-sonnet-5-5" });
  });

  it("starts collapsed with no suggestions and opens on its toggle", () => {
    render(<TrackRecord record={record()} onPatch={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: "Track record" });
    const region = screen.getByText(/^20 runs · first pass/).closest("[aria-hidden]");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(region).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(region).toHaveAttribute("aria-hidden", "false");
  });

  it("a loop hotspot reads its detail and offers no edit", () => {
    const hotspot: CrewSuggestion = {
      kind: "loopHotspot", position: 1, role: "implement", runs: 20, count: 20, model: null, modelLabel: null,
      escalateModel: null, escalateLabel: null, savingUsd: null, senderPosition: 2, meanLoops: 1.8,
    };
    const onPatch = vi.fn();
    render(<TrackRecord record={record({ suggestions: [hotspot], senderName: (p) => (p === 2 ? "Code review" : "") })} onPatch={onPatch} />);
    expect(screen.getByRole("button", { name: "Track record" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/^Code review sent Implement back 1\.8× per run\./)).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(onPatch).not.toHaveBeenCalled();
  });
});
