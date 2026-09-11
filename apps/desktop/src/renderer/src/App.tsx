import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tree } from 'web-tree-sitter';
import { Editor } from './components/Editor';
import { Viewport, type GizmoMode, type NodeMesh, type RotateSpace } from './components/Viewport';
import { parseScad } from './scadParser';
import { buildSceneGraph, type SceneNode } from './sceneGraph';
import {
  patchTransform,
  primitiveSource,
  decomposeNode,
  primitiveArgs,
  patchArgument,
  wrapInBoolean,
  IDENTITY_TRANSFORM,
  type NodeTransform,
  type BooleanOp,
} from './targetedPatch';
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

// Only rotate gets a local/world toggle — translate is always world (moving
// "up" should mean world-up even for a rotated shape), and scale is always
// local (OpenSCAD's scale() can't express a world-axis stretch on a rotated
// shape without a multmatrix() shear, which isn't supported here).
const ROTATE_SPACE_BUTTONS: { space: RotateSpace; label: string }[] = [
  { space: 'local', label: 'Local' },
  { space: 'world', label: 'World' },
];

// Mirror is a toggle, not a drag — there's no continuous gesture that reads
// as "mirror this shape" the way translate/rotate/scale have one. Each
// button flips the sign of one axis of the selected node's current scale
// (mathematically identical to an axis-aligned mirror() through the local
// origin — see targetedPatch.ts's NodeTransform.scale comment).
const MIRROR_AXIS_BUTTONS: { axis: 0 | 1 | 2; label: string }[] = [
  { axis: 0, label: 'Mirror X' },
  { axis: 1, label: 'Mirror Y' },
  { axis: 2, label: 'Mirror Z' },
];

// M6: boolean ops need 2+ selected nodes (shift-click in the viewport to
// multi-select) — see wrapInBoolean's comment for why selection order
// (not document order) determines the generated block's child order.
const BOOLEAN_OP_BUTTONS: { op: BooleanOp; label: string }[] = [
  { op: 'union', label: 'Union' },
  { op: 'difference', label: 'Difference' },
  { op: 'intersection', label: 'Intersection' },
];

// The default color-input value (a plain HTML <input type="color">, no
// alpha support — matches decomposeNode/formatTransformPrefix's RGB-only
// scope) when a node has no color() wrap, i.e. it'll render at whatever
// material color the viewport defaults to.
const NO_COLOR_HEX = '#4a90d9';

