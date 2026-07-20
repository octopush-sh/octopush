import { describe, it, expect, beforeEach } from "vitest";
import {
  graphToStageDrafts,
  draftToGraph,
  validateGraph,
  newStageData,
  loopEdge,
  archetypeFromRole,
  archetypeFor,
  archetypes,
  setArchetypes,
  tidyLayout,
  TIDY_ROW_GAP,
  TIDY_COL_GAP,
  reconnectAllowed,
  type StageNode,
  type StageEdge,
} from "./graph";
import type { PipelineWithStages, PipelineStage, Role } from "../../lib/ipc";

// ─── Seed roles that mirror the 10 original built-ins ────────────────────────

function makeRole(overrides: Partial<Role> & Pick<Role, "key" | "label" | "artifactKind" | "canLoop">): Role {
  return {
    description: "",
    promptBody: "",
    environment: "worktree",
    defaultTools: ["read_file", "list_files"],
    defaultSubstrate: "api",
    defaultCheckpoint: false,
    tokenEstIn: 4000,
    tokenEstOut: 1000,
    isBuiltin: true,
    ...overrides,
  };
}

const SEED_ROLES: Role[] = [
  makeRole({ key: "plan", label: "Plan", artifactKind: "plan", canLoop: false, defaultTools: ["read_file", "list_files"] }),
  makeRole({ key: "plan_review", label: "Plan review", artifactKind: "review", canLoop: true, defaultTools: ["read_file", "list_files"] }),
  makeRole({ key: "implement", label: "Implement", artifactKind: "diff", canLoop: false, defaultTools: ["read_file", "list_files", "write_file", "run_command"] }),
  makeRole({ key: "code_review", label: "Code review", artifactKind: "review", canLoop: true, defaultTools: ["read_file", "list_files"] }),
  makeRole({ key: "test", label: "Tests", artifactKind: "tests", canLoop: false, defaultTools: ["read_file", "list_files", "write_file", "run_command"] }),
  makeRole({ key: "repro", label: "Reproduce", artifactKind: "review", canLoop: false, defaultTools: ["read_file", "list_files", "run_command"] }),
  makeRole({ key: "fix", label: "Fix", artifactKind: "diff", canLoop: false, defaultTools: ["read_file", "list_files", "write_file", "run_command"] }),
  makeRole({ key: "verify", label: "Verify", artifactKind: "review", canLoop: true, defaultTools: ["read_file", "list_files", "run_command"] }),
  makeRole({ key: "critique", label: "Critique", artifactKind: "review", canLoop: true, defaultTools: ["read_file", "list_files"] }),
  makeRole({ key: "refine", label: "Refine", artifactKind: "plan", canLoop: false, defaultTools: ["read_file", "list_files"] }),
];

// Seed LOADED before every test suite so archetypeFor/archetypes() work.
beforeEach(() => {
  setArchetypes(SEED_ROLES);
});

function node(id: string, role: string, x = 0, y = 0): StageNode {
  return { id, type: "stage", position: { x, y }, data: { ...newStageData(role) } };
}
function flow(source: string, target: string): StageEdge {
  return { id: `f-${source}-${target}`, source, target, type: "flow", data: { kind: "flow" } };
}

function tnode(id: string, x: number, y: number): StageNode {
  return { id, type: "stage", position: { x, y }, data: newStageData("implement") };
}
function tedge(source: string, target: string): StageEdge {
  return { id: `f-${source}-${target}`, source, target, type: "flow", data: { kind: "flow" } };
}

// ─── Task 8 new tests ────────────────────────────────────────────────────────

describe("archetypeFromRole", () => {
  it("maps Role fields to Archetype shape", () => {
    const role = makeRole({ key: "plan", label: "Plan", artifactKind: "plan", canLoop: false, defaultTools: ["read_file"] });
    const a = archetypeFromRole(role);
    expect(a.role).toBe("plan");
    expect(a.label).toBe("Plan");
    expect(a.artifact).toBe("plan");
    expect(a.canLoop).toBe(false);
    expect(a.defaultTools).toEqual(["read_file"]);
  });

  it("maps canLoop=true correctly", () => {
    const role = makeRole({ key: "code_review", label: "Code review", artifactKind: "review", canLoop: true });
    const a = archetypeFromRole(role);
    expect(a.canLoop).toBe(true);
    expect(a.artifact).toBe("review");
  });
});

