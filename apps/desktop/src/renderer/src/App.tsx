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
  addNamedArgument,
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
import { appendSketchPolygon, appendStatement, sketchPolygonStatement } from './primitives';
import {
  canDrill,
  drillLabel,
  frameIsRigid,
  frameToWorld,
  insertIntoContainer,
  isolatedRender,
  nodeModifier,
  resolveFocus,
  worldToFrame,
  type FocusEntry,
  type ModuleResolver,
  type ResolvedFocus,
  type SourceDoc,
  type WorkingSet,
} from './drillIn';
import { remapIndices, type NodeFingerprint } from './nodeIdentity';
import { BUILTIN_SIGNATURES, BUILTIN_TOOL_DEFINITIONS, addUseDirective, builtinTool, type ToolDefinition } from './tools';
import { analyzeSource, toolsFromAnalyzed, type AnalyzedSource } from './moduleIntrospection';
import { panelFields, parseVec3, quoteScadString, unquoteScadString, type PanelField } from './paramPanel';

type ModuleSourceFile = Awaited<ReturnType<Window['scadstudio']['scanModules']>>[number];
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

// Built-in insert tools (M5) and extrusions (M7) share M8's ToolDefinition
// shape with the Custom section's tools (see tools.ts). Extrusions insert a
// whole pre-wrapped statement (extrude + default 2D profile) through the same
// append path, separated into their own labelled group only for clarity.
const INSERT_TOOLS = BUILTIN_TOOL_DEFINITIONS.filter((t) => t.section === 'insert');
const EXTRUDE_TOOLS = BUILTIN_TOOL_DEFINITIONS.filter((t) => t.section === 'extrude') as (ToolDefinition & { callName: ExtrudeOp })[];

// Past this many Custom tools (a big library such as BOSL2), the section
// gets a filter box and shows only the first matches.
const CUSTOM_TOOL_LIMIT = 12;

function toolTitle(tool: ToolDefinition): string {
  const where = tool.origin ? `${tool.origin.file ? tool.origin.file.split(/[\\/]/).pop() : 'this file'}:${tool.origin.line}` : '';
  const params = tool.params.map((p) => (p.required ? `${p.name} (required)` : `${p.name} = ${p.defaultText}`)).join(', ');
  return [tool.description, `${tool.callName}(${params})`, where && `Defined in ${where}`, tool.useDirective && `Adds use <${tool.useDirective}>`]
    .filter(Boolean)
    .join('\n');
}

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

// M9 per-node render cache (PLAN.md "Per-node selection & manipulation
// strategy", point 2; risk 2). Keyed on the exact source sent to the engine
// (the node's primitive plus everything it can see), so an edit to one node
// re-renders only that node: its siblings' sources are unchanged and come
// from here, and so does everything when stepping in and out of a drill-in.
// Cleared when a used/included file changes on disk or the document moves
// (relative paths resolve differently), the two ways the same text can mean
// different geometry.
type CachedRender = { bytes: Uint8Array } | { firstError: unknown; secondError: unknown };
const RENDER_CACHE_LIMIT = 500;

// Test hook: counts engine calls and cache hits, so e2e tests can check that
// an edit re-renders only what it changed.
interface RenderStats {
  engineCalls: number;
  cacheHits: number;
  flashes: number;
  // Meshes in the working set and in the dimmed context after the last render.
  workingMeshes: number;
  contextMeshes: number;
}
function renderStats(): RenderStats {
  const w = window as unknown as { __scadstudioRenderStats?: RenderStats };
  w.__scadstudioRenderStats ??= { engineCalls: 0, cacheHits: 0, flashes: 0, workingMeshes: 0, contextMeshes: 0 };
  return w.__scadstudioRenderStats;
}

function topModuleDefinition(doc: SourceDoc, name: string) {
  for (const stmt of doc.tree.rootNode.children) {
    const def = stmt?.type === 'statement' ? stmt.child(0) : stmt;
    if (def?.type === 'module_definition' && def.childForFieldName('name')?.text === name) return def;
  }
  return null;
}

