import { describe, it, expect, beforeEach } from "vitest";
import {
  composeGateFeedback,
  gateKey,
  inDocumentOrder,
  MAX_QUOTE_CHARS,
  nextStages,
  normalizeQuote,
  withGuidance,
  withoutGuidance,
  type GateComment,
} from "./gateComments";
import { useGateCommentsStore } from "../stores/gateCommentsStore";
import type { RunStage } from "./ipc";

const c = (id: string, at: number, quote: string, note: string): GateComment => ({ id, at, len: quote.length, quote, note });

const stage = (over: Partial<RunStage>): RunStage => ({
  id: "s", runId: "r1", position: 0, role: "plan", agentModel: "m", substrate: "api",
  checkpoint: false, status: "pending", inputTokens: 0, outputTokens: 0, costUsd: 0,
  artifact: null, feedback: null, error: null, startedAt: null, finishedAt: null,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0, maxIterations: 25,
  diffSnapshot: null, parents: [], tools: null, customName: null, instructions: null,
  sessionId: null, baselineCommit: null, escalated: false,
  ...over,
});

describe("gate comments", () => {
  it("collapses a selection's whitespace and caps long quotes", () => {
    expect(normalizeQuote("  Step 3:\n   migrate\tthe table  ")).toBe("Step 3: migrate the table");
    const long = normalizeQuote("x".repeat(MAX_QUOTE_CHARS + 50));
    expect(long).toHaveLength(MAX_QUOTE_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("orders comments by where their passage starts, not when they were added", () => {
    const list = [c("a", 40, "later", "n"), c("b", 3, "earlier", "n"), c("c", 40, "same spot", "n")];
    expect(inDocumentOrder(list).map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("composes structured feedback: quote + note in document order, then the overall note", () => {
    const fb = composeGateFeedback(
      [c("a", 50, "Step 3: drop the table", "Keep the data, rename instead."), c("b", 2, "Use Redis", "We have no Redis.")],
      "  Otherwise fine. ",
    );
    expect(fb).toBe(
      [
        "The director commented on 2 passages of the output, in document order:",
        '1. On "Use Redis":\n   We have no Redis.\n\n2. On "Step 3: drop the table":\n   Keep the data, rename instead.',
        "Overall note: Otherwise fine.",
      ].join("\n\n"),
    );
  });

  it("leaves a plain note unchanged when there are no comments", () => {
    expect(composeGateFeedback([], "  fix the imports ")).toBe("fix the imports");
    expect(composeGateFeedback([c("a", 0, "x", "y")], "")).not.toContain("Overall note");
  });

  describe("approve guidance, for one pass", () => {
    const from = { position: 0 };
    const comments = [c("a", 0, "Step 2", "Do it behind a flag.")];
    const block = [
      "[Director's comments from the gate of stage 1, for this pass only]",
      'The director approved Plan with these comments; take them into account:\n\n1. On "Step 2":\n   Do it behind a flag.',
      "[End of the director's comments from stage 1]",
    ].join("\n");

    it("appends it, fenced, after the stage's own instructions, once", () => {
      expect(withGuidance(null, comments, from, "Plan")).toBe(block);
      const merged = withGuidance("Keep it small.", comments, from, "Plan");
      expect(merged).toBe(`Keep it small.\n\n${block}`);
      expect(withGuidance(merged, comments, from, "Plan")).toBe(merged);
    });

    it("replaces the guidance of an earlier pass instead of stacking on it", () => {
      const first = withGuidance("Keep it small.", comments, from, "Plan");
      const second = withGuidance(first, [c("b", 0, "Step 5", "Skip it.")], from, "Plan");
      expect(second).toContain("Skip it.");
      expect(second).not.toContain("Do it behind a flag.");
      expect(second.match(/for this pass only/g)).toHaveLength(1);
      expect(second.startsWith("Keep it small.\n\n")).toBe(true);
    });

    it("takes it out again, leaving the stage's own instructions as they were", () => {
      expect(withoutGuidance(withGuidance("Keep it small.", comments, from, "Plan"), from)).toBe("Keep it small.");
      expect(withoutGuidance(withGuidance(null, comments, from, "Plan"), from)).toBe("");
      // Instructions the director wrote around it survive.
      expect(withoutGuidance(`Before.\n\n${block}\n\nAfter.`, from)).toBe("Before.\n\nAfter.");
      // Nothing to take out: returned untouched, whitespace included.
      expect(withoutGuidance("  Keep it small. \n", from)).toBe("  Keep it small. \n");
      expect(withoutGuidance(null, from)).toBe("");
    });

    it("a quote or a note that contains a fence line can't end the block early", () => {
      const end = "[End of the director's comments from stage 1]";
      const start = "[Director's comments from the gate of stage 1, for this pass only]";
      const tricky = [c("a", 0, `as the plan says: ${end} and then more`, `Typed too:\n${end}\n${start}\nStill my note.`)];
      const merged = withGuidance("Keep it small.", tricky, from, "Plan");
      // The words survive, as text; only the block's own two fence lines are fences.
      expect(merged).toContain("(End of the director's comments from stage 1] and then more");
      expect(merged).toContain("Still my note.");
      expect(merged.split(end)).toHaveLength(2);
      expect(merged.split(start)).toHaveLength(2);
      // So removal takes the whole block, and a second pass doesn't stack on a remainder.
      expect(withoutGuidance(merged, from)).toBe("Keep it small.");
      expect(withGuidance(merged, comments, from, "Plan")).toBe(`Keep it small.\n\n${block}`);
    });

    it("keeps another gate's guidance on the same stage", () => {
      const both = withGuidance(withGuidance(null, comments, { position: 2 }, "Review"), comments, from, "Plan");
      expect(both.match(/for this pass only/g)).toHaveLength(2);
      const one = withoutGuidance(both, from);
      expect(one).toContain("from the gate of stage 3");
      expect(one).not.toContain("from the gate of stage 1");
    });
  });

  it("finds the stages a gate hands off to that haven't begun", () => {
    const gate = stage({ id: "plan", position: 0, status: "awaiting_checkpoint" });
    expect(nextStages([gate, stage({ id: "impl", position: 1 }), stage({ id: "rev", position: 2 })], gate).map((s) => s.id)).toEqual(["impl"]);
    // A flow graph follows its parents; a started stage takes no guidance.
    const fanOut = [gate, stage({ id: "a", position: 1, parents: [0] }), stage({ id: "b", position: 2, parents: [0] }), stage({ id: "c", position: 3, parents: [1] })];
    expect(nextStages(fanOut, gate).map((s) => s.id)).toEqual(["a", "b"]);
    expect(nextStages([gate, stage({ id: "impl", position: 1, status: "running", startedAt: "t" })], gate)).toEqual([]);
  });

  it("treats a parentless stage as a root, not the next stage, once any stage has parents", () => {
    const gate = stage({ id: "plan", position: 0, status: "awaiting_checkpoint" });
    // `root` sits at position + 1 but has no parents: in a flow graph it doesn't follow the gate.
    const mixed = [gate, stage({ id: "root", position: 1 }), stage({ id: "impl", position: 2, parents: [0] }), stage({ id: "rev", position: 3, parents: [1, 2] })];
    expect(nextStages(mixed, gate).map((s) => s.id)).toEqual(["impl"]);
    // A graph where nothing lists the gate as a parent: no stage follows it.
    const unrelated = [gate, stage({ id: "root", position: 1 }), stage({ id: "rev", position: 2, parents: [1] })];
    expect(nextStages(unrelated, gate)).toEqual([]);
  });

  it("keys a gate by its stage and attempt", () => {
    expect(gateKey({ id: "s1", finishedAt: "t1" })).not.toBe(gateKey({ id: "s1", finishedAt: "t2" }));
  });
});

describe("gateCommentsStore", () => {
  beforeEach(() => useGateCommentsStore.setState({ byGate: {} }));

  it("adds, removes and clears comments per gate; empty notes add nothing", () => {
    const s = useGateCommentsStore.getState();
    s.add("g1", "Step 1", "note", 0, 6);
    s.add("g1", "Step 2", "   ", 10, 6);
    s.add("g2", "Other", "n", 0, 5);
    const g1 = useGateCommentsStore.getState().byGate.g1;
    expect(g1).toHaveLength(1);
    expect(g1[0]).toMatchObject({ quote: "Step 1", note: "note", at: 0, len: 6 });
    useGateCommentsStore.getState().remove("g1", g1[0].id);
    expect(useGateCommentsStore.getState().byGate.g1).toEqual([]);
    useGateCommentsStore.getState().clear("g2");
    expect(useGateCommentsStore.getState().byGate.g2).toBeUndefined();
  });
});