describe("setArchetypes + archetypes", () => {
  it("round-trips: setArchetypes then archetypes returns mapped list", () => {
    const roles: Role[] = [
      makeRole({ key: "my_role", label: "My Role", artifactKind: "note", canLoop: false }),
    ];
    setArchetypes(roles);
    const all = archetypes();
    expect(all).toHaveLength(1);
    expect(all[0].role).toBe("my_role");
    expect(all[0].label).toBe("My Role");
    expect(all[0].artifact).toBe("note");
  });

  it("replaces previous LOADED on successive calls", () => {
    setArchetypes(SEED_ROLES);
    expect(archetypes()).toHaveLength(SEED_ROLES.length);
    setArchetypes([makeRole({ key: "solo", label: "Solo", artifactKind: "plan", canLoop: false })]);
    expect(archetypes()).toHaveLength(1);
    // Restore for subsequent tests
    setArchetypes(SEED_ROLES);
  });
});

describe("archetypeFor", () => {
  it("returns the matching archetype when found", () => {
    const a = archetypeFor("code_review");
    expect(a.role).toBe("code_review");
    expect(a.canLoop).toBe(true);
  });

  it("returns a safe fallback (not undefined) for unknown keys", () => {
    const a = archetypeFor("totally_unknown_role");
    expect(a).toBeTruthy();
    expect(a.role).toBe("totally_unknown_role");
    expect(a.artifact).toBe("note");
    expect(a.canLoop).toBe(false);
  });

  it("returns a safe fallback when LOADED is empty", () => {
    setArchetypes([]); // simulate pre-load state
    const a = archetypeFor("plan");
    expect(a).toBeTruthy();
    expect(a.role).toBe("plan");
    expect(a.canLoop).toBe(false);
    // Restore
    setArchetypes(SEED_ROLES);
  });
});

// ─── Existing tests (unchanged behaviour, now with seeded roles) ─────────────

describe("graphToStageDrafts", () => {
  it("topologically orders a linear chain and records single parents", () => {
    const nodes = [node("a", "plan", 0, 0), node("b", "implement", 0, 150), node("c", "test", 0, 300)];
    const edges = [flow("a", "b"), flow("b", "c")];
    const drafts = graphToStageDrafts(nodes, edges);
    expect(drafts.map((d) => d.role)).toEqual(["plan", "implement", "test"]);
    expect(drafts[0].parents).toEqual([]);
    expect(drafts[1].parents).toEqual([0]);
    expect(drafts[2].parents).toEqual([1]);
  });

  it("records both parents at a join and isolates sibling branches", () => {
    // a → b, a → c, (b,c) → d
    const nodes = [
      node("a", "plan", 0, 0),
      node("b", "implement", -100, 150),
      node("c", "test", 100, 150),
      node("d", "code_review", 0, 300),
    ];
    const edges = [flow("a", "b"), flow("a", "c"), flow("b", "d"), flow("c", "d")];
    const drafts = graphToStageDrafts(nodes, edges);
    const join = drafts[drafts.length - 1];
    expect(join.role).toBe("code_review");
    expect(join.parents).toEqual([1, 2]);
    // siblings each see only the entry
    const b = drafts.find((d) => d.role === "implement")!;
    const c = drafts.find((d) => d.role === "test")!;
    expect(b.parents).toEqual([0]);
    expect(c.parents).toEqual([0]);
  });

  it("breaks ties by canvas Y then X for a stable, readable order", () => {
    // two independent entries; lower-Y one must come first
    const nodes = [node("low", "plan", 0, 300), node("high", "repro", 0, 50)];
    const drafts = graphToStageDrafts(nodes, []);
    expect(drafts.map((d) => d.role)).toEqual(["repro", "plan"]);
  });

  it("derives loop fields from a loop edge on the review stage", () => {
    const nodes = [node("a", "implement", 0, 0), node("b", "code_review", 0, 150)];
    const edges: StageEdge[] = [flow("a", "b"), loopEdge("b", "a", 3, "auto")];
    const drafts = graphToStageDrafts(nodes, edges);
    expect(drafts[1].loopTargetPosition).toBe(0);
    expect(drafts[1].loopMaxIterations).toBe(3);
    expect(drafts[1].loopMode).toBe("auto");
    // the loop back-edge is NOT a data parent
    expect(drafts[1].parents).toEqual([0]);
  });

  it("throws on a cycle in the flow", () => {
    const nodes = [node("a", "plan"), node("b", "implement")];
    const edges = [flow("a", "b"), flow("b", "a")];
    expect(() => graphToStageDrafts(nodes, edges)).toThrow(/cycle/);
  });

  it("trims custom name / instructions and nulls empties", () => {
    const nodes = [node("a", "plan")];
    nodes[0].data.customName = "  Scout  ";
    nodes[0].data.instructions = "   ";
    const [d] = graphToStageDrafts(nodes, []);
    expect(d.customName).toBe("Scout");
    expect(d.instructions).toBeNull();
  });

  it("carries per-stage reasoning effort (default off = null)", () => {
    const nodes = [node("a", "plan"), node("b", "implement")];
    // A fresh node has no effort; an author sets High on the implement stage.
    nodes[1].data.effort = "high";
    const drafts = graphToStageDrafts(nodes, []);
    const plan = drafts.find((d) => d.role === "plan")!;
    const impl = drafts.find((d) => d.role === "implement")!;
    expect(plan.effort ?? null).toBeNull();
    expect(impl.effort).toBe("high");
  });

  it("carries the escalation policy (default = null / no policy)", () => {
    const nodes = [node("a", "plan"), node("b", "implement")];
    // A fresh node has no policy; an author sets an escalate model + effort.
    nodes[1].data.escalateModel = "claude-opus-4-6";
    nodes[1].data.escalateEffort = "high";
    const drafts = graphToStageDrafts(nodes, []);
    const plan = drafts.find((d) => d.role === "plan")!;
    const impl = drafts.find((d) => d.role === "implement")!;
    expect(plan.escalateModel ?? null).toBeNull();
    expect(plan.escalateEffort ?? null).toBeNull();
    expect(impl.escalateModel).toBe("claude-opus-4-6");
    expect(impl.escalateEffort).toBe("high");
  });
});

