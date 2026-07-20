import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Node,
  type OnBeforeDelete,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Undo2, Redo2, Network } from "lucide-react";
import type { PipelineWithStages, Role } from "../lib/ipc";
import { usePipelineStore } from "../stores/pipelineStore";
import { useRolesStore } from "../stores/rolesStore";
import { RoleEditor } from "./RoleEditor";
import { tokens } from "../lib/tokens";
import { StageNode } from "./builder/StageNode";
import { FlowEdge, LoopEdge } from "./builder/edges";
import { NodePalette, ARCHETYPE_DND_MIME } from "./builder/NodePalette";
import { StageInspector, type LoopState } from "./builder/StageInspector";
import { BuilderProvider } from "./builder/BuilderContext";
import {
  draftToGraph,
  graphToStageDrafts,
  validateGraph,
  newStageData,
  newId,
  loopEdge,
  flowAncestors,
  isReviewArchetype,
  stageLabel,
  tidyLayout,
  type StageNode as StageNodeT,
  type StageEdge,
  type StageNodeData,
} from "./builder/graph";
import {
  createHistory,
  pushSnapshot,
  undo as undoHistory,
  redo as redoHistory,
  canUndo,
  canRedo,
  type GraphSnapshot,
} from "./builder/history";

const nodeTypes = { stage: StageNode };
const edgeTypes = { flow: FlowEdge, loop: LoopEdge };
const defaultEdgeOptions = {
  markerEnd: { type: MarkerType.ArrowClosed, color: tokens.brass, width: 14, height: 14 },
};

interface Props {
  /** null = compose a new pipeline; a loaded pipeline = edit (builtins fork on save). */
  pipeline: PipelineWithStages | null;
  onClose: () => void;
}

export function PipelineBuilder(props: Props) {
  // screenToFlowPosition / deleteElements need the provider context.
  return (
    <ReactFlowProvider>
      <BuilderInner {...props} />
    </ReactFlowProvider>
  );
}

