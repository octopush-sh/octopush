// Pure graph logic for the node-based Direct pipeline builder.
//
// The builder edits a DAG of stage nodes plus explicit loop back-edges. None of
// this file touches React or @xyflow at runtime (only their *types*), so every
// function here is unit-testable in isolation. The two boundaries that matter:
//
//   • `graphToStageDrafts` — compile the canvas graph into the position-based
//     `StageDraft[]` the backend executes (topological sort → positions +
//     parents + loop derivation).
//   • `draftToGraph` — reopen a saved pipeline as nodes + edges, restoring the
//     drawn layout (or auto-laying-out a legacy linear pipeline).
//
// The archetype table is the operability contract: it fixes the artifact a
// stage emits and whether it can loop, while leaving model, tools, name, and
// instructions to the author.

import type { Node, Edge } from "@xyflow/react";
import type { AgentSubstrate, PipelineWithStages, PipelineStage, Role, StageDraft } from "../../lib/ipc";

// ─── Tools ────────────────────────────────────────────────────────────────
// Keep in sync with KNOWN_TOOLS in src-tauri/src/db.rs and tool_definitions().

export interface ToolMeta {
  id: string;
  label: string;
  /** One-line tooltip describing what granting this tool lets the stage do. */
  hint: string;
  /** True for tools that mutate the workspace (write/run). */
  writes: boolean;
}

export const TOOLS: ToolMeta[] = [
  { id: "read_file", label: "Read", hint: "Read file contents in the workspace", writes: false },
  { id: "list_files", label: "List", hint: "List files and directories", writes: false },
  { id: "write_file", label: "Write", hint: "Create or overwrite files", writes: true },
  { id: "run_command", label: "Run", hint: "Run shell commands (tests, git, build)", writes: true },
];

const TOOL_IDS = TOOLS.map((t) => t.id);

// ─── Archetypes ─────────────────────────────────────────────────────────────
// Roles are loaded from the backend `roles` table via listRoles()/setArchetypes().

export type ArtifactKind = "plan" | "review" | "diff" | "tests" | "note";

export interface Archetype {
  role: string;
  label: string;
  /** What this stage hands downstream — the dossier slot it fills. */
  artifact: ArtifactKind;
  /** Review archetypes may carry a loop back-edge to an ancestor. */
  canLoop: boolean;
  /** Sensible starting tool set for a *new* node of this archetype. */
  defaultTools: string[];
  /** One-line description for the palette + inspector tooltip. */
  description: string;
}

/** Convert a Role (from the DB / IPC) into an Archetype for builder use. */
export function archetypeFromRole(r: Role): Archetype {
  return {
    role: r.key,
    label: r.label,
    artifact: r.artifactKind,
    canLoop: r.canLoop,
    defaultTools: r.defaultTools,
    description: r.description,
  };
}

/** Module-level cache, populated by rolesStore after loading from the backend. */
let LOADED: Archetype[] = [];

/** Called by rolesStore.load() once roles arrive from the backend. */
export function setArchetypes(roles: Role[]): void {
  LOADED = roles.map(archetypeFromRole);
}

/** All currently-loaded archetypes (empty until rolesStore.load() resolves). */
export function archetypes(): Archetype[] {
  return LOADED;
}

/** Look up an archetype by role key.
 *  Returns a minimal safe default when LOADED is empty (pre-load) or the key
 *  is unknown — never returns undefined so callers don't need to null-check. */
export function archetypeFor(role: string): Archetype {
  return (
    LOADED.find((a) => a.role === role) ?? {
      role,
      label: role,
      artifact: "note" as ArtifactKind,
      canLoop: false,
      defaultTools: [],
      description: "",
    }
  );
}


export function isReviewArchetype(role: string): boolean {
  return archetypeFor(role).canLoop;
}

/** The display label for a node: the author's custom name, else the archetype. */
export function stageLabel(data: StageNodeData): string {
  const custom = data.customName?.trim();
  return custom && custom.length > 0 ? custom : archetypeFor(data.role).label;
}

// ─── Node + edge shapes ──────────────────────────────────────────────────────

