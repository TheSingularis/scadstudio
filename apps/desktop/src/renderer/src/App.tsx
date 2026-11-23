import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tree } from 'web-tree-sitter';
import { Editor } from './components/Editor';
import {
  Viewport,
  type GizmoMode,
  type NodeMesh,
  type RotateSpace,
  type SelectMode,
  type SketchPlaneKind,
  type ActiveSketchPlane,
  SELECTED_MESH_COLOR,
  OPERAND_MESH_COLOR,
  buildGlobalSketchPlane,
  buildFaceSketchPlane,
  sketchPlaneFromTransform,
} from './components/Viewport';
import { DEFAULT_SNAP_SETTINGS, type SnapSettings } from './sketchSnap';
import { parseScad, parseScadSync } from './scadParser';
import { buildSceneGraph, type SceneNode } from './sceneGraph';
import {
  patchTransform,
  primitiveOnlySlice,
  wrapAsThinExtrude,
  decomposeNode,
  primitiveArgs,
  patchArgument,
  wrapInBoolean,
  wrapInExtrude,
  readModifier,
  patchModifier,
  readSketchProfile,
  patchSketchPoints,
  IDENTITY_TRANSFORM,
  type NodeTransform,
  type BooleanOp,
  type ExtrudeOp,
  type Modifier,
  type ColorVector,
} from './targetedPatch';
import { appendPrimitive, appendSketchPolygon, type PrimitiveKind } from './primitives';
import { createCoalescingRunner } from './coalescingRunner';
import {
  EMPTY_SKETCH,
  addProfile,
  allSketchPoints,
  appendToOpen,
  closeOpen,
  committableProfiles,
  deleteSketchPoint,
  insertIntoNearestEdge,
  moveSketchPoint,
  sketchPointAt,
  type SketchHandle,
  type SketchPoint,
  type SketchState,
} from './sketchEditing';
import { arcPoints, circlePoints, rectanglePoints, type SketchTool } from './sketchShapes';
import type { SnapKind } from './sketchSnap';

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
const EXTRUDE_BUTTONS: { kind: ExtrudeOp; label: string }[] = [
  { kind: 'linear_extrude', label: 'Linear Extrude' },
  { kind: 'rotate_extrude', label: 'Rotate Extrude' },
];

// M7.5: global plane shortcuts. "Pick Face" (slice 3) is a distinct
// interaction (click a face rather than pick from a fixed list), handled
// separately in the toolbar JSX below, not part of this button set.
const SKETCH_PLANE_BUTTONS: { plane: 'XY' | 'XZ' | 'YZ'; label: string }[] = [
  { plane: 'XY', label: 'XY' },
  { plane: 'XZ', label: 'XZ' },
  { plane: 'YZ', label: 'YZ' },
];

// Grid snap spacings offered in the sketch toolbar, in model units.
const SNAP_GRID_SIZES = [0.5, 1, 2, 5, 10];

// M7.5 richer sketch tools. The hint is shown next to the buttons and says
// what the next click does, which changes as a tool collects its clicks.
const SKETCH_TOOL_BUTTONS: { tool: SketchTool; label: string }[] = [
  { tool: 'line', label: 'Line' },
  { tool: 'arc', label: 'Arc' },
  { tool: 'rect', label: 'Rectangle' },
  { tool: 'circle', label: 'Circle' },
  { tool: 'edit', label: 'Edit Points' },
];

// Segments for a full circle; an arc gets the same density for its sweep.
const CURVE_SEGMENT_OPTIONS = [16, 32, 64];

function sketchToolHint(tool: SketchTool, anchors: number, openPoints: number): string {
  switch (tool) {
    case 'line':
      return openPoints >= 3 ? 'click to add a point, click the first point to close the loop' : 'click to add points';
    case 'arc':
      if (openPoints === 0) return 'click the arc start';
      return anchors === 0 ? 'click the arc end' : 'click a point the arc passes through';
    case 'rect':
      return anchors === 0 ? 'click the first corner' : 'click the opposite corner';
    case 'circle':
      return anchors === 0 ? 'click the center' : 'click a point on the circle';
    case 'edit':
      return 'click near an edge to add a point, double-click a point to delete it (Shift: its whole loop)';
  }
}