function BuilderInner({ pipeline, onClose }: Props) {
  const isBuiltin = pipeline?.pipeline.isBuiltin ?? false;
  const save = usePipelineStore((s) => s.save);
  const remove = usePipelineStore((s) => s.remove);

  // Load roles so the palette and graph derive from live data.
  useEffect(() => {
    void useRolesStore.getState().load();
  }, []);
  const rf = useReactFlow<StageNodeT, StageEdge>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [tidying, setTidying] = useState(false);

  // The minimap is a luxury; below this canvas width it yields the corner.
  const MINIMAP_MIN_CANVAS = 560;
  const [canvasWidth, setCanvasWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setCanvasWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const miniMapShown = canvasWidth >= MINIMAP_MIN_CANVAS;

  const [name, setName] = useState(() =>
    pipeline ? (isBuiltin ? `${pipeline.pipeline.name} (custom)` : pipeline.pipeline.name) : "",
  );
  const [description, setDescription] = useState(pipeline?.pipeline.description ?? "");

  const initial = useMemo(() => draftToGraph(pipeline), [pipeline]);
  const [nodes, setNodes, onNodesChange] = useNodesState<StageNodeT>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StageEdge>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Cascades click-to-add nodes so repeated palette clicks don't stack at one point.
  const addCascade = useRef(0);

  // Role Editor state: null = closed; { initial?: Role } = open (new or fork).
  const [editorState, setEditorState] = useState<{ initial?: Role } | null>(null);

  const validation = useMemo(() => validateGraph(nodes, edges), [nodes, edges]);

  // Latest graph refs so history callbacks never capture stale state.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const historyRef = useRef(createHistory());
  const [, bumpHistory] = useReducer((c: number) => c + 1, 0);

  const pushHistory = useCallback((key: string | null = null) => {
    historyRef.current = pushSnapshot(
      historyRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
      key,
    );
    bumpHistory();
  }, []);

  const applySnapshot = useCallback(
    (snap: GraphSnapshot) => {
      setNodes(snap.nodes);
      setEdges(snap.edges);
      setSelectedId((id) => (id && snap.nodes.some((n) => n.id === id) ? id : null));
    },
    [setNodes, setEdges],
  );

  const applyUndo = useCallback(() => {
    const r = undoHistory(historyRef.current, { nodes: nodesRef.current, edges: edgesRef.current });
    if (!r) return;
    historyRef.current = r.stack;
    applySnapshot(r.restored);
    bumpHistory();
  }, [applySnapshot]);

  const applyRedo = useCallback(() => {
    const r = redoHistory(historyRef.current, { nodes: nodesRef.current, edges: edgesRef.current });
    if (!r) return;
    historyRef.current = r.stack;
    applySnapshot(r.restored);
    bumpHistory();
  }, [applySnapshot]);

  const runTidy = useCallback(() => {
    pushHistory();
    setTidying(true);
    setNodes((ns) => tidyLayout(ns, edgesRef.current));
    // Let the position transition play, then settle the viewport on the result.
    window.setTimeout(() => {
      setTidying(false);
      void rf.fitView({ padding: 0.25, maxZoom: 1, duration: 280 });
    }, 300);
  }, [pushHistory, setNodes, rf]);

  const patchData = useCallback(
    (id: string, partial: Partial<StageNodeData>) => {
      pushHistory(`patch:${id}:${Object.keys(partial).sort().join("+")}`);
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...partial } } : n)));
      // Changing a stage out of a review archetype strips its now-invalid loop.
      if (partial.role !== undefined && !isReviewArchetype(partial.role)) {
        setEdges((es) => es.filter((e) => !(e.data?.kind === "loop" && e.source === id)));
      }
    },
    [setNodes, setEdges, pushHistory],
  );

  const addNode = useCallback(
    (role: string, position?: { x: number; y: number }) => {
      pushHistory();
      const pos =
        position ??
        (() => {
          const rect = wrapperRef.current?.getBoundingClientRect();
          if (!rect) return { x: 0, y: 0 };
          const center = rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          const k = addCascade.current++ % 6; // step each click-add off the center
          return { x: center.x + k * 30, y: center.y + k * 30 };
        })();
      const node: StageNodeT = { id: newId(), type: "stage", position: pos, data: newStageData(role) };
      setNodes((ns) => ns.concat(node));
      setSelectedId(node.id);
    },
    [rf, setNodes, pushHistory],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const flow = edges.filter((e) => (e.data?.kind ?? "flow") === "flow");
      // No duplicate edge, and never close a cycle (target already reaches source).
      const exists = flow.some((e) => e.source === c.source && e.target === c.target);
      if (exists) return;
      if (flowAncestors(c.source, flow).has(c.target)) return;
      const edge: StageEdge = {
        id: `f-${c.source}-${c.target}`,
        source: c.source,
        target: c.target,
        type: "flow",
        data: { kind: "flow" },
      };
      pushHistory();
      setEdges((es) => es.concat(edge));
    },
    [edges, setEdges, pushHistory],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const role = e.dataTransfer.getData(ARCHETYPE_DND_MIME);
      if (!role) return;
      addNode(role, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [addNode, rf],
  );

  const removeNode = useCallback(
    (id: string) => {
      void rf.deleteElements({ nodes: [{ id }] });
    },
    [rf],
  );

  // Guard the last node: a pipeline must keep at least one stage.
  const onBeforeDelete: OnBeforeDelete<StageNodeT, StageEdge> = useCallback(
    async ({ nodes: toDelete }) => {
      if (toDelete.length > 0 && nodes.length - toDelete.length < 1) return false;
      pushHistory();
      return true;
    },
    [nodes.length, pushHistory],
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      if (selectedId && deleted.some((n) => n.id === selectedId)) setSelectedId(null);
    },
    [selectedId],
  );

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  // The dock keeps its content mounted through the close animation; the
  // rendered node lags selection by one width transition when closing.
  const [dockNode, setDockNode] = useState<StageNodeT | null>(null);
  useEffect(() => {
    if (selectedNode) setDockNode(selectedNode);
  }, [selectedNode]);
  const dockOpen = selectedNode !== null;

  // The selected review stage's loop, derived from its loop edge.
  const loopEdgeForSelected = selectedId
    ? edges.find((e) => e.data?.kind === "loop" && e.source === selectedId)
    : undefined;
  const loopState: LoopState = {
    target: loopEdgeForSelected?.target ?? null,
    max: loopEdgeForSelected?.data?.loopMax ?? 2,
    mode: loopEdgeForSelected?.data?.loopMode ?? "gated",
  };

  // Valid loop targets for the inspector: the selected node's flow-ancestors.
  const loopTargets = useMemo(() => {
    if (!selectedNode) return [];
    const flow = edges.filter((e) => (e.data?.kind ?? "flow") === "flow");
    const ancestors = flowAncestors(selectedNode.id, flow);
    return nodes
      .filter((n) => ancestors.has(n.id))
      .map((n) => ({ value: n.id, label: stageLabel(n.data) }));
  }, [selectedNode, nodes, edges]);

  const setLoop = useCallback(
    (next: LoopState) => {
      if (!selectedId) return;
      pushHistory(`loop:${selectedId}`);
      setEdges((es) => {
        const withoutLoop = es.filter((e) => !(e.data?.kind === "loop" && e.source === selectedId));
        if (!next.target) return withoutLoop;
        return withoutLoop.concat(loopEdge(selectedId, next.target, next.max, next.mode));
      });
    },
    [selectedId, setEdges, pushHistory],
  );

  // Escape closes the dock — but not while the Role Editor modal is up;
  // ModalShell owns Escape there. Also handles ⌘Z/⇧⌘Z, suppressed while typing.
  const editorOpenRef = useRef(false);
  editorOpenRef.current = editorState !== null;
  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editorOpenRef.current) {
        setSelectedId(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !isEditable(e.target)) {
        e.preventDefault();
        if (e.shiftKey) applyRedo();
        else applyUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyUndo, applyRedo]);

  const firstBlocking = validation.blocking[0]?.message ?? null;
  const warnCount = validation.warnings.length;

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const stages = graphToStageDrafts(nodes, edges);
      await save({
        pipelineId: pipeline?.pipeline.id ?? null, // the backend forks builtins
        name: name.trim(),
        description: description.trim(),
        stages,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!pipeline) return;
    try {
      await remove(pipeline.pipeline.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const canSave = !saving && name.trim().length > 0 && validation.ok;

  return (
    <div className="flex min-h-0 flex-1 flex-col octo-fade-in">
      <div className="px-8 pt-6 pb-3">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">direct · builder</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this pipeline"
          aria-label="Pipeline name"
          className="mb-1 w-full border-b border-transparent bg-transparent pb-1 font-serif text-[22px] tracking-[-0.005em] text-octo-ivory outline-none transition-colors duration-[180ms] placeholder:font-serif placeholder:text-octo-mute hover:border-octo-hairline focus:border-[var(--brass-dim)]"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When should the team reach for it?"
          aria-label="Pipeline description"
          className="w-full border-b border-transparent bg-transparent pb-1 font-mono text-xs text-octo-sage outline-none transition-colors duration-[180ms] placeholder:text-octo-mute hover:border-octo-hairline focus:border-[var(--brass-dim)]"
        />
      </div>

      <div className="flex min-h-0 flex-1">
        <div ref={wrapperRef} className={`octo-flow relative min-h-0 flex-1 ${tidying ? "octo-flow--tidying" : ""}`} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
          {/* The provider must wrap ReactFlow so the custom node components it
              renders can read validation / selection / the remove handler. */}
          <BuilderProvider
            value={{
              validation: validation.byNode,
              selectedId,
              onRemove: removeNode,
              canRemove: nodes.length > 1,
              // TODO(task 10): wire real disconnect handling; grep for this stub.
              onDisconnect: () => {},
            }}
          >
            <ReactFlow<StageNodeT, StageEdge>
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onBeforeDelete={onBeforeDelete}
              onNodesDelete={onNodesDelete}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              onNodeDragStart={() => pushHistory()}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              defaultEdgeOptions={defaultEdgeOptions}
              minZoom={0.4}
              maxZoom={1.75}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              proOptions={{ hideAttribution: true }}
              className="bg-transparent"
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--brass-faint)" />
              <Controls
                showInteractive={false}
                position="bottom-right"
                className={`octo-flow-controls !mr-4 transition-[margin] duration-[280ms] ${
                  miniMapShown ? "!mb-[178px]" : "!mb-4"
                }`}
              />
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                className={`octo-flow-minimap !m-4 transition-opacity duration-[220ms] ${
                  miniMapShown ? "" : "pointer-events-none opacity-0"
                }`}
                maskColor={`${tokens.onyx}b8`}
                nodeColor={() => tokens.hairline}
                nodeStrokeColor={() => tokens.brassDim}
              />
              <Panel position="top-left">
                <NodePalette
                  open={paletteOpen}
                  onToggle={() => setPaletteOpen((v) => !v)}
                  onAdd={addNode}
                  onNewRole={() => setEditorState({})}
                  onEditRole={(role) => setEditorState({ initial: role })}
                />
              </Panel>
              <Panel position="top-right" className="!m-3">
                <div className="octo-fade-in flex items-center gap-1 rounded-lg border border-octo-hairline bg-octo-panel/95 p-1 backdrop-blur-sm">
                  <button
                    type="button"
                    aria-label="Undo (⌘Z)"
                    title="Undo (⌘Z)"
                    disabled={!canUndo(historyRef.current)}
                    onClick={applyUndo}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-octo-sage transition-colors duration-[150ms] hover:text-octo-brass disabled:opacity-30"
                  >
                    <Undo2 size={13} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label="Redo (⇧⌘Z)"
                    title="Redo (⇧⌘Z)"
                    disabled={!canRedo(historyRef.current)}
                    onClick={applyRedo}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-octo-sage transition-colors duration-[150ms] hover:text-octo-brass disabled:opacity-30"
                  >
                    <Redo2 size={13} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label="Tidy layout"
                    title="Tidy layout — arrange stages on a clean grid"
                    onClick={runTidy}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-octo-sage transition-colors duration-[150ms] hover:text-octo-brass"
                  >
                    <Network size={13} strokeWidth={1.75} />
                  </button>
                </div>
              </Panel>
            </ReactFlow>
          </BuilderProvider>
        </div>

        {/* Stage dock — outside the flow's overflow, so it can never clip. */}
        <div
          data-testid="stage-dock"
          data-open={dockOpen}
          aria-hidden={!dockOpen}
          onTransitionEnd={() => {
            if (!dockOpen) setDockNode(null);
          }}
          className={`shrink-0 overflow-hidden border-l bg-octo-panel transition-[width,border-color] duration-[280ms] ease-[var(--ease-octo)] ${
            dockOpen ? "w-[320px] border-octo-hairline" : "w-0 border-transparent"
          }`}
        >
          {dockNode && (
            <div className="h-full w-[320px]" inert={!dockOpen}>
              <StageInspector
                key={dockNode.id}
                node={dockNode}
                ancestors={loopTargets}
                loop={loopState}
                issue={validation.byNode[dockNode.id]}
                onPatch={(p) => patchData(dockNode.id, p)}
                onSetLoop={setLoop}
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-octo-hairline bg-octo-panel px-8 py-3">
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void onSave()}
          className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi disabled:opacity-40"
        >
          {isBuiltin ? "Save as my copy" : "Save pipeline"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage"
        >
          Cancel
        </button>

        {/* Live validation read-out: the first blocker, else the first caution
            (stated, not just counted), else a ready note. */}
        <div className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {error ? (
            <span className="text-octo-rouge">{error}</span>
          ) : firstBlocking ? (
            <span className="text-octo-rouge" title={firstBlocking}>
              {firstBlocking}
            </span>
          ) : warnCount > 0 ? (
            <span className="text-octo-warning" title={validation.warnings.map((w) => w.message).join("\n")}>
              {validation.warnings[0].message}
              {warnCount > 1 ? ` (+${warnCount - 1} more)` : ""}
            </span>
          ) : (
            <span className="text-octo-mute">{nodes.length === 1 ? "1 stage" : `${nodes.length} stages`} · ready</span>
          )}
        </div>

        {/* Role editor — mounts as a ModalShell portal above the builder */}
        {editorState !== null && (
          <RoleEditor
            initial={editorState.initial}
            onSaved={() => {
              // Refresh role store so palette reflects the new role immediately.
              void useRolesStore.getState().load();
              setEditorState(null);
            }}
            onClose={() => setEditorState(null)}
          />
        )}

        {pipeline && !isBuiltin &&
          (confirmingDelete ? (
            <button
              type="button"
              onClick={() => void onDelete()}
              className="rounded-md border border-octo-rouge px-3 py-2 font-mono text-xs text-octo-rouge"
            >
              Confirm delete?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-md border border-octo-hairline px-3 py-2 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-rouge"
            >
              Delete
            </button>
          ))}
      </div>
    </div>
  );
}
