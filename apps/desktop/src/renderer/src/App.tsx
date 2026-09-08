import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tree } from 'web-tree-sitter';
import { Editor } from './components/Editor';
import { Viewport, type GizmoCommitValue, type GizmoMode, type NodeMesh } from './components/Viewport';
import { parseScad } from './scadParser';
import { buildSceneGraph, nodeSource, type SceneNode } from './sceneGraph';
import { patchTranslate, patchRotate, patchScale, getPivotOrigin } from './targetedPatch';
import { appendPrimitive, type PrimitiveKind } from './primitives';
import { createCoalescingRunner } from './coalescingRunner';

const PRIMITIVE_BUTTONS: { kind: PrimitiveKind; label: string }[] = [
  { kind: 'cube', label: 'Cube' },
  { kind: 'sphere', label: 'Sphere' },
  { kind: 'cylinder', label: 'Cylinder' },
  { kind: 'square', label: 'Square' },
  { kind: 'circle', label: 'Circle' },
];

const GIZMO_MODE_BUTTONS: { mode: GizmoMode; label: string }[] = [
  { mode: 'translate', label: 'Move' },
  { mode: 'rotate', label: 'Rotate' },
  { mode: 'scale', label: 'Scale' },
];

const DEFAULT_SOURCE = `// scadstudio M5 — drag the gizmo (Move/Rotate/Scale), insert primitives, or click to select
module bracket(w=20, h=10, thickness=3) {
    difference() {
        cube([w, h, thickness]);
        translate([thickness, thickness, -1])
            cube([w - 2 * thickness, h - 2 * thickness, thickness + 2]);
    }
}

bracket(30, 15, 4);

translate([0, 0, 10])
    cylinder(h=20, r=5, $fn=32);

translate([40, 0, 0])
    sphere(r=8);
`;

// Debounce window before a text edit triggers re-parse + re-render. See
// PLAN.md's render latency benchmark: full-document renders can take ~1.2s,
// so this is paired with a coalescing runner (only the latest text ever
// renders, no per-keystroke pile-up) rather than relying on debounce alone.
const RENDER_DEBOUNCE_MS = 400;