export interface StageNodeData {
  role: string;
  customName: string | null;
  agentModel: string;
  substrate: AgentSubstrate;
  checkpoint: boolean;
  maxIterations: number;
  /** Tool allowlist; null = the full workspace set (also the legacy default). */
  tools: string[] | null;
  instructions: string | null;
  // @xyflow requires node data to be an index signature record.
  [key: string]: unknown;
}

export type StageNode = Node<StageNodeData, "stage">;

export interface EdgeData {
  kind: "flow" | "loop";
  /** Loop edges only: the review's loop-back cap and mode. */
  loopMax?: number;
  loopMode?: "gated" | "auto";
  [key: string]: unknown;
}

export type StageEdge = Edge<EdgeData>;

export const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Auto-layout constants for legacy pipelines (no saved coordinates).
const COLUMN_X = 0;
const ROW_GAP = 150;

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/** Fresh node data for a newly-dropped archetype. New nodes get explicit
 *  archetype-default tools (so a review starts read-only); legacy/loaded nodes
 *  may keep `tools: null` meaning "the full set", preserving old behavior. */
export function newStageData(role: string): StageNodeData {
  const a = archetypeFor(role);
  return {
    role,
    customName: null,
    agentModel: DEFAULT_MODEL,
    substrate: "api",
    checkpoint: false,
    maxIterations: DEFAULT_MAX_TURNS,
    tools: [...a.defaultTools],
    instructions: null,
  };
}

function flowEdge(source: string, target: string): StageEdge {
  return { id: `f-${source}-${target}`, source, target, type: "flow", data: { kind: "flow" } };
}

export function loopEdge(source: string, target: string, loopMax: number, loopMode: "gated" | "auto"): StageEdge {
  return { id: `l-${source}-${target}`, source, target, type: "loop", data: { kind: "loop", loopMax, loopMode } };
}

function dataFromStage(s: PipelineStage): StageNodeData {
  return {
    role: s.role,
    customName: s.customName ?? null,
    agentModel: s.agentModel,
    substrate: s.substrate,
    checkpoint: s.checkpoint,
    maxIterations: s.maxIterations ?? DEFAULT_MAX_TURNS,
    tools: s.tools ?? null,
    instructions: s.instructions ?? null,
  };
}

// ─── Topological order ───────────────────────────────────────────────────────

/** Kahn topological sort over the flow edges. Ties (independent stages ready at
 *  once) break by canvas Y then X then id, so a graph reads top-to-bottom /
 *  left-to-right and the ordering is deterministic. Throws on a cycle. */
function topoOrder(nodes: StageNode[], flow: StageEdge[]): StageNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of flow) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    out.get(e.source)!.push(e.target);
  }
  const cmp = (a: string, b: string): number => {
    const na = byId.get(a)!;
    const nb = byId.get(b)!;
    return (na.position.y - nb.position.y) || (na.position.x - nb.position.x) || (a < b ? -1 : a > b ? 1 : 0);
  };
  const ready = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id).sort(cmp);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const t of out.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 0) - 1);
      if ((indeg.get(t) ?? 0) === 0) {
        ready.push(t);
        ready.sort(cmp);
      }
    }
  }
  if (order.length !== nodes.length) {
    throw new Error("the pipeline flow has a cycle — remove a backward link");
  }
  return order.map((id) => byId.get(id)!);
}

/** Transitive flow-ancestors of `nodeId` (excludes itself). Exported so the
 *  builder can list valid loop targets and reject cycle-forming connections. */