function sketchPlaneLabel(kind: SketchPlaneKind, editing: boolean): string {
  if (editing) return kind === 'face' ? 'Editing sketch on its own plane' : `Editing sketch on ${kind} plane`;
  return kind === 'face' ? 'Sketching on picked face' : `Sketching on ${kind} plane`;
}

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

function rgbToHex(rgb: ColorVector | null): string {
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

// Electron wraps an error thrown by an ipcMain handler as "Error invoking
// remote method 'scad:render': ScadRenderError: <message>"; keep the message.
function renderErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}

export function App() {
  const [source, setSourceState] = useState(DEFAULT_SOURCE);
  const [filePath, setFilePath] = useState<string | null>(null);
  // The text as last opened or saved: the document is dirty while the
  // editor holds anything else.
  const [savedSource, setSavedSource] = useState(DEFAULT_SOURCE);
  // Bumped by the "Reset View" button — combined with filePath into
  // Viewport's fitToken, so the camera re-fits on an explicit request too,
  // not just on opening a new file.
  const [resetViewToken, setResetViewToken] = useState(0);
  // M7.5: null outside sketch mode. See Viewport.tsx's ActiveSketchPlane/
  // SketchController for the camera-lock/animate-to-plane behavior this
  // drives. Generalized (slice 3) from a fixed XY/XZ/YZ enum to an arbitrary
  // origin+rotation so a picked face works through the same state as the
  // three global-plane shortcuts.
  const [activeSketchPlane, setActiveSketchPlane] = useState<ActiveSketchPlane | null>(null);
  // M7.5 slice 3: true only during the brief "waiting for a face click"
  // window between clicking "Pick Face" and actually clicking one.
  const [pickingFace, setPickingFace] = useState(false);
  // M7.5: the sketch session's closed loops and open polyline, sketch-local
  // (u,v) — cleared whenever a sketch starts, finishes, or is exited/
  // cancelled, never partially carried over between sessions.
  const [sketch, setSketch] = useState<SketchState>(EMPTY_SKETCH);
  // M7.5 richer sketch tools: the active tool and the clicks it has
  // collected so far (a rectangle's first corner, a circle's center, an
  // arc's end). Anchors are pending input, not sketch geometry, so they're
  // outside the Undo history: Undo first drops a pending anchor.
  const [sketchTool, setSketchTool] = useState<SketchTool>('line');
  const [toolAnchors, setToolAnchors] = useState<SketchPoint[]>([]);
  // Kept across sessions, like the snap settings.
  const [curveSegments, setCurveSegments] = useState(32);
  // M7.5 snap-while-drawing toggles. Deliberately kept across sketch
  // sessions (unlike the sketch itself) — a chosen grid spacing is a working
  // preference, not part of any one sketch.
  const [snapSettings, setSnapSettings] = useState<SnapSettings>(DEFAULT_SNAP_SETTINGS);
  // M7.5 on-plane editing: synchronous mirror of `sketch`, so a burst of
  // drag moves landing between two renders each build on the latest points
  // rather than a stale closure's copy. Only ever written through
  // setSketchTracked/resetSketch below, which keep the two in step.
  const sketchRef = useRef<SketchState>(EMPTY_SKETCH);
  // Snapshots of the sketch before each edit this session (add, move,
  // insert, delete, a whole shape) — Undo pops one. Reset whenever a
  // session starts/ends.
  const [sketchHistory, setSketchHistory] = useState<SketchState[]>([]);
  // M7.5 on-plane editing: non-null while "Edit Sketch" has an already-
  // committed sketch open — the top-level node index being edited, so Save
  // patches that node's points in place instead of appending a new polygon.
  const [editingSketchIndex, setEditingSketchIndex] = useState<number | null>(null);
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
  // Bumped whenever a different document is loaded, so the editor starts a
  // fresh undo history for it (and only then; see Editor's documentKey).
  const [documentToken, setDocumentToken] = useState(0);

  // Every source change goes through here, typed or visual. It keeps
  // sourceRef, treeRef and sceneNodesRef describing the *same* text at all
  // times, synchronously, so an edit handler never splices byte offsets
  // from an older parse into newer text. Before this, typing and then
  // dragging a gizmo (or clicking a toolbar button) inside the render
  // debounce combined the last-rendered tree with the just-typed source and
  // corrupted the file (QC audit M3). A visual edit also cancels a pending
  // typed-text render, which would otherwise land after it and show stale
  // geometry.
  const setSource = useCallback((next: string) => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    sourceRef.current = next;
    const parsed = parseScadSync(next);
    if (parsed) {
      treeRef.current = parsed;
      sceneNodesRef.current = buildSceneGraph(parsed, next).nodes;
    }
    setSourceState(next);
  }, []);

  const runRender = useMemo(
    () =>
      createCoalescingRunner(async (src: string) => {
        setStatus('Rendering...');
        try {
          const { tree: parsedTree, errorCount } = await parseScad(src);
          // Only adopt this parse for edit handlers if it is still the
          // current text; otherwise setSource has already parsed newer text.
          if (src === sourceRef.current) treeRef.current = parsedTree;
          setTree(parsedTree);
          setParseErrorCount(errorCount);
          const graph = buildSceneGraph(parsedTree, src);
          if (src === sourceRef.current) sceneNodesRef.current = graph.nodes;
          setSceneNodes(graph.nodes);

          // Isolated per-node renders (M3 scope: one call per top-level
          // statement, sequential — see PLAN.md M3 build notes on why this
          // stays simple rather than the full render-worker job queue).
          const meshes: NodeMesh[] = [];
          let disabledCount = 0;
          // First node that failed both render attempts, shown in the status
          // bar so a failure says which node and why (QC audit M4).
          let firstFailure: string | null = null;
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
            const primitiveText = primitiveOnlySlice(parsedTree.rootNode, node, src);
            const source = `${graph.context}\n${primitiveText}`;
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
              // silently missing from the viewport. Context stays outside
              // the wrapper (passed separately) — see wrapAsThinExtrude's
              // 2026-09-21 comment for the real bug this fixed.
              try {
                const bytes = await window.scadstudio.renderScad(wrapAsThinExtrude(graph.context, primitiveText));
                const transform = decomposeNode(parsedTree.rootNode, node)?.transform ?? IDENTITY_TRANSFORM;
                meshes.push({ index: node.index, bytes, transform, modifier });
              } catch (err2) {
                console.error(`[scadstudio] node ${node.index} render failed`, err, err2);
                // A 2D node's first error is only "not a 3D object"; its
                // real reason is in the retry's error. For anything else the
                // first attempt's error is the real one.
                const firstMessage = renderErrorMessage(err);
                const reason = /not a 3D object/i.test(firstMessage) ? renderErrorMessage(err2) : firstMessage;
                firstFailure ??= `node ${node.index + 1} (${node.label.trim()}): ${reason.split('\n')[0]}`;
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
          setStatus(
            meshes.length === expected
              ? `Rendered${disabledSuffix}`
              : `Rendered ${meshes.length}/${expected} nodes${disabledSuffix}${firstFailure ? ` — ${firstFailure}` : ''}`,
          );
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

  // Manual verification hook: SCADSTUDIO_TEST_EDIT (main/index.ts) used to
  // inject content via window.__testEditor.setValue(...) (Editor.tsx),
  // relying on Monaco's onDidChangeModelContent to carry it into React state
  // the same way real typing does. That event is now guarded against
  // isFlush (see Editor.tsx's 2026-09-20 fix for the double-render bug this
  // uncovered), which made the test harness's own injection silently no-op
  // too — same event, no way to tell "test harness bypass" from "the
  // programmatic edit this guard exists to skip" apart. Dedicated test-only
  // path instead: sets React state and renders directly, bypassing Monaco's
  // event system entirely rather than relying on it.
  useEffect(() => {
    (window as unknown as { __testSetSource?: (value: string) => void }).__testSetSource = (value: string) => {
      setSource(value);
      runRender(value);
    };
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

  const dirty = source !== savedSource;

  // Save / Save As (QC audit H5). Resolves true once the text is on disk.
  const handleSave = useCallback(
    async (saveAs: boolean): Promise<boolean> => {
      const contents = sourceRef.current;
      const written = await window.scadstudio.saveFile({ filePath, contents, saveAs });
      if (!written) return false;
      setFilePath(written);
      setSavedSource(contents);
      setStatus(`Saved ${written}`);
      return true;
    },
    [filePath],
  );

  const handleOpen = useCallback(async () => {
    let result = await window.scadstudio.openFile();
    if (result && 'saveFirst' in result) {
      if (!(await handleSave(false))) return;
      result = await window.scadstudio.openFile();
    }
    if (!result || 'saveFirst' in result) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setFilePath(result.filePath);
    setSavedSource(result.contents);
    setDocumentToken((t) => t + 1);
    setSource(result.contents);
    runRender(result.contents);
  }, [runRender, handleSave, setSource]);

  // Keep the main process's copy of the dirty flag current (it asks before
  // closing the window or opening over unsaved changes), and show it in the
  // window title the usual way.
  useEffect(() => {
    window.scadstudio.setDirty(dirty);
    const name = filePath ? filePath.split(/[\\/]/).pop() : 'Untitled';
    document.title = `${dirty ? '• ' : ''}${name} - ScadStudio`;
  }, [dirty, filePath]);

  // Ctrl+S / Ctrl+Shift+S (Cmd on macOS). Capture phase, so the editor
  // doesn't swallow the key first.
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      e.stopPropagation();
      void handleSaveRef.current(e.shiftKey);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const unsubscribe = window.scadstudio.onSaveAndClose(() => {
      void handleSaveRef.current(false).then((saved) => {
        if (saved) window.scadstudio.closeAfterSave();
      });
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      unsubscribe();
    };
  }, []);

  // M7.5 on-plane editing: the only two writers of `sketch`, keeping
  // sketchRef in step. History snapshots are captured *before* the state
  // updater is queued — updaters run lazily at the next render, by which
  // point the ref may already hold a later drag position.
  const resetSketch = useCallback((next: SketchState = EMPTY_SKETCH, tool: SketchTool = 'line') => {
    sketchRef.current = next;
    setSketch(next);
    setSketchHistory([]);
    setToolAnchors([]);
    setSketchTool(tool);
  }, []);

  const setSketchTracked = useCallback((next: SketchState, recordHistory: boolean) => {
    if (recordHistory) {
      const before = sketchRef.current;
      setSketchHistory((h) => [...h, before]);
    }
    sketchRef.current = next;
    setSketch(next);
  }, []);

  const handleSelectSketchTool = useCallback((tool: SketchTool) => {
    setSketchTool(tool);
    setToolAnchors([]);
  }, []);

  // M7.5 slice 1: exiting sketch mode also bumps resetViewToken to trigger
  // the existing fit-to-content behavior (same as clicking "Reset View")
  // rather than needing to remember/restore whatever the camera's pre-sketch
  // state was — reuses FitController's mechanism instead of a second one.
  // M7.5 slice 2: also doubles as "cancel" — any in-progress, unfinished
  // points are discarded, never silently carried into a later session.
  const handleExitSketch = useCallback(() => {
    setActiveSketchPlane(null);
    setPickingFace(false);
    setEditingSketchIndex(null);
    resetSketch();
    setResetViewToken((t) => t + 1);
  }, [resetSketch]);

  // M7.5 slice 3: "Pick Face" click → enters the picking-a-face window (free
  // orbit still on, per Viewport's rotate-lock effect); a face click there
  // calls this with the derived plane, which starts the actual sketch
  // session exactly like a global-plane button would.
  const handlePickFace = useCallback(
    (point: [number, number, number], rotationDeg: [number, number, number], normal: [number, number, number]) => {
      setActiveSketchPlane(buildFaceSketchPlane(point, rotationDeg, normal));
      setPickingFace(false);
      setEditingSketchIndex(null);
      resetSketch();
    },
    [resetSketch],
  );

  // A click on the sketch plane, already snapped (grid / existing geometry /
  // alignment — see sketchSnap.ts). What it does depends on the tool:
  // - Line: append to the open polyline; a 'close' snap (its first point)
  //   closes it into a loop, and the session carries on for more loops.
  // - Arc: the first click starts a polyline if there isn't one, then the
  //   arc's end, then a point it passes through (3-point arc). Ending on the
  //   polyline's first point closes the loop.
  // - Rectangle: two opposite corners. Circle: center, then a rim point.
  //   Each adds its own closed loop straight away.
  // - Edit Points: insert a vertex into the nearest closed-loop edge — see
  //   insertIntoNearestEdge for why appending is wrong there.
  const handleSketchClick = useCallback(
    (u: number, v: number, kind: SnapKind) => {
      const p: SketchPoint = [u, v];
      const cur = sketchRef.current;
      switch (sketchTool) {
        case 'line':
          setSketchTracked(kind === 'close' ? closeOpen(cur) : appendToOpen(cur, [p]), true);
          return;
        case 'arc': {
          const last = cur.open[cur.open.length - 1];
          if (!last) {
            setSketchTracked(appendToOpen(cur, [p]), true);
          } else if (toolAnchors.length === 0) {
            setToolAnchors([kind === 'close' ? cur.open[0] : p]);
          } else if (kind !== 'close') {
            setSketchTracked(appendToOpen(cur, arcPoints(last, toolAnchors[0], p, curveSegments)), true);
            setToolAnchors([]);
          }
          return;
        }
        case 'rect':
        case 'circle': {
          if (toolAnchors.length === 0) {
            setToolAnchors([p]);
            return;
          }
          const loop = sketchTool === 'rect' ? rectanglePoints(toolAnchors[0], p) : circlePoints(toolAnchors[0], p, curveSegments);
          // A zero-size shape is ignored, keeping the first click so the
          // second one can be tried again.
          if (!loop) return;
          setSketchTracked(addProfile(cur, loop), true);
          setToolAnchors([]);
          return;
        }
        case 'edit': {
          const next = insertIntoNearestEdge(cur, p);
          if (next) setSketchTracked(next, true);
          return;
        }
      }
    },
    [sketchTool, toolAnchors, curveSegments, setSketchTracked],
  );

  // A plain click on a handle is a click exactly on that point: the open
  // polyline's first point closes it; a closed loop's vertex is a corner the
  // drawing tools can start from or end on (a rectangle sharing a corner).
  // Other points of the open polyline are ignored — landing on one would
  // only make it touch itself. Edit Points ignores handle clicks (inserting
  // on top of an existing vertex adds nothing).
  const handleSketchHandleClick = useCallback(
    (handle: SketchHandle) => {
      if (sketchTool === 'edit') return;
      const cur = sketchRef.current;
      const p = sketchPointAt(cur, handle);
      if (!p) return;
      if (handle.profile === -1) {
        if (handle.point === 0 && cur.open.length >= 3) handleSketchClick(p[0], p[1], 'close');
        return;
      }
      handleSketchClick(p[0], p[1], 'endpoint');
    },
    [sketchTool, handleSketchClick],
  );

  // M7.5 on-plane editing: a handle drag snapshots once, on its first
  // movement (so a whole drag is one Undo step, and a press-without-moving
  // records nothing), then streams untracked moves.
  const handleSketchDragStart = useCallback(() => {
    const before = sketchRef.current;
    setSketchHistory((h) => [...h, before]);
  }, []);

  const handleMoveSketchPoint = useCallback(
    (handle: SketchHandle, u: number, v: number) => {
      setSketchTracked(moveSketchPoint(sketchRef.current, handle, [u, v]), false);
    },
    [setSketchTracked],
  );

  // Double-click on a handle, Edit Points only (with a drawing tool the two
  // clicks are clicks on that point). While editing a committed sketch its
  // last loop can't be deleted (Save would have nothing valid to write).
  const handleDeleteSketchPoint = useCallback(
    (handle: SketchHandle, wholeLoop: boolean) => {
      if (sketchTool !== 'edit') return;
      const prev = sketchRef.current;
      const next = deleteSketchPoint(prev, handle, wholeLoop, editingSketchIndex !== null);
      if (next !== prev) setSketchTracked(next, true);
    },
    [sketchTool, editingSketchIndex, setSketchTracked],
  );

  const handleUndoSketch = useCallback(() => {
    if (toolAnchors.length > 0) {
      setToolAnchors([]);
      return;
    }
    if (sketchHistory.length === 0) return;
    const restored = sketchHistory[sketchHistory.length - 1];
    sketchRef.current = restored;
    setSketch(restored);
    setSketchHistory(sketchHistory.slice(0, -1));
  }, [sketchHistory, toolAnchors]);

  // Commits every loop (plus the open polyline, when it has 3+ points) as
  // one polygon() statement — paths= when there are several, so inner loops
  // become holes — wrapped in the plane's translate()/rotate() (each omitted
  // when identity), via the same append+select+render path every other
  // toolbar insertion uses, then leaves sketch mode the same way Exit
  // Sketch does.
  const handleFinishSketch = useCallback(() => {
    const loops = committableProfiles(sketchRef.current);
    if (!activeSketchPlane || loops.length === 0) return;
    const next = appendSketchPolygon(sourceRef.current, activeSketchPlane.origin, activeSketchPlane.rotationDeg, loops);
    pendingSelectLast.current = true;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setSource(next);
    runRender(next);
    setActiveSketchPlane(null);
    resetSketch();
    setResetViewToken((t) => t + 1);
  }, [activeSketchPlane, runRender, resetSketch]);

  // M7.5 on-plane editing: the selected node, when it's a sketch this app can
  // re-open (see readSketchProfile for exactly which shapes qualify — a bare
  // committed polygon, optionally under an offset() and/or a
  // linear_extrude). Drives whether the toolbar offers "Edit Sketch" at all.
  const selectedSketchProfile = useMemo(() => {
    if (!tree || primarySelectedIndex === null) return null;
    const node = sceneNodes.find((n) => n.index === primarySelectedIndex);
    if (!node) return null;
    return readSketchProfile(tree.rootNode, node);
  }, [tree, sceneNodes, primarySelectedIndex]);

  // Re-enters sketch mode on the plane the sketch was drawn on (rebuilt from
  // its own translate()/rotate() wrap) with its committed loops loaded as
  // draggable handles, starting on the Edit Points tool. The drawing tools
  // work here too, so a hole can be added to an existing sketch.
  const handleEditSketch = useCallback(() => {
    if (primarySelectedIndex === null || !selectedSketchProfile) return;
    setActiveSketchPlane(sketchPlaneFromTransform(selectedSketchProfile.origin, selectedSketchProfile.rotationDeg));
    setPickingFace(false);
    setEditingSketchIndex(primarySelectedIndex);
    resetSketch({ profiles: selectedSketchProfile.loops, open: [] }, 'edit');
  }, [primarySelectedIndex, selectedSketchProfile, resetSketch]);

  // Writes the edited loops back into the same polygon, in place. The
  // profile is re-read against the *current* tree rather than reusing the
  // one captured when editing started, so byte offsets are right even if the
  // source changed meanwhile (e.g. typed in the editor while sketching); if
  // the node no longer reads as a sketch at all, nothing is written.
  const handleSaveSketch = useCallback(() => {
    const currentTree = treeRef.current;
    const node = sceneNodesRef.current.find((n) => n.index === editingSketchIndex);
    const loops = committableProfiles(sketchRef.current);
    if (!currentTree || !node || loops.length === 0) return;
    const profile = readSketchProfile(currentTree.rootNode, node);
    if (!profile) {
      setStatus('Could not save sketch: the edited node is no longer a sketch polygon');
      return;
    }
    const next = patchSketchPoints(sourceRef.current, profile, loops);
    pendingSelectAfterEdit.current = node.index;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setSource(next);
    runRender(next);
    setActiveSketchPlane(null);
    setEditingSketchIndex(null);
    resetSketch();
    setResetViewToken((t) => t + 1);
  }, [editingSketchIndex, runRender, resetSketch]);

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
      // Keep an existing alpha: the picker only chooses the RGB part.
      const color: ColorVector = current.color?.length === 4 ? [r, g, b, current.color[3]] : [r, g, b];
      handleTransformCommit(primarySelectedIndex, { ...current, color });
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

  // M7.5: Linear/Rotate Extrude wraps the *selected* node (e.g. a just-drawn
  // sketch) in place when something is selected — falls back to inserting
  // an unrelated fresh default shape only when nothing is, same as before.
  // Wrapping in place doesn't change the node's own top-level index, so the
  // existing selection-preserving logic in runRender keeps it selected with
  // no extra bookkeeping needed here.
  const handleExtrude = useCallback(
    (op: ExtrudeOp) => {
      const tree = treeRef.current;
      const node = primarySelectedIndex !== null ? sceneNodesRef.current.find((n) => n.index === primarySelectedIndex) : undefined;
      if (!tree || !node) {
        handleInsertPrimitive(op);
        return;
      }
      const next = wrapInExtrude(sourceRef.current, tree.rootNode, node, op);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(next);
      runRender(next);
    },
    [primarySelectedIndex, runRender, handleInsertPrimitive],
  );

  // M7.5: offset() around the selected sketch, in place (same wrap as the
  // extrudes). Only offered for a bare, not-yet-offset sketch: an extruded
  // one is 3D, which offset() can't take, and a second offset is better
  // done by editing the first one's r= in the parameter panel.
  const handleOffsetSketch = useCallback(() => {
    const tree = treeRef.current;
    const node = primarySelectedIndex !== null ? sceneNodesRef.current.find((n) => n.index === primarySelectedIndex) : undefined;
    if (!tree || !node) return;
    const next = wrapInExtrude(sourceRef.current, tree.rootNode, node, 'offset');
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setSource(next);
    runRender(next);
  }, [primarySelectedIndex, runRender]);

  // M7.5 snap-while-drawing controls, shown in both draw and edit-sketch
  // modes (point drags snap too). Hold Alt to bypass for a single click/drag.
  const snapControls = (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 6 }} title="Hold Alt while clicking or dragging to place a point without snapping">
      Snap:
      <label style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <input
          type="checkbox"
          checked={snapSettings.grid}
          onChange={(e) => setSnapSettings((s) => ({ ...s, grid: e.target.checked }))}
        />
        Grid
      </label>
      <select
        value={snapSettings.gridSize}
        disabled={!snapSettings.grid}
        onChange={(e) => setSnapSettings((s) => ({ ...s, gridSize: Number(e.target.value) }))}
      >
        {SNAP_GRID_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
      <label style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <input
          type="checkbox"
          checked={snapSettings.geometry}
          onChange={(e) => setSnapSettings((s) => ({ ...s, geometry: e.target.checked }))}
        />
        Points/edges
      </label>
    </span>
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
        <button onClick={() => void handleSave(false)} title="Save (Ctrl+S)">
          Save
        </button>
        <button onClick={() => void handleSave(true)} title="Save As (Ctrl+Shift+S)">
          Save As...
        </button>
        <button onClick={() => setResetViewToken((t) => t + 1)}>Reset View</button>
        <span title={dirty ? 'Unsaved changes' : undefined}>
          {filePath ?? '(unsaved default example)'}
          {dirty ? ' •' : ''}
        </span>
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
          Extrude{primarySelectedIndex !== null ? ' (selected)' : ''}:
          {EXTRUDE_BUTTONS.map(({ kind, label }) => (
            <button key={kind} onClick={() => handleExtrude(kind)}>
              {label}
            </button>
          ))}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {pickingFace ? (
            <>
              <span style={{ opacity: 0.7 }}>Click a face of an existing shape to sketch on it…</span>
              <button onClick={() => setPickingFace(false)}>Cancel</button>
            </>
          ) : activeSketchPlane === null ? (
            <>
              Sketch:
              {SKETCH_PLANE_BUTTONS.map(({ plane, label }) => (
                <button
                  key={plane}
                  onClick={() => {
                    setActiveSketchPlane(buildGlobalSketchPlane(plane));
                    setEditingSketchIndex(null);
                    resetSketch();
                  }}
                >
                  {label}
                </button>
              ))}
              <button onClick={() => setPickingFace(true)}>Pick Face</button>
              {selectedSketchProfile && <button onClick={handleEditSketch}>Edit Sketch</button>}
              {selectedSketchProfile && !selectedSketchProfile.extruded && !selectedSketchProfile.offset && (
                <button onClick={handleOffsetSketch} title="Wrap the selected sketch in offset(r=1); edit r in the parameter panel (negative insets)">
                  Offset
                </button>
              )}
            </>
          ) : (
            <>
              <span style={{ opacity: 0.7 }}>{sketchPlaneLabel(activeSketchPlane.kind, editingSketchIndex !== null)}:</span>
              {SKETCH_TOOL_BUTTONS.map(({ tool, label }) => (
                <button
                  key={tool}
                  onClick={() => handleSelectSketchTool(tool)}
                  aria-pressed={sketchTool === tool}
                  style={{ fontWeight: sketchTool === tool ? 'bold' : 'normal' }}
                >
                  {label}
                </button>
              ))}
              {(sketchTool === 'arc' || sketchTool === 'circle') && (
                <select
                  aria-label="Curve segments"
                  title="Segments in a full circle (an arc gets the same density)"
                  value={curveSegments}
                  onChange={(e) => setCurveSegments(Number(e.target.value))}
                >
                  {CURVE_SEGMENT_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n} segments
                    </option>
                  ))}
                </select>
              )}
              <span style={{ opacity: 0.7 }} data-testid="sketch-hint">
                {sketchToolHint(sketchTool, toolAnchors.length, sketch.open.length)} ({sketch.profiles.length} loop
                {sketch.profiles.length === 1 ? '' : 's'}, {allSketchPoints(sketch).length} points)
              </span>
              <button onClick={handleUndoSketch} disabled={sketchHistory.length === 0 && toolAnchors.length === 0}>
                Undo
              </button>
              {editingSketchIndex !== null ? (
                <>
                  <button onClick={handleSaveSketch} disabled={committableProfiles(sketch).length === 0 || sketchHistory.length === 0}>
                    Save Sketch
                  </button>
                  <button onClick={handleExitSketch}>Cancel</button>
                </>
              ) : (
                <>
                  <button onClick={handleFinishSketch} disabled={committableProfiles(sketch).length === 0}>
                    Finish Sketch
                  </button>
                  <button onClick={handleExitSketch}>Exit Sketch</button>
                </>
              )}
              {snapControls}
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
            documentKey={documentToken}
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
            activeSketchPlane={activeSketchPlane}
            pickingFace={pickingFace}
            onPickFace={handlePickFace}
            sketch={sketch}
            onSketchClick={handleSketchClick}
            sketchTool={sketchTool}
            toolAnchors={toolAnchors}
            curveSegments={curveSegments}
            onHandleClick={handleSketchHandleClick}
            snapSettings={snapSettings}
            onMoveSketchPoint={handleMoveSketchPoint}
            onSketchDragStart={handleSketchDragStart}
            onDeleteSketchPoint={handleDeleteSketchPoint}
            editingNodeIndex={editingSketchIndex}
          />
        </div>
      </div>
    </div>
  );
}