function rgbToHex(rgb: [number, number, number] | null): string {
  if (!rgb) return NO_COLOR_HEX;
  const toHex = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

const DEFAULT_SOURCE = `// scadstudio — drag the gizmo (Move/Rotate/Scale), insert primitives, click
// to select, or shift-click to multi-select two+ shapes for a boolean op
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
  // Ordered by selection sequence (shift-click to add), not document order —
  // see Viewport.tsx's ViewportProps.selectedIndices comment. The last entry
  // is the "primary" selection that gizmo/mirror/color/parameter-panel
  // editing (all single-target operations) act on.
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const primarySelectedIndex = selectedIndices.length > 0 ? selectedIndices[selectedIndices.length - 1] : null;
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [rotateSpace, setRotateSpace] = useState<RotateSpace>('local');
  const [status, setStatus] = useState('Rendering...');
  const [parseErrorCount, setParseErrorCount] = useState<number | null>(null);
  // Reactive mirror of treeRef below, purely so the parameter panel (a
  // useMemo over tree+sceneNodes+selection) can recompute when a render
  // lands — treeRef itself is intentionally non-reactive so gizmo commits
  // don't get recreated on every keystroke (see its own comment).
  const [tree, setTree] = useState<Tree | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set right before an insertion-triggered render so that render's own
  // selection-preserving logic (below) knows to select the newly-appended
  // node instead of trying to preserve whatever was selected before.
  const pendingSelectLast = useRef(false);
  // Same idea, for edits that land at a *known* index rather than always the
  // last node — currently just the boolean-op merge (M6), whose result
  // always lands at the selected node with the smallest index (see
  // handleBooleanOp).
  const pendingSelectAfterEdit = useRef<number | null>(null);
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
          const { tree: parsedTree, errorCount } = await parseScad(src);
          treeRef.current = parsedTree;
          setTree(parsedTree);
          setParseErrorCount(errorCount);
          const graph = buildSceneGraph(parsedTree, src);
          setSceneNodes(graph.nodes);

          // Isolated per-node renders (M3 scope: one call per top-level
          // statement, sequential — see PLAN.md M3 build notes on why this
          // stays simple rather than the full render-worker job queue).
          const meshes: NodeMesh[] = [];
          for (const node of graph.nodes) {
            try {
              // Only the bare primitive goes to WASM — translate/rotate/
              // scale are applied as a real three.js transform on the pivot
              // group instead of being baked into the rendered geometry (see
              // targetedPatch.ts's decomposeNode for why).
              const bytes = await window.scadstudio.renderScad(primitiveSource(parsedTree.rootNode, node, src, graph.context));
              const transform = decomposeNode(parsedTree.rootNode, node)?.transform ?? IDENTITY_TRANSFORM;
              meshes.push({ index: node.index, bytes, transform });
            } catch (err) {
              console.error(`[scadstudio] node ${node.index} render failed`, err);
            }
          }
          setNodeMeshes(meshes);
          if (pendingSelectLast.current) {
            pendingSelectLast.current = false;
            setSelectedIndices(graph.nodes.length > 0 ? [graph.nodes.length - 1] : []);
          } else if (pendingSelectAfterEdit.current !== null) {
            const idx = pendingSelectAfterEdit.current;
            pendingSelectAfterEdit.current = null;
            setSelectedIndices(idx < graph.nodes.length ? [idx] : []);
          } else {
            setSelectedIndices((prev) => prev.filter((i) => i < graph.nodes.length));
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
  // The gizmo hands over its *absolute* final transform (see Viewport.tsx) —
  // patchTransform just writes it, no delta/composition math needed here.
  const handleTransformCommit = useCallback(
    (index: number, transform: NodeTransform) => {
      const tree = treeRef.current;
      const node = sceneNodesRef.current.find((n) => n.index === index);
      if (!tree || !node) return;
      const patched = patchTransform(sourceRef.current, tree, node, transform);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(patched);
      runRender(patched);
    },
    [runRender],
  );

  // M5: mirror + color toolbar actions. Both edit a single field of the
  // selected node's *current* transform (read from its already-rendered
  // mesh, which reflects the source as-of the last successful render) and
  // reuse handleTransformCommit's targeted-patch pipeline — same one-
  // derivation-path philosophy as every other edit here, just triggered by a
  // toolbar click instead of a gizmo drag or a text edit.
  const handleMirrorAxis = useCallback(
    (axis: 0 | 1 | 2) => {
      if (primarySelectedIndex === null) return;
      const current = nodeMeshes.find((m) => m.index === primarySelectedIndex)?.transform;
      if (!current) return;
      const scale = [...current.scale] as [number, number, number];
      scale[axis] *= -1;
      handleTransformCommit(primarySelectedIndex, { ...current, scale });
    },
    [primarySelectedIndex, nodeMeshes, handleTransformCommit],
  );

  const handleColorChange = useCallback(
    (hex: string) => {
      if (primarySelectedIndex === null) return;
      const current = nodeMeshes.find((m) => m.index === primarySelectedIndex)?.transform;
      if (!current) return;
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      handleTransformCommit(primarySelectedIndex, { ...current, color: [r, g, b] });
    },
    [primarySelectedIndex, nodeMeshes, handleTransformCommit],
  );

  const handleClearColor = useCallback(() => {
    if (primarySelectedIndex === null) return;
    const current = nodeMeshes.find((m) => m.index === primarySelectedIndex)?.transform;
    if (!current) return;
    handleTransformCommit(primarySelectedIndex, { ...current, color: null });
  }, [primarySelectedIndex, nodeMeshes, handleTransformCommit]);

  // M6: multi-select toggle (shift-click) vs single-select (plain click),
  // shared by Viewport clicks and (non-additive only) Editor cursor moves.
  const handleSelect = useCallback((index: number | null, additive: boolean) => {
    if (index === null) {
      setSelectedIndices([]);
      return;
    }
    setSelectedIndices((prev) => {
      if (!additive) return [index];
      // Shift-clicking an already-selected node toggles it back off, same
      // as most other multi-select UIs.
      return prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index];
    });
  }, []);

  // M6: boolean toolbar. Wraps the selected nodes' verbatim source into a
  // new union()/difference()/intersection() block and reuses the same
  // targeted-patch + re-render pipeline as every other edit path.
  const handleBooleanOp = useCallback(
    (op: BooleanOp) => {
      if (selectedIndices.length < 2) return;
      const nodesInSelectionOrder = selectedIndices
        .map((i) => sceneNodesRef.current.find((n) => n.index === i))
        .filter((n): n is SceneNode => n !== undefined);
      if (nodesInSelectionOrder.length < 2) return;
      const next = wrapInBoolean(sourceRef.current, nodesInSelectionOrder, op);
      if (next === sourceRef.current) return;
      // The merged statement always ends up at the selected node with the
      // smallest index — see wrapInBoolean's comment on why nothing before
      // it needs to move.
      pendingSelectAfterEdit.current = Math.min(...selectedIndices);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(next);
      runRender(next);
    },
    [selectedIndices, runRender],
  );

  // M5 (final piece): parameter panel. Reads the selected node's own
  // arguments straight from the live tree — recomputes whenever a render
  // lands (tree/sceneNodes change) or selection changes, so it always
  // reflects the currently-displayed source, same as everything else here.
  const selectedArgs = useMemo(() => {
    if (!tree || primarySelectedIndex === null) return null;
    const node = sceneNodes.find((n) => n.index === primarySelectedIndex);
    if (!node) return null;
    return primitiveArgs(tree.rootNode, node);
  }, [tree, sceneNodes, primarySelectedIndex]);

  const handleArgCommit = useCallback(
    (argIndex: number, newValueText: string) => {
      const currentTree = treeRef.current;
      const node = sceneNodesRef.current.find((n) => n.index === primarySelectedIndex);
      if (!currentTree || !node) return;
      const patched = patchArgument(sourceRef.current, currentTree, node, argIndex, newValueText);
      if (patched === sourceRef.current) return; // no-op: node/arg vanished, or text unchanged
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(patched);
      runRender(patched);
    },
    [primarySelectedIndex, runRender],
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
        {gizmoMode === 'rotate' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Space:
            {ROTATE_SPACE_BUTTONS.map(({ space, label }) => (
              <button
                key={space}
                onClick={() => setRotateSpace(space)}
                style={{ fontWeight: rotateSpace === space ? 'bold' : 'normal' }}
              >
                {label}
              </button>
            ))}
          </span>
        )}
        {primarySelectedIndex !== null && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {MIRROR_AXIS_BUTTONS.map(({ axis, label }) => (
              <button key={axis} onClick={() => handleMirrorAxis(axis)}>
                {label}
              </button>
            ))}
          </span>
        )}
        {primarySelectedIndex !== null && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Color:
            <input
              type="color"
              value={rgbToHex(nodeMeshes.find((m) => m.index === primarySelectedIndex)?.transform.color ?? null)}
              onChange={(e) => handleColorChange(e.target.value)}
            />
            {nodeMeshes.find((m) => m.index === primarySelectedIndex)?.transform.color && (
              <button onClick={handleClearColor}>Clear</button>
            )}
          </span>
        )}
        {selectedIndices.length >= 2 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Boolean ({selectedIndices.length} selected):
            {BOOLEAN_OP_BUTTONS.map(({ op, label }) => (
              <button key={op} onClick={() => handleBooleanOp(op)}>
                {label}
              </button>
            ))}
          </span>
        )}
      </div>
      {selectedArgs && selectedArgs.args.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '6px 12px',
            background: '#252526',
            color: '#ccc',
            fontSize: 12,
            borderBottom: '1px solid #333',
          }}
        >
          <span style={{ opacity: 0.7 }}>{selectedArgs.callName}:</span>
          {selectedArgs.args.map((arg, i) => (
            // Keyed on the value text too, not just index: after a commit
            // lands, the canonical (possibly reformatted) text should
            // replace whatever the user typed, which an uncontrolled input
            // only does on remount — see handleArgCommit's comment.
            <span key={`${i}-${arg.name}-${arg.valueText}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ opacity: 0.6 }}>{arg.name ?? `#${i + 1}`}:</span>
              <input
                type="text"
                defaultValue={arg.valueText}
                size={Math.max(4, arg.valueText.length)}
                onBlur={(e) => handleArgCommit(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Editor
            value={source}
            onChange={handleSourceChange}
            nodes={sceneNodes}
            selectedIndex={primarySelectedIndex}
            onSelectNode={(index) => handleSelect(index, false)}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid #333' }}>
          <Viewport
            meshes={nodeMeshes}
            selectedIndices={selectedIndices}
            onSelect={handleSelect}
            gizmoMode={gizmoMode}
            rotateSpace={rotateSpace}
            onTransformCommit={handleTransformCommit}
          />
        </div>
      </div>
    </div>
  );
}