export function flowAncestors(nodeId: string, flow: StageEdge[]): Set<string> {
  const parentsOf = new Map<string, string[]>();
  for (const e of flow) {
    if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
    parentsOf.get(e.target)!.push(e.source);
  }
  const seen = new Set<string>();
  const stack = [...(parentsOf.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    stack.push(...(parentsOf.get(p) ?? []));
  }
  return seen;
}

// ─── Compile ⇄ load ──────────────────────────────────────────────────────────

/** Compile the canvas graph into the backend's position-based stage drafts.
 *  Throws if the flow has a cycle (the UI blocks save before this is called). */
export function graphToStageDrafts(nodes: StageNode[], edges: StageEdge[]): StageDraft[] {
  const flow = edges.filter((e) => (e.data?.kind ?? "flow") === "flow");
  const loops = edges.filter((e) => e.data?.kind === "loop");
  const ordered = topoOrder(nodes, flow);
  const pos = new Map(ordered.map((n, i) => [n.id, i]));

  return ordered.map((n) => {
    const d = n.data;
    const parents = flow
      .filter((e) => e.target === n.id)
      .map((e) => pos.get(e.source))
      .filter((p): p is number => p !== undefined)
      .sort((a, b) => a - b);
    const loop = loops.find((e) => e.source === n.id);
    const loopTargetPosition = loop ? pos.get(loop.target) ?? null : null;
    const hasLoop = loopTargetPosition !== null;
    const name = d.customName?.trim();
    const instr = d.instructions?.trim();
    return {
      role: d.role,
      agentModel: d.agentModel,
      substrate: d.substrate,
      checkpoint: d.checkpoint,
      loopTargetPosition: hasLoop ? loopTargetPosition : null,
      loopMaxIterations: hasLoop ? loop?.data?.loopMax ?? 2 : 0,
      loopMode: hasLoop ? loop?.data?.loopMode ?? "gated" : null,
      maxIterations: d.maxIterations,
      posX: n.position.x,
      posY: n.position.y,
      parents,
      // The CLI substrate owns its own tools, so a tool allowlist is meaningless
      // there — persist null rather than a list the runner silently ignores.
      tools: d.substrate === "cli" ? null : d.tools && d.tools.length > 0 ? d.tools : null,
      customName: name && name.length > 0 ? name : null,
      instructions: instr && instr.length > 0 ? instr : null,
    };
  });
}

/** Reopen a saved pipeline (or start a fresh one) as canvas nodes + edges.
 *  Restores drawn coordinates and the flow/loop topology; a legacy pipeline
 *  with no recorded parents/coordinates is auto-laid-out as a linear column. */
export function draftToGraph(pipeline: PipelineWithStages | null): { nodes: StageNode[]; edges: StageEdge[] } {
  if (!pipeline || pipeline.stages.length === 0) {
    const node: StageNode = { id: newId(), type: "stage", position: { x: COLUMN_X, y: 0 }, data: newStageData("implement") };
    return { nodes: [node], edges: [] };
  }

  const sorted = [...pipeline.stages].sort((a, b) => a.position - b.position);
  const idByPos = new Map<number, string>();
  const hasParents = sorted.some((s) => (s.parents?.length ?? 0) > 0);

  const nodes: StageNode[] = sorted.map((s, i) => {
    const id = newId();
    idByPos.set(s.position, id);
    const x = s.posX != null ? s.posX : COLUMN_X;
    const y = s.posY != null ? s.posY : i * ROW_GAP;
    return { id, type: "stage", position: { x, y }, data: dataFromStage(s) };
  });

  const edges: StageEdge[] = [];
  if (hasParents) {
    for (const s of sorted) {
      const targetId = idByPos.get(s.position)!;
      for (const p of s.parents ?? []) {
        const srcId = idByPos.get(p);
        if (srcId) edges.push(flowEdge(srcId, targetId));
      }
    }
  } else {
    // Legacy linear pipeline: chain each stage to the next.
    for (let i = 1; i < sorted.length; i++) {
      edges.push(flowEdge(idByPos.get(sorted[i - 1].position)!, idByPos.get(sorted[i].position)!));
    }
  }

  for (const s of sorted) {
    if (s.loopTargetPosition != null) {
      const srcId = idByPos.get(s.position)!;
      const tgtId = idByPos.get(s.loopTargetPosition);
      if (tgtId) edges.push(loopEdge(srcId, tgtId, s.loopMaxIterations || 2, s.loopMode ?? "gated"));
    }
  }

  return { nodes, edges };
}

// ─── Validation (the operability guarantee, mirrored from the backend) ────────

export interface GraphIssue {
  nodeId?: string;
  message: string;
}

export interface GraphValidation {
  /** Save is disabled while any blocking issue stands. */
  blocking: GraphIssue[];
  /** Non-blocking hints surfaced as amber badges + tooltips. */
  warnings: GraphIssue[];
  /** Per-node first error / first warning, for the node ring + tooltip. */
  byNode: Record<string, { error?: string; warning?: string }>;
  ok: boolean;
}

export function validateGraph(nodes: StageNode[], edges: StageEdge[]): GraphValidation {
  const blocking: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const byNode: Record<string, { error?: string; warning?: string }> = {};
  const addErr = (nodeId: string | undefined, message: string) => {
    blocking.push({ nodeId, message });
    if (nodeId && !byNode[nodeId]?.error) byNode[nodeId] = { ...byNode[nodeId], error: message };
  };
  const addWarn = (nodeId: string | undefined, message: string) => {
    warnings.push({ nodeId, message });
    if (nodeId && !byNode[nodeId]?.warning) byNode[nodeId] = { ...byNode[nodeId], warning: message };
  };

  if (nodes.length === 0) {
    blocking.push({ message: "Add at least one stage." });
    return { blocking, warnings, byNode, ok: false };
  }

  const flow = edges.filter((e) => (e.data?.kind ?? "flow") === "flow");
  const loops = edges.filter((e) => e.data?.kind === "loop");

  let acyclic = true;
  try {
    topoOrder(nodes, flow);
  } catch {
    acyclic = false;
    blocking.push({ message: "The flow has a cycle — remove a backward link." });
  }

  for (const n of nodes) {
    const a = archetypeFor(n.data.role);
    if (!n.data.agentModel || n.data.agentModel.trim() === "") {
      addErr(n.id, `${stageLabel(n.data)} has no model.`);
    } else if (n.data.substrate === "cli" && !/claude/i.test(n.data.agentModel)) {
      addWarn(n.id, `${stageLabel(n.data)} runs on the CLI (Claude Code) — pick a Claude model.`);
    }
    if (n.data.maxIterations < 1 || n.data.maxIterations > 100) {
      addErr(n.id, `${stageLabel(n.data)}: max turns must be 1–100.`);
    }
    if (n.data.tools && n.data.tools.length === 0) {
      addErr(n.id, `${stageLabel(n.data)} has no tools — grant it at least one.`);
    }
    if (n.data.tools) {
      for (const t of n.data.tools) {
        if (!TOOL_IDS.includes(t)) addErr(n.id, `${stageLabel(n.data)}: unknown tool "${t}".`);
      }
      // A code-producing archetype needs a way to change or run the workspace.
      if (a.artifact === "diff" && !n.data.tools.some((t) => t === "write_file")) {
        addWarn(n.id, `${stageLabel(n.data)} can't write files — it can describe changes but not make them.`);
      }
      if (a.artifact === "tests" && !n.data.tools.some((t) => t === "write_file" || t === "run_command")) {
        addWarn(n.id, `${stageLabel(n.data)} has no write or run tool — it can't author or run tests.`);
      }
    }

    // Orphan: a lone node in a multi-node graph that nothing links to or from.
    if (nodes.length > 1) {
      const connected = edges.some((e) => e.source === n.id || e.target === n.id);
      if (!connected) addWarn(n.id, `${stageLabel(n.data)} isn't connected to the pipeline.`);
    }
  }

  // Loop edges.
  const loopSources = new Map<string, number>();
  for (const e of loops) {
    loopSources.set(e.source, (loopSources.get(e.source) ?? 0) + 1);
  }
  for (const e of loops) {
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    if (!archetypeFor(src.data.role).canLoop) {
      addErr(e.source, `${stageLabel(src.data)} can't loop — only review stages may return work.`);
    }
    if ((loopSources.get(e.source) ?? 0) > 1) {
      addErr(e.source, `${stageLabel(src.data)} has more than one loop — keep a single return path.`);
    }
    if (acyclic) {
      const ancestors = flowAncestors(e.source, flow);
      if (!ancestors.has(e.target)) {
        addErr(e.source, `${stageLabel(src.data)}'s loop must return to an earlier stage on its own path.`);
      }
    }
    if (e.data?.loopMode === "auto") {
      addWarn(e.source, `${stageLabel(src.data)} loops automatically on a parsed verdict; it pauses for you if none is found.`);
    }
  }

  return { blocking, warnings, byNode, ok: blocking.length === 0 };
}
