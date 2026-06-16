import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type StageNode as StageNodeT,
  type StageEdge,
  type StageNodeData,
} from "./builder/graph";

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

  const patchData = useCallback(
    (id: string, partial: Partial<StageNodeData>) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...partial } } : n)));
      // Changing a stage out of a review archetype strips its now-invalid loop.
      if (partial.role !== undefined && !isReviewArchetype(partial.role)) {
        setEdges((es) => es.filter((e) => !(e.data?.kind === "loop" && e.source === id)));
      }
    },
    [setNodes, setEdges],
  );

  const addNode = useCallback(
    (role: string, position?: { x: number; y: number }) => {
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
    [rf, setNodes],
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
      setEdges((es) => es.concat(edge));
    },
    [edges, setEdges],
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
      return true;
    },
    [nodes.length],
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      if (selectedId && deleted.some((n) => n.id === selectedId)) setSelectedId(null);
    },
    [selectedId],
  );

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

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
      setEdges((es) => {
        const withoutLoop = es.filter((e) => !(e.data?.kind === "loop" && e.source === selectedId));
        if (!next.target) return withoutLoop;
        return withoutLoop.concat(loopEdge(selectedId, next.target, next.max, next.mode));
      });
    },
    [selectedId, setEdges],
  );

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

      <div ref={wrapperRef} className="octo-flow relative min-h-0 flex-1" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        {/* The provider must wrap ReactFlow so the custom node components it
            renders can read validation / selection / the remove handler. */}
        <BuilderProvider
          value={{ validation: validation.byNode, selectedId, onRemove: removeNode, canRemove: nodes.length > 1 }}
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
            <Controls showInteractive={false} className="octo-flow-controls" />
            <MiniMap
              pannable
              zoomable
              className="octo-flow-minimap"
              maskColor="rgba(12,10,8,0.72)"
              nodeColor={() => tokens.hairline}
              nodeStrokeColor={() => tokens.brassDim}
            />
            <Panel position="top-left">
              <NodePalette
                onAdd={addNode}
                onNewRole={() => setEditorState({})}
              />
            </Panel>
            {selectedNode && (
              <Panel position="top-right" className="!m-3 max-h-[calc(100%-1.5rem)]">
                <StageInspector
                  key={selectedNode.id}
                  node={selectedNode}
                  ancestors={loopTargets}
                  loop={loopState}
                  issue={validation.byNode[selectedNode.id]}
                  onPatch={(p) => patchData(selectedNode.id, p)}
                  onSetLoop={setLoop}
                  onClose={() => setSelectedId(null)}
                />
              </Panel>
            )}
          </ReactFlow>
        </BuilderProvider>
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
