import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";

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

  it("a running beacon pulses in verdigris, never brass (#749)", () => {
    const { container } = render(
      <RunFlow stages={stages} selectedStageId="b" beaconStageId="b" onSelectStage={() => {}} />,
    );
    const card = container.querySelector(".octo-stage-pulse")!;
    expect(card).toHaveClass("octo-stage-pulse-running", "border-octo-verdigris");
    expect(card.className).not.toMatch(/border-octo-brass|brass-dim/);
  });

  it("an awaiting-gate beacon keeps the brass pulse", () => {
    const gate = [mk({ id: "g", status: "awaiting_checkpoint", checkpoint: true })];
    const { container } = render(
      <RunFlow stages={gate} selectedStageId="g" beaconStageId="g" onSelectStage={() => {}} />,
    );
    const card = container.querySelector(".octo-stage-pulse")!;
    expect(card).toHaveClass("border-octo-brass");
    expect(card).not.toHaveClass("octo-stage-pulse-running");
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

  it("keeps the essence meta on one nowrap line in the compact token format (#874)", () => {
    const done = [
      mk({ id: "i", position: 1, status: "done", costUsd: 0.3, inputTokens: 18_412, outputTokens: 3_100 }),
      mk({ id: "s", position: 2, status: "running", startedAt: 1 }),
    ];
    const { container } = render(
      <RunFlow stages={done} selectedStageId="s" beaconStageId="s" onSelectStage={() => {}} />,
    );
    const tokens = screen.getByText("↑18k ↓3.1k");
    expect(tokens).toHaveClass("octo-demote", "octo-tabular");
    expect(tokens).not.toHaveClass("octo-demote-shed");
    expect(tokens.parentElement).toHaveClass("whitespace-nowrap", "overflow-hidden", "h-4");
    expect(container.textContent).not.toContain("18.4k");
  });

  it("sheds the essence token pair, never position or cost, when the line can't fit", () => {
    const big = [
      mk({ id: "i", position: 0, status: "done", costUsd: 123.45, inputTokens: 184_000, outputTokens: 31_000 }),
      mk({ id: "s", position: 1, status: "running", startedAt: 1 }),
    ];
    render(<RunFlow stages={big} selectedStageId="s" beaconStageId="s" onSelectStage={() => {}} />);
    const tokens = screen.getByText("↑184k ↓31k");
    expect(tokens).toHaveClass("octo-demote-shed");
    expect(screen.getByText("$123.45")).not.toHaveClass("octo-demote");
    expect(tokens.parentElement).toHaveAttribute("title", "$123.45 · ↑184.0k ↓31.0k tokens");
  });

  it("reads an unpriced essence cost as mute 'unpriced', never $0.00", () => {
    const unpriced = [
      mk({ id: "i", position: 1, status: "done", unpricedModel: true, ranModel: "fable-x", inputTokens: 18_412, outputTokens: 3_100 }),
      mk({ id: "s", position: 2, status: "running", startedAt: 1 }),
    ];
    const { container } = render(
      <RunFlow stages={unpriced} selectedStageId="s" beaconStageId="s" onSelectStage={() => {}} />,
    );
    const label = screen.getByText("unpriced");
    expect(label).toHaveClass("text-octo-mute");
    expect(label).not.toHaveClass("text-octo-brass");
    expect(label.getAttribute("title")).toContain("No price for fable-x");
    // "2 unpriced ↑18k ↓3.1k" is 19ch: the token pair sheds.
    expect(screen.getByText("↑18k ↓3.1k")).toHaveClass("octo-demote-shed");
    const line = label.parentElement!;
    expect(line).toHaveAttribute("title", "unpriced · ↑18.4k ↓3.1k tokens");
    expect(container.textContent).not.toContain("$0.00");
  });

  it("reads an unreported essence cost as mute 'unreported', never truncated or $0.00 (#937)", () => {
    const unreported = [
      mk({ id: "i", position: 2, status: "done", usageUnreported: true }),
      mk({ id: "s", position: 3, status: "running", startedAt: 1 }),
    ];
    const { container } = render(
      <RunFlow stages={unreported} selectedStageId="s" beaconStageId="s" onSelectStage={() => {}} />,
    );
    const label = screen.getByText("unreported");
    expect(label).toHaveClass("text-octo-mute", "shrink-0");
    expect(label).not.toHaveClass("truncate");
    expect(label.getAttribute("title")).toMatch(/^Usage not reported\./);
    expect(container.textContent).not.toContain("usage not reported");
    expect(container.textContent).not.toContain("$0.00");
  });

  it("keeps 'usage not reported' in full in a shed line's tooltip (#937)", () => {
    const unreported = [
      mk({ id: "i", position: 2, status: "done", usageUnreported: true, inputTokens: 18_412, outputTokens: 3_100 }),
      mk({ id: "s", position: 3, status: "running", startedAt: 1 }),
    ];
    render(<RunFlow stages={unreported} selectedStageId="s" beaconStageId="s" onSelectStage={() => {}} />);
    const tokens = screen.getByText("↑18k ↓3.1k");
    expect(tokens).toHaveClass("octo-demote-shed");
    expect(tokens.parentElement).toHaveAttribute("title", "usage not reported · ↑18.4k ↓3.1k tokens");
  });

  it("reads millions as M in a shed line's tooltip, never 1240.0k (#937)", () => {
    const big = [
      mk({ id: "i", position: 0, status: "done", costUsd: 123.45, inputTokens: 1_240_000, outputTokens: 31_000 }),
      mk({ id: "s", position: 1, status: "running", startedAt: 1 }),
    ];
    render(<RunFlow stages={big} selectedStageId="s" beaconStageId="s" onSelectStage={() => {}} />);
    const tokens = screen.getByText("↑1.2M ↓31k");
    expect(tokens).toHaveClass("octo-demote-shed");
    expect(tokens.parentElement).toHaveAttribute("title", "$123.45 · ↑1.24M ↓31.0k tokens");
  });

  it("reads a tiny positive essence cost as <$0.01, never $0.00 (#937)", () => {
    const tiny = [
      mk({ id: "i", position: 0, status: "done", costUsd: 0.001 }),
      mk({ id: "s", position: 1, status: "running", startedAt: 1 }),
    ];
    const { container } = render(
      <RunFlow stages={tiny} selectedStageId="s" beaconStageId="s" onSelectStage={() => {}} />,
    );
    expect(screen.getByText("<$0.01")).toHaveClass("text-octo-brass");
    expect(container.textContent).not.toContain("$0.00");
  });

  it("gives screen readers the full figures of a shed token pair (#937)", () => {
    const big = [
      mk({ id: "i", position: 0, status: "done", costUsd: 123.45, inputTokens: 1_240_000, outputTokens: 31_000 }),
      mk({ id: "s", position: 1, status: "running", startedAt: 1 }),
    ];
    render(<RunFlow stages={big} selectedStageId="s" beaconStageId="s" onSelectStage={() => {}} />);
    const sr = screen.getByText("1.24M input, 31.0k output tokens");
    expect(sr).toHaveClass("sr-only");
    expect(sr.closest("button")!.textContent).toContain("1.24M input, 31.0k output tokens");
  });

  it("adds no sr-only token text when the pair fits", () => {
    const done = [
      mk({ id: "i", position: 1, status: "done", costUsd: 0.3, inputTokens: 18_412, outputTokens: 3_100 }),
      mk({ id: "s", position: 2, status: "running", startedAt: 1 }),
    ];
    const { container } = render(
      <RunFlow stages={done} selectedStageId="s" beaconStageId="s" onSelectStage={() => {}} />,
    );
    expect(container.textContent).not.toContain("output tokens");
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

describe("RunFlow — a stage that ran on another model (#791)", () => {
  it("notes the model that ran, with what it asked for in the tooltip", () => {
    const ran = [mk({ id: "a", status: "done", substrate: "cli", agentModel: "claude-opus-5-5", ranModel: "claude-sonnet-5-5" })];
    render(<RunFlow stages={ran} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />);
    const note = screen.getByText("ran on sonnet-5-5");
    expect(note.getAttribute("title")).toContain("asked for claude-opus-5-5");
    expect(note.className).toContain("text-octo-warning");
  });

  it("says nothing when it ran on the model it asked for", () => {
    const same = [mk({ id: "a", status: "done", substrate: "cli", agentModel: "claude-opus-5-5", ranModel: null })];
    render(<RunFlow stages={same} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />);
    expect(screen.queryByText(/ran on/)).not.toBeInTheDocument();
  });
});

describe("RunFlow — tool calls Claude Code refused (#893)", () => {
  it("adds the amber count to a done card's verdict, which stays the last non-refusal notice", () => {
    live.liveByStage = {
      a: [
        { kind: "notice", text: "VERDICT: PASS" },
        { kind: "notice", text: "refused · Bash · git push ×2" },
      ],
    };
    const done = [mk({ id: "a", status: "done", substrate: "cli", refusedCalls: 2 })];
    render(<RunFlow stages={done} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />);
    expect(screen.getByText("VERDICT: PASS")).toBeInTheDocument();
    const note = screen.getByText("2 tool calls refused");
    expect(note).toHaveClass("text-octo-warning");
    expect(note.className).not.toMatch(/brass/);
    expect(note.getAttribute("data-tour")).toBe("direct-stage-refused");
    live.liveByStage = {};
  });

  it("says nothing while running, or when nothing was refused", () => {
    const quiet = [
      mk({ id: "a", status: "done", refusedCalls: 0 }),
      mk({ id: "b", position: 1, status: "running", startedAt: 1, refusedCalls: 3 }),
    ];
    render(<RunFlow stages={quiet} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />);
    expect(screen.queryByText(/tool calls? refused/)).not.toBeInTheDocument();
  });
});


describe("RunFlow — an aborted run (#891)", () => {
  it("reads the stage the abort froze at running as aborted, muted, without the waiting line", () => {
    const frozen = [mk({ id: "a", status: "done" }), mk({ id: "b", position: 1, status: "running", startedAt: 1 })];
    const { container } = render(
      <RunFlow stages={frozen} selectedStageId="b" beaconStageId="b" runAborted onSelectStage={() => {}} />,
    );
    expect(screen.queryByText("waiting for first tool call")).not.toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
    expect(screen.getByText("aborted")).toBeInTheDocument();
    const glyph = screen.getByTitle("aborted");
    expect(glyph.textContent).toBe("■");
    expect(glyph.className).toContain("text-octo-mute");
    expect(container.querySelector(".octo-stage-pulse")).toBeNull();
    expect(container.querySelector(".border-octo-verdigris")).toBeNull();
  });

  it("reads a gate frozen by an abort as aborted, never brass review", () => {
    const gate = [mk({ id: "g", status: "awaiting_checkpoint", checkpoint: true })];
    const { container } = render(
      <RunFlow stages={gate} selectedStageId="g" beaconStageId={null} runAborted onSelectStage={() => {}} />,
    );
    expect(screen.queryByText("review")).not.toBeInTheDocument();
    expect(screen.getByTitle("aborted").textContent).toBe("■");
    expect(container.querySelector(".border-octo-brass")).toBeNull();
  });

  it("keeps the selection highlight on a selected cut card (#904)", () => {
    const frozen = [mk({ id: "b", status: "running", startedAt: 1 })];
    const { container } = render(
      <RunFlow stages={frozen} selectedStageId="b" beaconStageId={null} runAborted onSelectStage={() => {}} />,
    );
    const card = container.querySelector("button")!;
    expect(card.className).toContain("border-[var(--brass-dim)]");
    expect(card.className).toContain("bg-[var(--brass-ghost)]");
  });

  it("leaves an unselected cut card on the hairline skin", () => {
    const frozen = [mk({ id: "a", status: "done" }), mk({ id: "b", position: 1, status: "running", startedAt: 1 })];
    const { container } = render(
      <RunFlow stages={frozen} selectedStageId="a" beaconStageId={null} runAborted onSelectStage={() => {}} />,
    );
    const cards = container.querySelectorAll("button");
    expect(cards[1].className).toContain("border-octo-hairline");
    expect(cards[1].className).not.toContain("brass-ghost");
  });

  it("mutes the gate mark on a dead run (#904)", () => {
    const gate = [mk({ id: "g", status: "awaiting_checkpoint", checkpoint: true })];
    render(<RunFlow stages={gate} selectedStageId="g" beaconStageId={null} runAborted onSelectStage={() => {}} />);
    const mark = screen.getByText("⟜");
    expect(mark.className).toContain("text-octo-mute");
    expect(mark.className).not.toContain("text-octo-brass");
  });

  it("keeps the gate mark brass on a live run", () => {
    render(<RunFlow stages={stages} selectedStageId="b" beaconStageId="b" onSelectStage={() => {}} />);
    expect(screen.getByText("⟜").className).toContain("text-octo-brass");
  });

  it("leaves a live run's stages alone", () => {
    render(<RunFlow stages={stages} selectedStageId="b" beaconStageId="b" onSelectStage={() => {}} />);
    expect(screen.getByTitle("running").textContent).toBe("●");
  });
});

describe("RunFlow — the running stage's context meter (#895)", () => {
  // `opus` is short enough to leave the reading room; real ids are not.
  const running = (over: Record<string, unknown>) => [
    mk({ id: "a", status: "running", startedAt: 1, substrate: "cli", agentModel: "opus", ...over }),
  ];
  const ctxEl = (c: HTMLElement) => c.querySelector('[data-tour="direct-stage-context"]')!;

  it("reads ctx used / window on the running card's meta line when it fits", () => {
    const { container } = render(
      <RunFlow stages={running({ contextTokens: 142_000, contextWindow: 200_000 })} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(ctxEl(container)).toHaveTextContent("ctx 142k / 200k");
    expect(ctxEl(container)).toHaveClass("octo-demote", "text-octo-mute");
    expect(ctxEl(container)).not.toHaveClass("octo-demote-shed");
    expect(ctxEl(container).getAttribute("title")).toContain("142,000 of 200,000 tokens (71%)");
  });

  it("names a running card's model short, full id in the tooltip, and sheds the reading first", () => {
    const { container } = render(
      <RunFlow
        stages={running({ agentModel: "claude-opus-5-5", contextTokens: 194_000, contextWindow: 200_000 })}
        selectedStageId="a"
        beaconStageId={null}
        onSelectStage={() => {}}
      />,
    );
    const model = screen.getByText("opus-5-5");
    expect(model.getAttribute("title")).toBe("claude-opus-5-5");
    expect(ctxEl(container)).toHaveClass("octo-demote-shed");
    // Screen readers still get the figures.
    expect(container.querySelector(".sr-only")?.textContent).toContain("194,000 of 200,000 tokens");
  });

  it("keeps the full model id on a card that isn't running", () => {
    const done = [mk({ id: "a", status: "done", substrate: "cli", agentModel: "claude-opus-5-5" })];
    render(<RunFlow stages={done} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />);
    expect(screen.getByText("claude-opus-5-5")).toBeInTheDocument();
  });

  it("turns amber past 80% and rouge past 95%, and a 97%-full reading still fits", () => {
    const { container, rerender } = render(
      <RunFlow stages={running({ contextTokens: 170_000, contextWindow: 200_000 })} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(ctxEl(container)).toHaveClass("text-octo-warning");
    rerender(
      <RunFlow stages={running({ contextTokens: 194_000, contextWindow: 200_000 })} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(ctxEl(container)).toHaveClass("text-octo-rouge");
    expect(ctxEl(container)).toHaveAttribute("data-tone", "rouge");
    expect(ctxEl(container)).toHaveTextContent("ctx 194k / 200k");
    expect(ctxEl(container)).not.toHaveClass("octo-demote-shed");
  });

  it("stays shed while the window is unknown, the reading is over it, or no message has arrived", () => {
    for (const over of [
      { contextTokens: 142_000, contextWindow: null },
      { contextTokens: 400_000, contextWindow: 200_000 },
      { contextTokens: null, contextWindow: null },
    ]) {
      const { container, unmount } = render(
        <RunFlow stages={running(over)} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />,
      );
      expect(ctxEl(container)).toHaveClass("octo-demote-shed");
      expect(ctxEl(container)).toHaveTextContent("");
      expect(container.textContent).not.toMatch(/ctx /);
      unmount();
    }
  });

  it("sheds the reading, never the effort or the position, when the line can't fit", () => {
    const { container } = render(
      <RunFlow
        stages={running({ contextTokens: 142_000, contextWindow: 200_000, effort: "high" })}
        selectedStageId="a"
        beaconStageId={null}
        onSelectStage={() => {}}
      />,
    );
    expect(ctxEl(container)).toHaveClass("octo-demote-shed");
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("reads the newest live reading over a stale stage row", () => {
    (live as any).liveContextByStage = { a: { contextTokens: 180_000, contextWindow: 200_000 } };
    try {
      const { container } = render(
        <RunFlow stages={running({ contextTokens: 120_000, contextWindow: 200_000 })} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />,
      );
      expect(ctxEl(container)).toHaveTextContent("ctx 180k / 200k");
    } finally {
      delete (live as any).liveContextByStage;
    }
  });

  it("is not on a finished card, nor on the stage an abort cut", () => {
    const done = [mk({ id: "a", status: "done", substrate: "cli", contextTokens: 142_000, contextWindow: 200_000 })];
    const { container, rerender } = render(
      <RunFlow stages={done} selectedStageId="a" beaconStageId={null} onSelectStage={() => {}} />,
    );
    expect(container.querySelector('[data-tour="direct-stage-context"]')).toBeNull();
    rerender(
      <RunFlow
        stages={running({ contextTokens: 142_000, contextWindow: 200_000 })}
        selectedStageId="a"
        beaconStageId={null}
        runAborted
        onSelectStage={() => {}}
      />,
    );
    expect(container.querySelector('[data-tour="direct-stage-context"]')).toBeNull();
  });
});