export function App() {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [sceneNodes, setSceneNodes] = useState<SceneNode[]>([]);
  const [nodeMeshes, setNodeMeshes] = useState<NodeMesh[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [status, setStatus] = useState('Rendering...');
  const [parseErrorCount, setParseErrorCount] = useState<number | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set right before an insertion-triggered render so that render's own
  // selection-preserving logic (below) knows to select the newly-appended
  // node instead of trying to preserve whatever was selected before.
  const pendingSelectLast = useRef(false);
  // Latest parsed tree + inputs to it, kept outside React state: the gizmo
  // commit handler (targetedPatch) needs the CST that matches the *currently
  // displayed* source to locate a node's translate() call, but doesn't want
  // to be recreated on every keystroke just to close over fresh state.
  const treeRef = useRef<Tree | null>(null);
  const sourceRef = useRef(source);
  const sceneNodesRef = useRef<SceneNode[]>([]);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);
  useEffect(() => {
    sceneNodesRef.current = sceneNodes;
  }, [sceneNodes]);

  const runRender = useMemo(
    () =>
      createCoalescingRunner(async (src: string) => {
        setStatus('Rendering...');
        try {
          const { tree, errorCount } = await parseScad(src);
          treeRef.current = tree;
          setParseErrorCount(errorCount);
          const graph = buildSceneGraph(tree, src);
          setSceneNodes(graph.nodes);

          // Isolated per-node renders (M3 scope: one call per top-level
          // statement, sequential — see PLAN.md M3 build notes on why this
          // stays simple rather than the full render-worker job queue).
          const meshes: NodeMesh[] = [];
          for (const node of graph.nodes) {
            try {
              const bytes = await window.scadstudio.renderScad(nodeSource(graph, node, src));
              meshes.push({ index: node.index, bytes, pivot: getPivotOrigin(tree.rootNode, node) });
            } catch (err) {
              console.error(`[scadstudio] node ${node.index} render failed`, err);
            }
          }
          setNodeMeshes(meshes);
          if (pendingSelectLast.current) {
            pendingSelectLast.current = false;
            setSelectedIndex(graph.nodes.length > 0 ? graph.nodes.length - 1 : null);
          } else {
            setSelectedIndex((prev) => (prev !== null && prev < graph.nodes.length ? prev : null));
          }
          setStatus(meshes.length === graph.nodes.length ? 'Rendered' : `Rendered ${meshes.length}/${graph.nodes.length} nodes`);
        } catch (err) {
          setStatus(`Render failed: ${(err as Error).message}`);
          console.error('[scadstudio] render failed', err);
        }
      }),
    [],
  );

  useEffect(() => {
    runRender(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSourceChange = useCallback(
    (next: string) => {
      setSource(next);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => runRender(next), RENDER_DEBOUNCE_MS);
    },
    [runRender],
  );

  const handleOpen = useCallback(async () => {
    const result = await window.scadstudio.openFile();
    if (!result) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setFilePath(result.filePath);
    setSource(result.contents);
    runRender(result.contents);
  }, [runRender]);

  // M4/M5: gizmo drag-end -> targeted patch -> same re-parse/re-render
  // pipeline as a text edit (one derivation path, not two — see PLAN.md
  // "Visual edit path"). Dragging itself never reaches here; only the
  // drag-end value does, which is what makes skip-WASM-during-drag free.
  const handleTransformCommit = useCallback(
    (index: number, mode: GizmoMode, value: GizmoCommitValue) => {
      const tree = treeRef.current;
      const node = sceneNodesRef.current.find((n) => n.index === index);
      if (!tree || !node) return;
      const patched =
        mode === 'rotate'
          ? patchRotate(sourceRef.current, tree, node, value as [number, number, number, number])
          : mode === 'scale'
            ? patchScale(sourceRef.current, tree, node, value as [number, number, number])
            : patchTranslate(sourceRef.current, tree, node, value as [number, number, number]);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(patched);
      runRender(patched);
    },
    [runRender],
  );

  // M5: toolbar primitive insertion, reusing the same targeted-patch +
  // re-render pipeline as every other edit path.
  const handleInsertPrimitive = useCallback(
    (kind: PrimitiveKind) => {
      const next = appendPrimitive(sourceRef.current, kind);
      pendingSelectLast.current = true;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(next);
      runRender(next);
    },
    [runRender],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'sans-serif' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '6px 12px',
          background: '#1e1e1e',
          color: '#ccc',
          fontSize: 13,
          borderBottom: '1px solid #333',
        }}
      >
        <button onClick={handleOpen}>Open .scad file...</button>
        <span>{filePath ?? '(unsaved default example)'}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
          {parseErrorCount ? `${parseErrorCount} parse error(s) — ` : ''}
          {status}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '6px 12px',
          background: '#252526',
          color: '#ccc',
          fontSize: 12,
          borderBottom: '1px solid #333',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Insert:
          {PRIMITIVE_BUTTONS.map(({ kind, label }) => (
            <button key={kind} onClick={() => handleInsertPrimitive(kind)}>
              {label}
            </button>
          ))}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Gizmo:
          {GIZMO_MODE_BUTTONS.map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => setGizmoMode(mode)}
              style={{ fontWeight: gizmoMode === mode ? 'bold' : 'normal' }}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Editor
            value={source}
            onChange={handleSourceChange}
            nodes={sceneNodes}
            selectedIndex={selectedIndex}
            onSelectNode={setSelectedIndex}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid #333' }}>
          <Viewport
            meshes={nodeMeshes}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            gizmoMode={gizmoMode}
            onTransformCommit={handleTransformCommit}
          />
        </div>
      </div>
    </div>
  );
}