describe("draftToGraph", () => {
  const baseStage = (over: Partial<PipelineStage>): PipelineStage => ({
    id: over.id ?? "x",
    pipelineId: "p",
    position: over.position ?? 0,
    role: over.role ?? "plan",
    agentModel: "claude-sonnet-4-6",
    effort: over.effort ?? null,
    escalateModel: over.escalateModel ?? null,
    escalateEffort: over.escalateEffort ?? null,
    substrate: "api",
    checkpoint: false,
    loopTargetPosition: over.loopTargetPosition ?? null,
    loopMaxIterations: over.loopMaxIterations ?? 0,
    loopMode: over.loopMode ?? null,
    maxIterations: 25,
    posX: over.posX ?? null,
    posY: over.posY ?? null,
    parents: over.parents ?? [],
    tools: over.tools ?? null,
    customName: over.customName ?? null,
    instructions: over.instructions ?? null,
  });

  it("starts a fresh pipeline with a single node", () => {
    const { nodes, edges } = draftToGraph(null);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });

  it("auto-chains a legacy pipeline with no recorded parents", () => {
    const pipeline: PipelineWithStages = {
      pipeline: { id: "p", name: "Legacy", description: "", isBuiltin: true, createdAt: "" },
      stages: [baseStage({ position: 0, role: "plan" }), baseStage({ position: 1, role: "implement" }), baseStage({ position: 2, role: "test" })],
    };
    const { nodes, edges } = draftToGraph(pipeline);
    expect(nodes).toHaveLength(3);
    // a linear chain of 2 flow edges, no loops
    expect(edges.filter((e) => e.data?.kind === "flow")).toHaveLength(2);
  });

  it("round-trips parents and a loop edge", () => {
    const pipeline: PipelineWithStages = {
      pipeline: { id: "p", name: "Graph", description: "", isBuiltin: false, createdAt: "" },
      stages: [
        baseStage({ position: 0, role: "implement", posX: 0, posY: 0 }),
        baseStage({ position: 1, role: "code_review", posX: 0, posY: 150, parents: [0], loopTargetPosition: 0, loopMaxIterations: 2, loopMode: "gated" }),
      ],
    };
    const { nodes, edges } = draftToGraph(pipeline);
    expect(nodes).toHaveLength(2);
    expect(edges.filter((e) => e.data?.kind === "flow")).toHaveLength(1);
    const loop = edges.find((e) => e.data?.kind === "loop");
    expect(loop?.data?.loopMode).toBe("gated");
    // compiling it back preserves the loop target
    const drafts = graphToStageDrafts(nodes, edges);
    expect(drafts[1].loopTargetPosition).toBe(0);
  });

  it("round-trips per-stage reasoning effort edit→save", () => {
    const pipeline: PipelineWithStages = {
      pipeline: { id: "p", name: "Effort", description: "", isBuiltin: false, createdAt: "" },
      stages: [baseStage({ position: 0, role: "implement", effort: "xhigh" })],
    };
    const { nodes, edges } = draftToGraph(pipeline);
    // The saved effort reopens on the canvas node…
    expect(nodes[0].data.effort).toBe("xhigh");
    // …and survives recompilation back to a draft.
    const drafts = graphToStageDrafts(nodes, edges);
    expect(drafts[0].effort).toBe("xhigh");
  });

  it("round-trips the escalation policy edit→save", () => {
    const pipeline: PipelineWithStages = {
      pipeline: { id: "p", name: "Escalate", description: "", isBuiltin: false, createdAt: "" },
      stages: [baseStage({ position: 0, role: "implement", escalateModel: "claude-opus-4-6", escalateEffort: "max" })],
    };
    const { nodes, edges } = draftToGraph(pipeline);
    // The saved policy reopens on the canvas node…
    expect(nodes[0].data.escalateModel).toBe("claude-opus-4-6");
    expect(nodes[0].data.escalateEffort).toBe("max");
    // …and survives recompilation back to a draft.
    const drafts = graphToStageDrafts(nodes, edges);
    expect(drafts[0].escalateModel).toBe("claude-opus-4-6");
    expect(drafts[0].escalateEffort).toBe("max");
  });
});