function currentSet(r: ResolvedFocus | null): WorkingSet | null {
  return r ? r.sets[r.sets.length - 1] : null;
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
  // M8: library files that can supply Custom tools (from the main process's
  // scan of the document's `use`s), bumped-on-change version, and the
  // Custom section's filter text.
  const [libraryFiles, setLibraryFiles] = useState<ModuleSourceFile[]>([]);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [customFilter, setCustomFilter] = useState('');

  // M9 drill-in. `focusRef` is the path of drilled-into nodes (empty at the
  // top level), kept in step with sourceRef like treeRef is; `resolvedRef`
  // is that path resolved against the current text (the working sets), and
  // `resolved` its copy for rendering the breadcrumb and toolbar.
  const focusRef = useRef<FocusEntry[]>([]);
  const resolvedRef = useRef<ResolvedFocus | null>(null);
  const [resolved, setResolved] = useState<ResolvedFocus | null>(null);
  // Bumped by every explicit drill in/out: selection is remapped across a
  // render only within one epoch (an explicit step sets its own selection).
  const focusEpochRef = useRef(0);
  const prevSetRef = useRef<{ epoch: number; fingerprints: NodeFingerprint[] } | null>(null);
  const [contextMeshes, setContextMeshes] = useState<NodeMesh[]>([]);
  const renderCache = useRef(new Map<string, CachedRender>());
  // The confirm-flash after a typed edit (PLAN.md risk 5).
  const [flashToken, setFlashToken] = useState(0);
  const lastTypedSourceRef = useRef<string | null>(null);
  const selectedRef = useRef<number[]>([]);
  selectedRef.current = selectedIndices;
  // Parsed library files (`use`d by the document), for drilling into a
  // module defined in one. View-only: see drillIn.ts.
  const libraryDocsRef = useRef(new Map<string, SourceDoc>());
  const filePathRef = useRef<string | null>(null);
  filePathRef.current = filePath;

  const resolveModule: ModuleResolver = useCallback((name, from) => {
    const own = topModuleDefinition(from, name);
    if (own) return { def: own, doc: from };
    // A library module sees only its own file here; the document sees every
    // file it uses (matching the Custom toolbar's lookup order).
    if (from.kind !== 'document') return null;
    for (const lib of libraryDocsRef.current.values()) {
      const def = topModuleDefinition(lib, name);
      if (def) return { def, doc: lib };
    }
    return null;
  }, []);

  // Resolves the focus path against `tree` (the parse of `text`) and makes
  // it current. Called with every new text, so edit handlers always splice
  // offsets from the working set that matches what's in the editor.
  //
  // The followed path is only stored (`commit`) by a render, not on every
  // keystroke: halfway through typing a statement above the drilled-into
  // node the parse is often something else entirely, and remapping from
  // each half-typed text would compound guesses. Leaving a level because
  // its node is gone is only stored for text that parses cleanly, so the
  // drill-in survives a statement being typed.
  const deriveFocus = useCallback(
    (tree: Tree, text: string, commit: 'no' | 'yes' | 'unless-lost' = 'no'): ResolvedFocus => {
      const doc: SourceDoc = { kind: 'document', path: filePathRef.current, text, tree };
      const r = resolveFocus(doc, focusRef.current, resolveModule);
      if (commit === 'yes' || (commit === 'unless-lost' && !r.lost)) focusRef.current = r.focus;
      return r;
    },
    [resolveModule],
  );

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
      const r = deriveFocus(parsed, next);
      resolvedRef.current = r;
      sceneNodesRef.current = currentSet(r)!.nodes;
    }
    setSourceState(next);
  }, [deriveFocus]);

  // One isolated render through the cache: the normal attempt, then M7's
  // flat (2D) retry; both outcomes are cached.
  const renderCached = useCallback(async (source: string, flatSource: string): Promise<CachedRender> => {
    const cache = renderCache.current;
    const stats = renderStats();
    const hit = cache.get(source);
    if (hit) {
      stats.cacheHits++;
      cache.delete(source);
      cache.set(source, hit);
      return hit;
    }
    let result: CachedRender;
    try {
      stats.engineCalls++;
      result = { bytes: await window.scadstudio.renderScad(source) };
    } catch (firstError) {
      // M7: a pure-2D node (bare square/circle/polygon, a 2D boolean, ...)
      // fails here every time — real OpenSCAD can't STL-export 2D geometry.
      // Retry once wrapped in a hairline linear_extrude (see
      // wrapAsThinExtrude) before giving up, so 2D shapes are at least
      // visible/selectable instead of silently missing from the viewport.
      // Context stays outside the wrapper — see wrapAsThinExtrude's
      // 2026-09-21 comment for the real bug this fixed.
      try {
        stats.engineCalls++;
        result = { bytes: await window.scadstudio.renderScad(flatSource) };
      } catch (secondError) {
        result = { firstError, secondError };
      }
    }
    cache.set(source, result);
    if (cache.size > RENDER_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return result;
  }, []);

  const runRender = useMemo(
    () =>
      createCoalescingRunner(async (src: string) => {
        setStatus('Rendering...');
        try {
          const { tree: parsedTree, errorCount } = await parseScad(src);
          const isCurrent = src === sourceRef.current;
          // Only adopt this parse for edit handlers if it is still the
          // current text; otherwise setSource has already parsed newer text.
          if (isCurrent) treeRef.current = parsedTree;
          setTree(parsedTree);
          setParseErrorCount(errorCount);
          const graph = buildSceneGraph(parsedTree, src);
          // M9: the working set is the top level, or the inside of the
          // drilled-into node (resolveFocus follows it through the edit).
          const r = isCurrent
            ? deriveFocus(parsedTree, src, errorCount === 0 ? 'yes' : 'unless-lost')
            : resolveFocus({ kind: 'document', path: filePathRef.current, text: src, tree: parsedTree }, focusRef.current, resolveModule);
          if (isCurrent) resolvedRef.current = r;
          const set = currentSet(r)!;
          if (isCurrent) sceneNodesRef.current = set.nodes;
          setSceneNodes(set.nodes);
          setResolved(r);

          // Isolated per-node renders, sequential, each through the cache.
          const meshes: NodeMesh[] = [];
          let disabledCount = 0;
          // First node that failed both render attempts, shown in the status
          // bar so a failure says which node and why (QC audit M4).
          let firstFailure: string | null = null;
          for (const node of set.nodes) {
            // `*` (disable) — real OpenSCAD never evaluates disabled
            // geometry at all, so skip the WASM call entirely rather than
            // rendering it and hiding it after the fact. The node stays
            // selectable via the editor (sceneNodes/tree don't depend on
            // nodeMeshes), just absent from the viewport — same fallback
            // shape as a node whose render call fails below, but tracked
            // separately so the status line doesn't read a deliberate
            // disable as a render failure.
            const modifier = nodeModifier(set, node);
            if (modifier === '*') {
              disabledCount++;
              continue;
            }
            // Only the bare primitive goes to WASM — translate/rotate/scale
            // are applied as a real three.js transform on the pivot group
            // instead of being baked into the rendered geometry (see
            // targetedPatch.ts's decomposeNode for why), inside the working
            // set's frame when drilled in (drillIn.ts).
            const job = isolatedRender(set, node, graph.context);
            const result = await renderCached(job.source, job.flatSource);
            if ('bytes' in result) {
              meshes.push({
                index: node.index,
                bytes: result.bytes,
                transform: job.transform,
                modifier,
                frame: set.frame,
                transformEditable: job.transformEditable,
              });
            } else {
              console.error(`[scadstudio] node ${node.index} render failed`, result.firstError, result.secondError);
              // A 2D node's first error is only "not a 3D object"; its
              // real reason is in the retry's error. For anything else the
              // first attempt's error is the real one.
              const firstMessage = renderErrorMessage(result.firstError);
              const reason = /not a 3D object/i.test(firstMessage) ? renderErrorMessage(result.secondError) : firstMessage;
              firstFailure ??= `node ${node.index + 1} (${node.label.trim()}): ${reason.split('\n')[0]}`;
            }
          }
          setNodeMeshes(meshes);

          // Selection. An insertion or merge says where its result is;
          // otherwise the selection follows its nodes through the edit
          // (nodeIdentity.ts), within one drill-in epoch.
          const prev = prevSetRef.current;
          if (pendingSelectLast.current) {
            pendingSelectLast.current = false;
            setSelectedIndices(set.nodes.length > 0 ? [set.nodes.length - 1] : []);
          } else if (pendingSelectAfterEdit.current !== null) {
            const idx = pendingSelectAfterEdit.current;
            pendingSelectAfterEdit.current = null;
            setSelectedIndices(idx < set.nodes.length ? [idx] : []);
          } else if (prev && prev.epoch === focusEpochRef.current) {
            const next = remapIndices(prev.fingerprints, set.fingerprints, selectedRef.current);
            setSelectedIndices(next);
            // The confirm-flash: after a typed edit, show which node the
            // selection is now on, so a wrong guess is visible.
            if (src === lastTypedSourceRef.current && next.length > 0) {
              renderStats().flashes++;
              setFlashToken((t) => t + 1);
            }
          } else {
            setSelectedIndices((p) => p.filter((i) => i < set.nodes.length));
          }
          if (isCurrent) prevSetRef.current = { epoch: focusEpochRef.current, fingerprints: set.fingerprints };

          // M9: the dimmed context, after the working set so that one is
          // interactive first: every other node at each level above it.
          const context: NodeMesh[] = [];
          for (let depth = 0; depth < r.focus.length; depth++) {
            const level = r.sets[depth];
            for (const node of level.nodes) {
              if (node.index === r.focus[depth].index) continue;
              const modifier = nodeModifier(level, node);
              if (modifier === '*' || modifier === '%') continue;
              const job = isolatedRender(level, node, graph.context);
              const result = await renderCached(job.source, job.flatSource);
              if ('bytes' in result) {
                context.push({
                  index: -1,
                  key: `${depth}:${node.index}`,
                  bytes: result.bytes,
                  transform: job.transform,
                  modifier,
                  frame: level.frame,
                });
              }
            }
          }
          setContextMeshes(context);
          renderStats().workingMeshes = meshes.length;
          renderStats().contextMeshes = context.length;

          const expected = set.nodes.length - disabledCount;
          const disabledSuffix = disabledCount > 0 ? ` (${disabledCount} disabled)` : '';
          const lostPrefix = r.lost ? 'Left drill-in (that node no longer exists). ' : '';
          setStatus(
            lostPrefix +
              (meshes.length === expected
                ? `Rendered${disabledSuffix}`
                : `Rendered ${meshes.length}/${expected} nodes${disabledSuffix}${firstFailure ? ` — ${firstFailure}` : ''}`),
          );
        } catch (err) {
          setStatus(`Render failed: ${(err as Error).message}`);
          console.error('[scadstudio] render failed', err);
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // M8: rescan the document's libraries whenever its set of `use`
  // directives or its location changes (relative paths resolve from its
  // folder), or a watched library changes on disk. Keyed on the directives,
  // not the whole text, so typing elsewhere doesn't re-read files.
  const useKey = useMemo(() => {
    if (!tree) return null;
    const uses: string[] = [];
    for (const child of tree.rootNode.children) {
      const concrete = child?.type === 'statement' ? child.child(0) : child;
      // Includes too: they don't supply tools, but the scan also tells the
      // main process which files to watch for re-rendering.
      if (concrete?.type === 'use_statement' || concrete?.type === 'include_statement') uses.push(concrete.text);
    }
    return uses.join('\n');
  }, [tree]);
  useEffect(() => {
    if (useKey === null) return;
    let cancelled = false;
    window.scadstudio
      .scanModules(sourceRef.current)
      .then((files) => {
        if (!cancelled) setLibraryFiles(files);
      })
      .catch((err) => console.error('[scadstudio] module scan failed', err));
    return () => {
      cancelled = true;
    };
  }, [useKey, filePath, libraryVersion]);
  useEffect(
    () =>
      window.scadstudio.onModulesChanged(() => {
        // A used file changed: its modules may have, and so may the
        // geometry of every call into it.
        renderCache.current.clear();
        setLibraryVersion((v) => v + 1);
        runRender(sourceRef.current);
      }),
    [runRender],
  );

  // Library files analyzed once per path+contents (definitions, recovered
  // ones included, and call sites), so an unchanged file isn't re-read on
  // every document edit: for BOSL2 that is about 0.6 s per render.
  const libraryAnalysis = useRef(new Map<string, { contents: string; analyzed: AnalyzedSource }>());
  const customTools = useMemo(() => {
    if (!tree) return [];
    const cache = libraryAnalysis.current;
    const analyzed: AnalyzedSource[] = [
      analyzeSource({ path: null, tree, useDirective: null, contents: tree.rootNode.text }, parseScadSync),
    ];
    const live = new Set<string>();
    for (const file of libraryFiles) {
      live.add(file.path);
      let entry = cache.get(file.path);
      if (!entry || entry.contents !== file.contents) {
        const parsed = parseScadSync(file.contents);
        if (!parsed) continue;
        entry = { contents: file.contents, analyzed: analyzeSource({ path: file.path, tree: parsed, useDirective: null, contents: file.contents }, parseScadSync) };
        parsed.delete();
        cache.set(file.path, entry);
      }
      analyzed.push({ ...entry.analyzed, useDirective: file.useDirective });
    }
    for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
    // In scope first, so a module both in scope and behind a nested use
    // keeps its in-scope definition.
    analyzed.sort((a, b) => Number(a.useDirective !== null) - Number(b.useDirective !== null));
    return toolsFromAnalyzed(analyzed);
  }, [tree, libraryFiles]);

  // M9: library files parsed for drill-in (kept, unlike the toolbar's
  // throwaway parses above, since a drilled-in working set points into
  // them). A changed file means re-resolving the focus.
  useEffect(() => {
    const docs = libraryDocsRef.current;
    const live = new Set<string>();
    let changed = false;
    for (const file of libraryFiles) {
      live.add(file.path);
      const existing = docs.get(file.path);
      if (existing && existing.text === file.contents) continue;
      const parsed = parseScadSync(file.contents);
      if (!parsed) continue;
      docs.set(file.path, { kind: 'library', path: file.path, text: file.contents, tree: parsed });
      changed = true;
    }
    for (const path of [...docs.keys()]) {
      if (!live.has(path)) {
        docs.delete(path);
        changed = true;
      }
    }
    if (changed && focusRef.current.length > 0) {
      setSource(sourceRef.current);
      runRender(sourceRef.current);
    }
  }, [libraryFiles, runRender, setSource]);

  // The document moved (Open, Save As): relative use/include paths now
  // resolve from somewhere else.
  useEffect(() => {
    renderCache.current.clear();
  }, [filePath]);

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
      lastTypedSourceRef.current = next;
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

  const openWith = useCallback(async (open: () => ReturnType<Window['scadstudio']['openFile']>) => {
    let result = await open();
    if (result && 'saveFirst' in result) {
      if (!(await handleSave(false))) return;
      result = await open();
    }
    if (!result || 'saveFirst' in result) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    // A new document starts at its top level.
    focusRef.current = [];
    focusEpochRef.current++;
    filePathRef.current = result.filePath;
    setSelectedIndices([]);
    setFilePath(result.filePath);
    setSavedSource(result.contents);
    setDocumentToken((t) => t + 1);
    setSource(result.contents);
    runRender(result.contents);
  }, [runRender, handleSave, setSource]);

  const handleOpen = useCallback(() => openWith(() => window.scadstudio.openFile()), [openWith]);
  // M9: the explicit, labeled way to edit a library module (it is view-only
  // when drilled into from a document that uses it).
  const handleOpenLibrary = useCallback((path: string) => openWith(() => window.scadstudio.openPath(path)), [openWith]);

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
    // M9: drilled in, the sketch becomes a child of the focused node, its
    // plane written in that node's local frame.
    const set = currentSet(resolvedRef.current);
    let next: string;
    if (set?.container) {
      const local = worldToFrame(set.frame, activeSketchPlane.origin, activeSketchPlane.rotationDeg);
      next = insertIntoContainer(sourceRef.current, set.container, sketchPolygonStatement(local.origin, local.rotationDeg, loops));
    } else {
      next = appendSketchPolygon(sourceRef.current, activeSketchPlane.origin, activeSketchPlane.rotationDeg, loops);
    }
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
    // M9: a nested sketch's plane is local to its working set's frame.
    const frame = currentSet(resolvedRef.current)?.frame;
    const world = frame
      ? frameToWorld(frame, selectedSketchProfile.origin, selectedSketchProfile.rotationDeg)
      : { origin: selectedSketchProfile.origin, rotationDeg: selectedSketchProfile.rotationDeg };
    setActiveSketchPlane(sketchPlaneFromTransform(world.origin, world.rotationDeg));
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

  // M8: the panel's fields, with real parameter names. A Custom module's
  // definition wins over a built-in signature (a user module shadows a
  // built-in of the same name).
  const panel = useMemo(() => {
    if (!selectedArgs) return null;
    const custom = customTools.find((t) => t.callName === selectedArgs.callName);
    const params = custom?.params ?? BUILTIN_SIGNATURES[selectedArgs.callName] ?? [];
    return { callName: selectedArgs.callName, custom: !!custom, fields: panelFields(selectedArgs, params, !!custom) };
  }, [selectedArgs, customTools]);

  // A parameter the call doesn't pass yet: add it as a named argument.
  const handleAddArg = useCallback(
    (name: string, valueText: string) => {
      const currentTree = treeRef.current;
      const node = sceneNodesRef.current.find((n) => n.index === primarySelectedIndex);
      if (!currentTree || !node || valueText.trim() === '') return;
      const patched = addNamedArgument(sourceRef.current, currentTree, node, name, valueText);
      if (patched === sourceRef.current) return;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(patched);
      runRender(patched);
    },
    [primarySelectedIndex, runRender],
  );

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
  // M8: one path for built-in and Custom tools alike (tools.ts insertTool).
  const handleInsertTool = useCallback(
    (tool: ToolDefinition) => {
      // M9: drilled in, a new statement joins the working set (the focused
      // node's children) instead of going to the end of the file.
      const set = currentSet(resolvedRef.current);
      const placed = set?.container
        ? insertIntoContainer(sourceRef.current, set.container, tool.statement)
        : appendStatement(sourceRef.current, tool.statement);
      const next = tool.useDirective ? addUseDirective(placed, tool.useDirective) : placed;
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
        handleInsertTool(builtinTool(op));
        return;
      }
      const next = wrapInExtrude(sourceRef.current, tree.rootNode, node, op);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(next);
      runRender(next);
    },
    [primarySelectedIndex, runRender, handleInsertTool],
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

  // M9 drill-in: make node `index`'s children the working set. Re-derived
  // synchronously, so the edit handlers work on the new set right away;
  // what was on screen stays as dimmed context until the render lands (with
  // the cache, usually at once), instead of the viewport blinking empty.
  const sketching = activeSketchPlane !== null || pickingFace;
  const handleDrill = useCallback(
    (index: number) => {
      const r = resolvedRef.current;
      const tree = treeRef.current;
      const set = currentSet(r);
      if (!r || !tree || !set || activeSketchPlane || pickingFace) return;
      if (!canDrill(set, index, resolveModule)) return;
      focusRef.current = [...r.focus, { index, siblings: set.fingerprints }];
      focusEpochRef.current++;
      selectionAnchor.current = null;
      setSelectedIndices([]);
      setContextMeshes((ctx) => [...ctx, ...nodeMeshes.map((m) => ({ ...m, index: -1, key: `prev:${m.index}` }))]);
      setNodeMeshes([]);
      const next = deriveFocus(tree, sourceRef.current, 'unless-lost');
      resolvedRef.current = next;
      sceneNodesRef.current = currentSet(next)!.nodes;
      setSceneNodes(sceneNodesRef.current);
      setResolved(next);
      runRender(sourceRef.current);
    },
    // selectionAnchor is a ref declared below; stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSketchPlane, pickingFace, resolveModule, deriveFocus, runRender, nodeMeshes],
  );

  // Back out to working set `depth` (0 = the top level), selecting the node
  // that was drilled into there, the way Figma and Onshape step out.
  const handleStepOut = useCallback(
    (depth: number) => {
      const r = resolvedRef.current;
      const tree = treeRef.current;
      if (!r || !tree || depth >= r.focus.length || activeSketchPlane || pickingFace) return;
      const cameFrom = r.focus[depth].index;
      focusRef.current = r.focus.slice(0, depth);
      focusEpochRef.current++;
      selectionAnchor.current = cameFrom;
      setSelectedIndices([cameFrom]);
      setNodeMeshes([]);
      const next = deriveFocus(tree, sourceRef.current, 'unless-lost');
      resolvedRef.current = next;
      sceneNodesRef.current = currentSet(next)!.nodes;
      setSceneNodes(sceneNodesRef.current);
      setResolved(next);
      runRender(sourceRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSketchPlane, pickingFace, deriveFocus, runRender],
  );

  // Escape steps out one level: out of a sketch that has nothing to lose
  // (a pending tool click is dropped first), out of Pick Face, else out of
  // one drill-in level. Not while typing in the editor or a field.
  const escapeRef = useRef<() => void>(() => {});
  escapeRef.current = () => {
    if (pickingFace) {
      setPickingFace(false);
      return;
    }
    if (activeSketchPlane) {
      if (toolAnchors.length > 0) setToolAnchors([]);
      else if (sketchHistory.length === 0) handleExitSketch();
      else setStatus('Escape: Finish/Save or Exit/Cancel the sketch first (it has changes)');
      return;
    }
    const depth = resolvedRef.current?.focus.length ?? 0;
    if (depth > 0) handleStepOut(depth - 1);
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.monaco-editor, input, textarea, select, [contenteditable="true"]')) return;
      escapeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const workingSet = currentSet(resolved);
  const focusDepth = resolved?.focus.length ?? 0;
  const readOnly = workingSet?.readOnly ?? null;
  // Transform edits need the working set's frame as a matrix (drillIn.ts);
  // sketches also need it rigid, since a sketch plane can't be scaled.
  const transformEditable = !readOnly && (workingSet?.bakedPrefix ?? '') === '';
  const sketchAllowed = transformEditable && (!workingSet || frameIsRigid(workingSet.frame));
  const selectedCanDrill = useMemo(() => {
    if (!workingSet || primarySelectedIndex === null || selectedIndices.length !== 1) return null;
    return drillLabel(workingSet, primarySelectedIndex, resolveModule);
  }, [workingSet, primarySelectedIndex, selectedIndices.length, resolveModule]);
  const visibleCustomTools = workingSet?.editingModule ? customTools.filter((t) => t.callName !== workingSet.editingModule) : customTools;

  const breadcrumb =
    focusDepth > 0 || selectedCanDrill ? (
      <div
        style={{
          position: 'absolute',
          left: 8,
          bottom: 8,
          maxWidth: '70%',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontSize: 12,
          fontFamily: 'sans-serif',
          color: '#ddd',
          pointerEvents: 'none',
        }}
      >
        {focusDepth > 0 && resolved && (
          <nav
            aria-label="Breadcrumb"
            data-testid="breadcrumb"
            style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, background: 'rgba(30,30,30,0.85)', padding: '4px 8px', borderRadius: 4, pointerEvents: 'auto' }}
          >
            {resolved.crumbs.map((crumb, i) => {
              const last = i === resolved.crumbs.length - 1;
              return (
                <span key={crumb.depth} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {i > 0 && <span style={{ opacity: 0.5 }}>›</span>}
                  {last && !sketching ? (
                    <span aria-current="location" style={{ fontWeight: 'bold' }}>
                      {crumb.label}
                    </span>
                  ) : (
                    <button
                      onClick={() => handleStepOut(crumb.depth)}
                      disabled={sketching}
                      title={sketching ? 'Finish or exit the sketch first' : `Back to ${crumb.label}`}
                      style={{ background: 'none', border: 'none', color: '#6cb6ff', cursor: 'pointer', padding: 0, fontSize: 12, textDecoration: 'underline' }}
                    >
                      {crumb.label}
                    </button>
                  )}
                </span>
              );
            })}
            {sketching && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ opacity: 0.5 }}>›</span>
                <span aria-current="location" style={{ fontWeight: 'bold' }}>
                  Sketch
                </span>
              </span>
            )}
            <span style={{ opacity: 0.55, marginLeft: 6 }}>Esc: step out</span>
          </nav>
        )}
        {readOnly && (
          <div
            role="status"
            style={{ background: 'rgba(60,45,20,0.92)', padding: '4px 8px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'auto' }}
          >
            <span>
              {readOnly.moduleName}() comes from {readOnly.path.split(/[\\/]/).pop()}, a library: view-only here.
            </span>
            <button onClick={() => void handleOpenLibrary(readOnly.path)}>Open {readOnly.path.split(/[\\/]/).pop()} to edit</button>
          </div>
        )}
        {!readOnly && workingSet?.editingModule && (
          <div role="status" style={{ background: 'rgba(40,30,60,0.9)', padding: '4px 8px', borderRadius: 4 }}>
            Editing module {workingSet.editingModule}(): changes apply to every {workingSet.editingModule}() call.
          </div>
        )}
        {!readOnly && focusDepth > 0 && !transformEditable && (
          <div role="status" style={{ background: 'rgba(30,30,30,0.85)', padding: '4px 8px', borderRadius: 4 }}>
            Placed by a computed transform: move/rotate/scale are off here, parameters still edit.
          </div>
        )}
        {selectedCanDrill && !sketching && (
          <button
            onClick={() => primarySelectedIndex !== null && handleDrill(primarySelectedIndex)}
            title="Edit what's inside: its children become the working set (or double-click the shape)"
            style={{ alignSelf: 'flex-start', pointerEvents: 'auto' }}
          >
            Open {selectedCanDrill} ▸
          </button>
        )}
      </div>
    ) : null;

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
        {readOnly && <span style={{ opacity: 0.7 }}>Viewing a library module (read-only)</span>}
        {!readOnly && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Insert:
          {INSERT_TOOLS.map((tool) => (
            <button key={tool.id} onClick={() => handleInsertTool(tool)}>
              {tool.label}
            </button>
          ))}
        </span>
        )}
        {!readOnly && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Extrude{primarySelectedIndex !== null ? ' (selected)' : ''}:
          {EXTRUDE_TOOLS.map((tool) => (
            <button key={tool.id} onClick={() => handleExtrude(tool.callName)}>
              {tool.label}
            </button>
          ))}
        </span>
        )}
        {!readOnly && visibleCustomTools.length > 0 && (
          <span
            role="group"
            aria-label="Custom modules"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px', borderLeft: '2px solid #c586c0' }}
          >
            Custom:
            {visibleCustomTools.length > CUSTOM_TOOL_LIMIT && (
              <input
                type="search"
                aria-label="Filter custom modules"
                placeholder={`Filter ${visibleCustomTools.length} modules`}
                value={customFilter}
                onChange={(e) => setCustomFilter(e.target.value)}
                size={14}
              />
            )}
            {visibleCustomTools
              .filter((t) => t.label.toLowerCase().includes(customFilter.trim().toLowerCase()))
              .slice(0, CUSTOM_TOOL_LIMIT)
              .map((tool) => (
                <button
                  key={tool.id}
                  title={toolTitle(tool)}
                  onClick={() => handleInsertTool(tool)}
                  style={{ fontStyle: tool.useDirective ? 'italic' : 'normal' }}
                >
                  {tool.label}
                </button>
              ))}
          </span>
        )}
        {(sketchAllowed || sketching) && (
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
        )}
        {transformEditable && (
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
        )}
        {transformEditable && gizmoMode === 'rotate' && (
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
        {transformEditable && primarySelectedIndex !== null && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {MIRROR_AXIS_BUTTONS.map(({ axis, label }) => (
              <button key={axis} onClick={() => handleMirrorAxis(axis)}>
                {label}
              </button>
            ))}
          </span>
        )}
        {!readOnly && primarySelectedIndex !== null && (
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
        {transformEditable && primarySelectedIndex !== null && (
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
        {transformEditable && primarySelectedIndex !== null && (
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
        {!readOnly && selectedIndices.length >= 2 && (
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
      {panel && panel.fields.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            padding: '6px 12px',
            background: '#252526',
            color: '#ccc',
            fontSize: 12,
            borderBottom: '1px solid #333',
          }}
        >
          <span style={{ opacity: 0.7 }}>{panel.callName}:</span>
          {panel.fields.map((field, i) => (
            // Keyed on the value text too, not just index: after a commit
            // lands, the canonical (possibly reformatted) text should
            // replace whatever the user typed, which an uncontrolled input
            // only does on remount — see handleArgCommit's comment.
            <ParamField
              key={`${i}-${field.label}-${field.valueText}`}
              field={field}
              disabled={!!readOnly}
              onCommit={(text) => (field.argIndex !== null ? handleArgCommit(field.argIndex, text) : handleAddArg(field.label, text))}
            />
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Editor
            value={source}
            onChange={handleSourceChange}
            nodes={readOnly ? [] : sceneNodes}
            focusRange={
              !readOnly && workingSet?.container
                ? { start: workingSet.container.body.start, end: workingSet.container.body.end }
                : null
            }
            selectedIndex={readOnly ? null : primarySelectedIndex}
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
            contextMeshes={contextMeshes}
            onDrill={handleDrill}
            flashToken={flashToken}
            overlay={breadcrumb}
            editable={!readOnly}
            cuttersFirst={workingSet?.containerCall === 'difference'}
          />
        </div>
      </div>
    </div>
  );
}

// M8: one parameter-panel field, its widget inferred from the parameter's
// default (or the argument's own literal; see paramPanel.ts). Every widget
// commits OpenSCAD source text, so a commit is the same targeted argument
// patch whichever widget made it.
function ParamField({ field, onCommit, disabled = false }: { field: PanelField; onCommit: (valueText: string) => void; disabled?: boolean }) {
  const unset = field.valueText === null;
  const shown = field.valueText ?? field.param?.defaultText ?? '';
  const label = `Parameter ${field.label}`;
  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  };
  const title = field.param?.required
    ? `${field.label} is required (no default)`
    : unset
      ? `Not passed: uses the default ${field.param?.defaultText ?? ''}. Edit to pass a value.`
      : undefined;
  let control: React.ReactNode;
  switch (field.widget) {
    case 'checkbox':
      control = (
        <input
          type="checkbox"
          aria-label={label}
          defaultChecked={shown.trim() === 'true'}
          onChange={(e) => onCommit(e.target.checked ? 'true' : 'false')}
        />
      );
      break;
    case 'number':
    case 'angle':
      control = (
        <>
          <input
            type="number"
            aria-label={label}
            step="any"
            size={5}
            style={{ width: 64 }}
            defaultValue={unset ? undefined : shown}
            placeholder={unset ? shown : undefined}
            onBlur={(e) => {
              if (e.target.value !== '' && e.target.value !== field.valueText) onCommit(e.target.value);
            }}
            onKeyDown={commitOnEnter}
          />
          {field.widget === 'angle' && (
            <input
              type="range"
              aria-label={`${label} slider`}
              min={Math.min(0, Number(shown) || 0)}
              max={Math.max(360, Number(shown) || 0)}
              step={1}
              defaultValue={Number(shown) || 0}
              style={{ width: 90 }}
              onPointerUp={(e) => onCommit(e.currentTarget.value)}
              onKeyUp={(e) => onCommit(e.currentTarget.value)}
            />
          )}
          {field.widget === 'angle' && <span style={{ opacity: 0.6 }}>°</span>}
        </>
      );
      break;
    case 'xyz': {
      const parts = parseVec3(shown) ?? ['0', '0', '0'];
      const commitXyz = (container: HTMLElement) => {
        const values = [...container.querySelectorAll('input')].map((input, k) => (input.value === '' ? parts[k] : input.value));
        const next = `[${values.join(', ')}]`;
        if (unset || next.replace(/\s/g, '') !== shown.replace(/\s/g, '')) onCommit(next);
      };
      control = (
        <span
          style={{ display: 'flex', gap: 2 }}
          onBlur={(e) => {
            // Commit once focus leaves the whole X/Y/Z group.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitXyz(e.currentTarget);
          }}
        >
          {(['X', 'Y', 'Z'] as const).map((axis, k) => (
            <input
              key={axis}
              type="number"
              aria-label={`${label} ${axis}`}
              step="any"
              style={{ width: 52 }}
              defaultValue={unset ? undefined : parts[k]}
              placeholder={unset ? parts[k] : axis}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitXyz(e.currentTarget.parentElement!);
              }}
            />
          ))}
        </span>
      );
      break;
    }
    case 'text': {
      const text = /^\s*"/.test(shown) ? unquoteScadString(shown) : shown;
      control = (
        <input
          type="text"
          aria-label={label}
          size={Math.max(6, text.length)}
          defaultValue={unset ? undefined : text}
          placeholder={unset ? text : undefined}
          onBlur={(e) => {
            const next = quoteScadString(e.target.value);
            if ((unset && e.target.value !== '') || (!unset && next !== field.valueText)) onCommit(next);
          }}
          onKeyDown={commitOnEnter}
        />
      );
      break;
    }
    default:
      control = (
        <input
          type="text"
          aria-label={label}
          size={Math.max(4, shown.length)}
          defaultValue={unset ? undefined : shown}
          placeholder={unset ? shown || 'required' : undefined}
          onBlur={(e) => {
            if (e.target.value.trim() !== '' && e.target.value !== field.valueText) onCommit(e.target.value);
          }}
          onKeyDown={commitOnEnter}
        />
      );
  }
  return (
    // A fieldset disables every input of the widget at once (read-only
    // library modules, M9).
    <fieldset disabled={disabled} style={{ display: 'contents' }}>
    <span style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: unset ? 0.75 : 1 }} title={title}>
      <span style={{ opacity: 0.6, fontStyle: unset ? 'italic' : 'normal', color: field.param?.required ? '#e8a05a' : undefined }}>
        {field.label}:
      </span>
      {control}
    </span>
    </fieldset>
  );
}
