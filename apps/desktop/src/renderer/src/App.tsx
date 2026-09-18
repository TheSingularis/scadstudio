import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tree } from 'web-tree-sitter';
import { Editor } from './components/Editor';
import {
  Viewport,
  type GizmoMode,
  type NodeMesh,
  type RotateSpace,
  type SelectMode,
  type SketchPlane,
  SELECTED_MESH_COLOR,
  OPERAND_MESH_COLOR,
} from './components/Viewport';
import { parseScad } from './scadParser';
import { buildSceneGraph, type SceneNode } from './sceneGraph';
import {
  patchTransform,
  primitiveSource,
  wrapAsThinExtrude,
  decomposeNode,
  primitiveArgs,
  patchArgument,
  wrapInBoolean,
  readModifier,
  patchModifier,
  IDENTITY_TRANSFORM,
  type NodeTransform,
  type BooleanOp,
  type Modifier,
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

// M7: extrusions insert a whole pre-wrapped statement (extrude + default 2D
// profile) via the same append path as the primitives above — separated into
// their own labelled toolbar group only for clarity, since they're a distinct
// operation category (a 2D→3D feature, not a bare primitive).
const EXTRUDE_BUTTONS: { kind: PrimitiveKind; label: string }[] = [
  { kind: 'linear_extrude', label: 'Linear Extrude' },
  { kind: 'rotate_extrude', label: 'Rotate Extrude' },
];

// M7.5 slice 1: global planes only — no face-picking yet (see PLAN.md).
const SKETCH_PLANE_BUTTONS: { plane: SketchPlane; label: string }[] = [
  { plane: 'XY', label: 'XY' },
  { plane: 'XZ', label: 'XZ' },
  { plane: 'YZ', label: 'YZ' },
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

// M6: OpenSCAD's four statement modifier characters — clicking the one
// that's already active toggles it off (see patchModifier's comment); real
// OpenSCAD only ever has zero or one per statement, so these are mutually
// exclusive, same spirit as the gizmo-mode buttons above.
const MODIFIER_BUTTONS: { modifier: Modifier; label: string }[] = [
  { modifier: '#', label: 'Highlight #' },
  { modifier: '%', label: 'Ghost %' },
  { modifier: '!', label: 'Show only !' },
  { modifier: '*', label: 'Disable *' },
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
  // Bumped by the "Reset View" button — combined with filePath into
  // Viewport's fitToken, so the camera re-fits on an explicit request too,
  // not just on opening a new file.
  const [resetViewToken, setResetViewToken] = useState(0);
  // M7.5 slice 1: null outside sketch mode. See Viewport.tsx's SketchPlane/
  // SketchController for the camera-lock/animate-to-plane behavior this
  // drives.
  const [sketchPlane, setSketchPlane] = useState<SketchPlane | null>(null);
  const [sceneNodes, setSceneNodes] = useState<SceneNode[]>([]);
  const [nodeMeshes, setNodeMeshes] = useState<NodeMesh[]>([]);
  // See Viewport.tsx's SelectMode/ViewportProps.selectedIndices comments for
  // ordering. The last entry is the "primary" selection that gizmo/mirror/
  // color/parameter-panel editing (all single-target operations) act on.
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
          let disabledCount = 0;
          for (const node of graph.nodes) {
            // `*` (disable) — real OpenSCAD never evaluates disabled
            // geometry at all, so skip the WASM call entirely rather than
            // rendering it and hiding it after the fact. The node stays
            // selectable via the editor (sceneNodes/tree don't depend on
            // nodeMeshes), just absent from the viewport — same fallback
            // shape as a node whose render call fails below, but tracked
            // separately so the status line doesn't read a deliberate
            // disable as a render failure.
            const modifier = readModifier(parsedTree.rootNode, node);
            if (modifier === '*') {
              disabledCount++;
              continue;
            }
            const source = primitiveSource(parsedTree.rootNode, node, src, graph.context);
            try {
              // Only the bare primitive goes to WASM — translate/rotate/
              // scale are applied as a real three.js transform on the pivot
              // group instead of being baked into the rendered geometry (see
              // targetedPatch.ts's decomposeNode for why).
              const bytes = await window.scadstudio.renderScad(source);
              const transform = decomposeNode(parsedTree.rootNode, node)?.transform ?? IDENTITY_TRANSFORM;
              meshes.push({ index: node.index, bytes, transform, modifier });
            } catch (err) {
              // M7: a pure-2D node (bare square/circle/polygon, a 2D
              // boolean, ...) fails here every time — real OpenSCAD can't
              // STL-export 2D geometry. Retry once wrapped in a hairline
              // linear_extrude (see wrapAsThinExtrude) before giving up, so
              // 2D shapes are at least visible/selectable instead of
              // silently missing from the viewport.
              try {
                const bytes = await window.scadstudio.renderScad(wrapAsThinExtrude(source));
                const transform = decomposeNode(parsedTree.rootNode, node)?.transform ?? IDENTITY_TRANSFORM;
                meshes.push({ index: node.index, bytes, transform, modifier });
              } catch (err2) {
                console.error(`[scadstudio] node ${node.index} render failed`, err, err2);
              }
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
          const expected = graph.nodes.length - disabledCount;
          const disabledSuffix = disabledCount > 0 ? ` (${disabledCount} disabled)` : '';
          setStatus(meshes.length === expected ? `Rendered${disabledSuffix}` : `Rendered ${meshes.length}/${expected} nodes${disabledSuffix}`);
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

  // M7.5 slice 1: exiting sketch mode also bumps resetViewToken to trigger
  // the existing fit-to-content behavior (same as clicking "Reset View")
  // rather than needing to remember/restore whatever the camera's pre-sketch
  // state was — reuses FitController's mechanism instead of a second one.
  const handleExitSketch = useCallback(() => {
    setSketchPlane(null);
    setResetViewToken((t) => t + 1);
  }, []);

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

  // Position fields in the toolbar: same single-field-edit-of-current-
  // transform pattern as mirror/color above, just for translate instead.
  // Previously the only way to see or edit a shape's position was the
  // translate gizmo itself — this surfaces the actual numbers too.
  const handlePositionCommit = useCallback(
    (axis: 0 | 1 | 2, valueText: string) => {
      if (primarySelectedIndex === null) return;
      const current = nodeMeshes.find((m) => m.index === primarySelectedIndex)?.transform;
      if (!current) return;
      const value = Number(valueText);
      if (!Number.isFinite(value)) return; // invalid input — ignore, leave source untouched
      const translate = [...current.translate] as [number, number, number];
      translate[axis] = value;
      handleTransformCommit(primarySelectedIndex, { ...current, translate });
    },
    [primarySelectedIndex, nodeMeshes, handleTransformCommit],
  );

  // M6: modifier characters (# % ! *). This edits the node's outermost call
  // directly via patchModifier (targetedPatch.ts), not handleTransformCommit
  // — a modifier isn't part of NodeTransform, it's a separate prefix
  // targetedPatch reads/writes on its own (see readModifier/patchModifier).
  const handleModifierToggle = useCallback(
    (modifier: Modifier) => {
      const tree = treeRef.current;
      const node = sceneNodesRef.current.find((n) => n.index === primarySelectedIndex);
      if (!tree || !node) return;
      const patched = patchModifier(sourceRef.current, tree, node, modifier);
      if (patched === sourceRef.current) return;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(patched);
      runRender(patched);
    },
    [primarySelectedIndex, runRender],
  );

  // M6: multi-select, shared by Viewport clicks and (plain-click only)
  // Editor cursor moves. Plain click replaces the selection; ctrl/cmd-click
  // toggles one node in or out (standard multi-select convention); shift-
  // click selects the contiguous range between the last replace/toggle
  // target and the clicked node (standard range-select convention). Node
  // `index` is assigned sequentially in document order (see sceneGraph.ts),
  // so a plain numeric range between anchor and the clicked index already
  // matches document order — no separate lookup needed.
  const selectionAnchor = useRef<number | null>(null);
  const handleSelect = useCallback((index: number | null, mode: SelectMode) => {
    if (index === null) {
      selectionAnchor.current = null;
      setSelectedIndices([]);
      return;
    }
    if (mode === 'range') {
      const anchor = selectionAnchor.current ?? index;
      const step = index >= anchor ? 1 : -1;
      const range: number[] = [];
      for (let i = anchor; i !== index + step; i += step) range.push(i);
      setSelectedIndices(range);
      return;
    }
    selectionAnchor.current = index;
    if (mode === 'replace') {
      setSelectedIndices([index]);
      return;
    }
    // 'toggle'
    setSelectedIndices((prev) => (prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]));
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

  // Same reasoning as selectedArgs above, for the modifier toolbar's active-
  // button styling — read fresh from the tree rather than from nodeMeshes,
  // since a disabled ('*') node has no mesh at all to read from.
  const selectedModifier = useMemo(() => {
    if (!tree || primarySelectedIndex === null) return null;
    const node = sceneNodes.find((n) => n.index === primarySelectedIndex);
    if (!node) return null;
    return readModifier(tree.rootNode, node);
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
        <button onClick={() => setResetViewToken((t) => t + 1)}>Reset View</button>
        <span>{filePath ?? '(unsaved default example)'}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
          {parseErrorCount ? `${parseErrorCount} parse error(s) — ` : ''}
          {status}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
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
          Extrude:
          {EXTRUDE_BUTTONS.map(({ kind, label }) => (
            <button key={kind} onClick={() => handleInsertPrimitive(kind)}>
              {label}
            </button>
          ))}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {sketchPlane === null ? (
            <>
              Sketch:
              {SKETCH_PLANE_BUTTONS.map(({ plane, label }) => (
                <button key={plane} onClick={() => setSketchPlane(plane)}>
                  {label}
                </button>
              ))}
            </>
          ) : (
            <>
              <span style={{ opacity: 0.7 }}>Sketching on {sketchPlane} plane</span>
              <button onClick={handleExitSketch}>Exit Sketch</button>
            </>
          )}
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
            Modifier:
            {MODIFIER_BUTTONS.map(({ modifier, label }) => (
              <button
                key={modifier}
                onClick={() => handleModifierToggle(modifier)}
                style={{ fontWeight: selectedModifier === modifier ? 'bold' : 'normal' }}
              >
                {label}
              </button>
            ))}
          </span>
        )}
        {primarySelectedIndex !== null && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Position:
            {(['X', 'Y', 'Z'] as const).map((label, axis) => {
              const translate = nodeMeshes.find((m) => m.index === primarySelectedIndex)?.transform.translate;
              const value = translate?.[axis] ?? 0;
              return (
                <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <span style={{ opacity: 0.6 }}>{label}:</span>
                  {/* Keyed on the value too, same reformat-after-commit reasoning as the parameter panel's inputs below. */}
                  <input
                    key={`${primarySelectedIndex}-${axis}-${value}`}
                    type="number"
                    defaultValue={value}
                    step="any"
                    size={5}
                    onBlur={(e) => handlePositionCommit(axis as 0 | 1 | 2, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                </span>
              );
            })}
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
            Boolean ({selectedIndices.length} selected —
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: SELECTED_MESH_COLOR, display: 'inline-block' }} />
              base
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: OPERAND_MESH_COLOR, display: 'inline-block' }} />
              tool(s)
            </span>
            ):
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
            onSelectNode={(index) => handleSelect(index, 'replace')}
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
            fitToken={`${filePath ?? 'default'}:${resetViewToken}`}
            sketchPlane={sketchPlane}
          />
        </div>
      </div>
    </div>
  );
}