describe("validateGraph", () => {
  it("flags an empty graph", () => {
    expect(validateGraph([], []).ok).toBe(false);
  });

  it("accepts a clean linear pipeline", () => {
    const nodes = [node("a", "plan", 0, 0), node("b", "implement", 0, 150)];
    const v = validateGraph(nodes, [flow("a", "b")]);
    expect(v.ok).toBe(true);
  });

  it("blocks a cycle", () => {
    const nodes = [node("a", "plan"), node("b", "implement")];
    const v = validateGraph(nodes, [flow("a", "b"), flow("b", "a")]);
    expect(v.ok).toBe(false);
    expect(v.blocking.some((i) => /cycle/.test(i.message))).toBe(true);
  });

  it("blocks a loop from a non-review archetype", () => {
    const nodes = [node("a", "plan", 0, 0), node("b", "implement", 0, 150)];
    const edges = [flow("a", "b"), loopEdge("b", "a", 2, "gated")];
    const v = validateGraph(nodes, edges);
    expect(v.ok).toBe(false);
    expect(v.byNode["b"]?.error).toMatch(/only review stages/);
  });

  it("blocks a loop that does not return to an ancestor", () => {
    // c reviews but loops to a sibling branch node it never depended on
    const nodes = [node("a", "plan", 0, 0), node("b", "implement", -100, 150), node("c", "code_review", 100, 150)];
    const edges = [flow("a", "b"), flow("a", "c"), loopEdge("c", "b", 2, "gated")];
    const v = validateGraph(nodes, edges);
    expect(v.ok).toBe(false);
    expect(v.byNode["c"]?.error).toMatch(/earlier stage on its own path/);
  });

  it("warns about an implement stage with no write tool", () => {
    const nodes = [node("a", "implement", 0, 0)];
    nodes[0].data.tools = ["read_file", "list_files"];
    const v = validateGraph(nodes, []);
    expect(v.ok).toBe(true); // soft
    expect(v.byNode["a"]?.warning).toMatch(/can't write files/);
  });

  it("warns about an orphan node in a multi-node graph", () => {
    const nodes = [node("a", "plan", 0, 0), node("b", "implement", 0, 150), node("c", "test", 400, 0)];
    const v = validateGraph(nodes, [flow("a", "b")]);
    expect(v.byNode["c"]?.warning).toMatch(/isn't connected/);
  });
});

describe("tidyLayout", () => {
  it("lays a linear chain as a single centered column", () => {
    const nodes = [tnode("a", 40, 300), tnode("b", -80, 10), tnode("c", 5, 90)];
    const edges = [tedge("a", "b"), tedge("b", "c")];
    const out = tidyLayout(nodes, edges);
    const pos = Object.fromEntries(out.map((n) => [n.id, n.position]));
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b).toEqual({ x: 0, y: TIDY_ROW_GAP });
    expect(pos.c).toEqual({ x: 0, y: 2 * TIDY_ROW_GAP });
  });

  it("centers a two-node row and preserves the author's left-to-right order", () => {
    // diamond: a → (left, right) → d ; "right" currently sits left of "left"
    const nodes = [tnode("a", 0, 0), tnode("left", 500, 50), tnode("right", -500, 50), tnode("d", 0, 900)];
    const edges = [tedge("a", "left"), tedge("a", "right"), tedge("left", "d"), tedge("right", "d")];
    const pos = Object.fromEntries(tidyLayout(nodes, edges).map((n) => [n.id, n.position]));
    expect(pos.right.x).toBe(-TIDY_COL_GAP / 2); // was left-most, stays left-most
    expect(pos.left.x).toBe(TIDY_COL_GAP / 2);
    expect(pos.right.y).toBe(TIDY_ROW_GAP);
    expect(pos.left.y).toBe(TIDY_ROW_GAP);
    expect(pos.d).toEqual({ x: 0, y: 2 * TIDY_ROW_GAP });
  });

  it("depth is the LONGEST path from an entry (join sits below its deepest parent)", () => {
    // a → b → c, and a → c directly: c must land at depth 2, not 1.
    const nodes = [tnode("a", 0, 0), tnode("b", 0, 100), tnode("c", 0, 200)];
    const edges = [tedge("a", "b"), tedge("b", "c"), tedge("a", "c")];
    const pos = Object.fromEntries(tidyLayout(nodes, edges).map((n) => [n.id, n.position]));
    expect(pos.c.y).toBe(2 * TIDY_ROW_GAP);
  });

  it("ignores loop edges when computing depth", () => {
    const nodes = [tnode("a", 0, 0), tnode("r", 0, 100)];
    const edges = [tedge("a", "r"), loopEdge("r", "a", 2, "gated")];
    const pos = Object.fromEntries(tidyLayout(nodes, edges).map((n) => [n.id, n.position]));
    expect(pos.a.y).toBe(0);
    expect(pos.r.y).toBe(TIDY_ROW_GAP);
  });

  it("returns nodes untouched when the flow has a cycle", () => {
    const nodes = [tnode("a", 7, 8), tnode("b", 9, 10)];
    const edges = [tedge("a", "b"), tedge("b", "a")];
    expect(tidyLayout(nodes, edges)).toEqual(nodes);
  });

  it("orphans land in row 0 alongside entries", () => {
    const nodes = [tnode("a", 0, 0), tnode("lone", 300, 700)];
    const pos = Object.fromEntries(tidyLayout(nodes, []).map((n) => [n.id, n.position]));
    expect(pos.a.y).toBe(0);
    expect(pos.lone.y).toBe(0);
    expect(pos.a.x).toBe(-TIDY_COL_GAP / 2);
    expect(pos.lone.x).toBe(TIDY_COL_GAP / 2);
  });
});

describe("reconnectAllowed", () => {
  // a → b → c (flow), r reviews c with a loop back to a
  const flowAB = tedge("a", "b");
  const flowBC = tedge("b", "c");
  const loopRA = loopEdge("r", "a", 2, "gated");
  const flowCR = tedge("c", "r");
  const all = [flowAB, flowBC, flowCR, loopRA];

  it("rejects self-connections", () => {
    expect(reconnectAllowed(flowAB, { source: "a", target: "a" }, all)).toBe(false);
  });

  it("allows re-routing a flow edge to a new valid target", () => {
    expect(reconnectAllowed(flowBC, { source: "b", target: "r" }, all)).toBe(true); // b→r is new and acyclic
  });

  it("rejects a duplicate of an existing flow edge", () => {
    expect(reconnectAllowed(flowBC, { source: "a", target: "b" }, all)).toBe(false);
  });

  it("rejects a re-route that closes a cycle", () => {
    // re-routing a→b into c→a would make a → b → c → a
    expect(reconnectAllowed(flowAB, { source: "c", target: "a" }, all)).toBe(false);
  });

  it("allows reversing an isolated edge (no cycle through others)", () => {
    const only = [flowAB];
    expect(reconnectAllowed(flowAB, { source: "b", target: "a" }, only)).toBe(true);
  });

  it("loop edges: the review end stays fixed", () => {
    expect(reconnectAllowed(loopRA, { source: "b", target: "a" }, all)).toBe(false);
  });

  it("loop edges: new return target must be a flow-ancestor of the review", () => {
    expect(reconnectAllowed(loopRA, { source: "r", target: "b" }, all)).toBe(true);  // b is upstream of r
    expect(reconnectAllowed(loopRA, { source: "r", target: "x" }, all)).toBe(false); // x is not
  });
});
