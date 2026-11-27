import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tree } from 'web-tree-sitter';
import { Editor } from './components/Editor';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  Viewport,
  type GizmoMode,
  type NodeMesh,
  type RotateSpace,
  type SelectMode,
  type SketchPlaneKind,
  type ActiveSketchPlane,
  type FocusRequest,
  SHADING_OPTIONS,
  type ShadingMode,
  buildGlobalSketchPlane,
  buildFaceSketchPlane,
  sketchPlaneFromTransform,
} from './components/Viewport';
import { loadSnapSettings, saveSnapSettings, type SnapSettings } from './sketchSnap';
import { parseScad, parseScadSync } from './scadParser';
import { buildSceneGraph, type SceneNode } from './sceneGraph';
import {
  patchTransform,
  primitiveOnlySlice,
  wrapAsThinExtrude,
  decomposeNode,
  isTextNode,
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
  formatNumber,
  type NodeTransform,
  type TransformExprs,
  type BooleanOp,
  type ExtrudeOp,
  type Modifier,
  type ColorVector,
} from './targetedPatch';
import { appendSketchPolygon, appendStatement, sketchPolygonStatement, sketchTextStatement } from './primitives';
import {
  callDefinition,
  canDrill,
  drillLabel,
  guardInactive,
  partPath,
  staticCondition,
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
import { BUILTIN_SIGNATURES, BUILTIN_TOOL_DEFINITIONS, LIST_UNSET_BUILTINS, addUseDirective, builtinTool, type ToolDefinition } from './tools';
import { analyzeSource, toolsFromAnalyzed, type AnalyzedSource } from './moduleIntrospection';
import { panelFields, parseVec3, quoteScadString, unquoteScadString, type PanelField } from './paramPanel';
import { findOption, fontGroups, isFontAvailable, type FontEntry } from './fontOptions';
import { SettingsDialog, type AppSettingsState } from './components/SettingsDialog';
import { drivenAxes, positionAnchors } from './linkedDrag';
import { VariablesPanel, type IncludedSection, type ModuleSection, type VariableScope } from './components/VariablesPanel';
import { ToolPanel } from './components/ToolPanel';
import { FloatingWindow, WindowRow, WindowSection } from './components/FloatingWindow';
import { defaultExtrudeStatement, extrudeArgs, initialTool, pickIntoTool, toolSlotIndices, type ToolKind, type ToolState } from './toolWindows';
import {
  applyEdits,
  deleteVariable,
  insertVariable,
  isValidName,
  makeVariable,
  moduleAt,
  nameAvailable,
  readModuleVariables,
  readVariables,
  renameVariable,
  setVariableValue,
  uniqueName,
  variableReferences,
  type VariableInfo,
} from './variables';
import { currentOffset, planRelate } from './relate';
import { patternCountEdits, patternSpacingEdits, readPattern, wrapInPattern, type PatternOptions } from './pattern';
import { geometryBox, partExtents, translateComponents } from './extents';
import { add, constant, format as formatLin, fromTerm, sub, term, value as linValue } from './linExpr';
import { gizmoAxes } from './gizmoLocks';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

type ModuleSourceFile = Awaited<ReturnType<Window['scadstudio']['scanModules']>>[number];
import { createCoalescingRunner } from './coalescingRunner';
import { RenderCache, type CachedRender } from './renderCache';
import { cacheKey, chooseQuality, FULL, likelyFastAtFull, PartTimings, type PreviewMode, type Quality } from './renderQuality';
import { RenderDetailBadge } from './components/RenderDetailBadge';
import { isEngineCrash, isRenderCancelled, renderErrorMessage } from './renderErrors';
import { RenderProgressOverlay, useRenderIsSlow, type RenderProgress } from './components/RenderProgress';
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
  { tool: 'text', label: 'Text' },
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
    case 'text':
      return 'click where the text starts (its baseline); edit the words and font in the panel';
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

// M11: whether `text` is one OpenSCAD expression.
function isExpression(text: string): boolean {
  const tree = parseScadSync(`__m11_check = ${text};`);
  if (!tree) return false;
  try {
    return !tree.rootNode.hasError && tree.rootNode.namedChildCount === 1;
  } finally {
    tree.delete();
  }
}

const NUMBER_TEXT = /^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

function copyExprs(t: NodeTransform): TransformExprs {
  return t.exprs
    ? { translate: [...t.exprs.translate], rotateDeg: [...t.exprs.rotateDeg], scale: [...t.exprs.scale] }
    : { translate: [null, null, null], rotateDeg: [null, null, null], scale: [null, null, null] };
}

// M11: a part's own geometry box (rotate/scale applied, not translate),
// for the relate and pattern tools when a part's size can't be written as
// an expression.
function meshBox(mesh: NodeMesh | undefined): { min: number[]; max: number[] } | null {
  if (!mesh) return null;
  const geometry = new STLLoader().parse(mesh.bytes.slice().buffer as ArrayBuffer);
  try {
    return geometryBox(geometry, mesh.transform.rotateDeg, mesh.transform.scale);
  } finally {
    geometry.dispose();
  }
}

// M10a: thrown inside a render when Cancel was pressed between parts (same
// text as the main process's, so isRenderCancelled matches both).
const RENDER_CANCELLED = 'Render cancelled';

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

// The per-node render cache lives in renderCache.ts (bounded by entries and
// by total mesh size). Cleared when a used/included file changes on disk or
// the document moves (relative paths resolve differently), the two ways the
// same text can mean different geometry.

// Test hook: counts engine calls and cache hits, so e2e tests can check that
// an edit re-renders only what it changed.
interface RenderStats {
  engineCalls: number;
  cacheHits: number;
  flashes: number;
  // Meshes in the working set and in the dimmed context after the last render.
  workingMeshes: number;
  contextMeshes: number;
  // M18: meshes on screen that are previews.
  previewMeshes: number;
}
function renderStats(): RenderStats {
  const w = window as unknown as { __scadstudioRenderStats?: RenderStats };
  w.__scadstudioRenderStats ??= { engineCalls: 0, cacheHits: 0, flashes: 0, workingMeshes: 0, contextMeshes: 0, previewMeshes: 0 };
  return w.__scadstudioRenderStats;
}

function topModuleDefinition(doc: SourceDoc, name: string) {
  for (const stmt of doc.tree.rootNode.children) {
    const def = stmt?.type === 'statement' ? stmt.child(0) : stmt;
    if (def?.type === 'module_definition' && def.childForFieldName('name')?.text === name) return def;
  }
  return null;
}

// Both attempts said only that the node has no geometry (an `if` whose
// condition is false, an empty loop): nothing to show, but nothing went
// wrong either. An unknown module is empty too, but comes with a warning
// saying so, and that stays a failure (QC audit M4).
function isEmptyResult(result: CachedRender): boolean {
  if ('bytes' in result) return false;
  return [result.firstError, result.secondError].every((e) => {
    const lines = renderErrorMessage(e).split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length > 0 && lines.every((l) => /^Current top level object is empty/i.test(l));
  });
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
  // Set when a file is opened: the camera fits once that file's first
  // render has landed. Fitting on the new path alone framed whatever was
  // on screen before the render (the previous document), so a large part
  // opened with the camera inside it.
  const fitAfterRenderRef = useRef(false);
  // M10a: set when leaving sketch mode with a new or changed shape. Once it
  // has rendered, the view frames it (keeping the angle the user had before
  // the sketch), rather than resetting the whole view (Jordan, 2026-11-27).
  const focusAfterRenderRef = useRef(false);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
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
  // preference, not part of any one sketch. M10b: and across restarts.
  const [snapSettings, setSnapSettingsState] = useState<SnapSettings>(() => loadSnapSettings(typeof localStorage === 'undefined' ? null : localStorage));
  const setSnapSettings = useCallback((update: (s: SnapSettings) => SnapSettings) => {
    setSnapSettingsState((s) => {
      const next = update(s);
      saveSnapSettings(typeof localStorage === 'undefined' ? null : localStorage, next);
      return next;
    });
  }, []);
  // M10b: the viewport's shading mode (menu in the top bar), remembered.
  const [shading, setShadingState] = useState<ShadingMode>(() => {
    try {
      const v = localStorage.getItem('scadstudio.shading');
      return v === 'edges' || v === 'wireframe' ? v : 'shaded';
    } catch {
      return 'shaded';
    }
  });
  const setShading = useCallback((mode: ShadingMode) => {
    setShadingState(mode);
    try {
      localStorage.setItem('scadstudio.shading', mode);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
  }, []);
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
  const nodeMeshesRef = useRef(nodeMeshes);
  nodeMeshesRef.current = nodeMeshes;
  // See Viewport.tsx's SelectMode/ViewportProps.selectedIndices comments for
  // ordering. The last entry is the "primary" selection that gizmo/mirror/
  // color/parameter-panel editing (all single-target operations) act on.
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const primarySelectedIndex = selectedIndices.length > 0 ? selectedIndices[selectedIndices.length - 1] : null;
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  // M11: the variables sidebar, the Distance/Align/Pattern tool panel and
  // the Make variable name prompt.
  // M11: the editor cursor's offset (a user move), for the module scope.
  const [cursorOffset, setCursorOffset] = useState<number | null>(null);
  // M11: files the document includes, for their variables.
  const [includedFiles, setIncludedFiles] = useState<{ path: string; contents: string; via: string }[]>([]);
  // M11: the variables sidebar remembers whether it was last shown.
  const [variablesOpen, setVariablesOpenState] = useState(() => {
    try {
      return localStorage.getItem('scadstudio.variablesOpen') !== 'false';
    } catch {
      return true;
    }
  });
  const setVariablesOpen = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    setVariablesOpenState((open) => {
      const value = typeof next === 'function' ? next(open) : next;
      try {
        localStorage.setItem('scadstudio.variablesOpen', String(value));
      } catch {
        // Storage unavailable: the choice lasts for this session only.
      }
      return value;
    });
  }, []);
  const [tool, setTool] = useState<ToolState | null>(null);
  const toolRef = useRef<ToolState | null>(null);
  toolRef.current = tool;
  const [makeVar, setMakeVar] = useState<{
    target: { kind: 'arg'; argIndex: number | null; label: string; defaultText: string | null } | { kind: 'position'; axis: 0 | 1 | 2 };
    name: string;
    error: string | null;
  } | null>(null);
  const [rotateSpace, setRotateSpace] = useState<RotateSpace>('local');
  const [status, setStatus] = useState('Rendering...');
  // M10a: the render in progress (null when idle), for the progress overlay
  // and the greyed-out stale meshes. cancelGenRef counts Cancel presses; a
  // render that sees it change stops between parts.
  // The progress itself lives in a ref the overlay reads on its own timer,
  // so a working set of many (mostly cached) parts doesn't re-render the
  // whole app once per part; only the start and end are React state.
  const [renderStartedAt, setRenderStartedAt] = useState<number | null>(null);
  const renderProgressRef = useRef<RenderProgress | null>(null);
  const renderIsSlow = useRenderIsSlow(renderStartedAt);
  const renderingRef = useRef(false);
  const cancelGenRef = useRef(0);
  // M18: fast preview. How long each part took at full detail, the
  // previous working set (to carry timings through an edit), Render's
  // one-shot "everything at full detail", the parts an open Distance /
  // Align / Pattern tool measures (always full: a coarser circle is
  // smaller), and the preview settings (from Settings > Rendering).
  const timingsRef = useRef(new PartTimings());
  const prevTimingSetRef = useRef<{ epoch: number; fingerprints: NodeFingerprint[]; sources: string[] } | null>(null);
  const forceFullRef = useRef(false);
  const toolFullIndicesRef = useRef<Set<number>>(new Set());
  const previewSettingsRef = useRef<{ mode: PreviewMode; segments: number }>({ mode: 'auto', segments: 24 });
  // Parts on screen after the last render, and how many are previews.
  const [renderDetail, setRenderDetail] = useState<{ parts: number; reduced: number } | null>(null);
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
  // the Boolean window's Apply).
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
  const renderCache = useRef(new RenderCache());
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
  // flat (2D) retry; both outcomes are cached. M18: at the quality asked
  // for. A full result serves a preview request too (better, and free), a
  // preview that lowered nothing is stored as the full render, and an
  // unmeasured part whose full render looks cheap from its preview is
  // rendered in full straight away (see likelyFastAtFull).
  const renderCached = useCallback(async (source: string, flatSource: string, quality: Quality = FULL, promote = false): Promise<CachedRender> => {
    const cache = renderCache.current;
    const stats = renderStats();
    const fullHit = cache.get(source);
    if (fullHit) {
      stats.cacheHits++;
      return fullHit;
    }
    const key = cacheKey(source, quality);
    if (quality.kind === 'preview') {
      const hit = cache.get(key);
      if (hit) {
        stats.cacheHits++;
        return hit;
      }
    }
    const segments = quality.kind === 'preview' ? quality.segments : null;
    const attempt = async (src: string): Promise<CachedRender> => {
      stats.engineCalls++;
      const r = await window.scadstudio.renderMesh(src, segments);
      if (!r.reduced) timingsRef.current.set(source, r.engineMs);
      return { bytes: r.bytes, reduced: r.reduced, engineMs: r.engineMs, detailFactor: r.detailFactor };
    };
    let result: CachedRender;
    try {
      result = await attempt(source);
    } catch (firstError) {
      // M10a: Cancel is not a result of this source; don't cache it.
      if (isRenderCancelled(firstError)) throw firstError;
      // M7: a pure-2D node (bare square/circle/polygon, a 2D boolean, ...)
      // fails here every time — real OpenSCAD can't STL-export 2D geometry.
      // Retry once wrapped in a hairline linear_extrude (see
      // wrapAsThinExtrude) before giving up, so 2D shapes are at least
      // visible/selectable instead of silently missing from the viewport.
      // Context stays outside the wrapper — see wrapAsThinExtrude's
      // 2026-09-21 comment for the real bug this fixed.
      //
      // Not when the engine itself died (out of memory, usually): the
      // retry would redo the same heavy work and very likely die again.
      if (isEngineCrash(firstError)) {
        result = { firstError, secondError: firstError };
      } else {
        try {
          // M10b: remembered, so Extrude knows the part is 2D.
          result = { ...(await attempt(flatSource)), flat: true };
        } catch (secondError) {
          if (isRenderCancelled(secondError)) throw secondError;
          result = { firstError, secondError };
        }
      }
    }
    if ('bytes' in result && result.reduced) {
      cache.set(key, result);
      if (promote && likelyFastAtFull(result.engineMs ?? Infinity, result.detailFactor ?? 1)) return renderCached(source, flatSource, FULL);
    } else {
      // A failure is cached at the quality that produced it.
      cache.set('bytes' in result ? source : key, result);
    }
    return result;
  }, []);

  const runRender = useMemo(
    () =>
      createCoalescingRunner(async (src: string) => {
        setStatus('Rendering...');
        // M10a: progress, and a way to stop between parts on Cancel (the
        // render process itself is killed by the main process).
        const generation = cancelGenRef.current;
        const checkCancelled = () => {
          if (cancelGenRef.current !== generation) throw new Error(RENDER_CANCELLED);
        };
        renderingRef.current = true;
        // M18: Render (F6) asks for this one run at full detail.
        const forceFull = forceFullRef.current;
        forceFullRef.current = false;
        const { mode: previewMode, segments: previewSegments } = previewSettingsRef.current;
        let reducedParts = 0;
        const startedAt = performance.now();
        renderProgressRef.current = { startedAt, part: 0, parts: 0, stage: null, context: false };
        setRenderStartedAt(startedAt);
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
          // Nodes that render nothing in the model as it stands: inside an
          // if branch it doesn't take (`if ($preview)` is skipped without
          // asking the engine), or an `if (flag)` that is false. Not
          // failures, so they don't count against "Rendered".
          let emptyCount = 0;
          // First node that failed both render attempts, shown in the status
          // bar so a failure says which node and why (QC audit M4).
          let firstFailure: string | null = null;
          // M18: every part's isolated render, and its full-detail timing
          // (carried from before the edit for a part whose text changed).
          const jobs = set.nodes.map((node) => isolatedRender(set, node, graph.context));
          const prevTiming = prevTimingSetRef.current;
          const timings = timingsRef.current.forSet(
            { fingerprints: set.fingerprints, sources: jobs.map((j) => j.source) },
            prevTiming && prevTiming.epoch === focusEpochRef.current ? prevTiming : null,
          );
          if (isCurrent) prevTimingSetRef.current = { epoch: focusEpochRef.current, fingerprints: set.fingerprints, sources: jobs.map((j) => j.source) };
          for (const [position, node] of set.nodes.entries()) {
            renderProgressRef.current = { startedAt, part: position + 1, parts: set.nodes.length, stage: null, context: false };
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
            if (guardInactive(set.guards[node.index] ?? null)) {
              emptyCount++;
              continue;
            }
            // Only the bare primitive goes to WASM — translate/rotate/scale
            // are applied as a real three.js transform on the pivot group
            // instead of being baked into the rendered geometry (see
            // targetedPatch.ts's decomposeNode for why), inside the working
            // set's frame when drilled in (drillIn.ts).
            const job = jobs[position];
            const quality = chooseQuality(previewMode, previewSegments, timings[position], forceFull || toolFullIndicesRef.current.has(node.index));
            const result = await renderCached(job.source, job.flatSource, quality, previewMode === 'auto' && timings[position] === undefined);
            checkCancelled();
            if ('bytes' in result) {
              if (result.reduced) reducedParts++;
              meshes.push({
                reduced: result.reduced === true,
                flat: result.flat === true,
                index: node.index,
                bytes: result.bytes,
                transform: job.transform,
                modifier,
                frame: set.frame,
                transformEditable: job.transformEditable,
                upright: !set.readOnly && isTextNode(parsedTree.rootNode, node),
              });
            } else if (isEmptyResult(result)) {
              emptyCount++;
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
          const focusIndex = (index: number) => {
            if (!focusAfterRenderRef.current) return;
            focusAfterRenderRef.current = false;
            setFocusRequest((r) => ({ token: (r?.token ?? 0) + 1, indices: [index] }));
          };
          if (pendingSelectLast.current) {
            pendingSelectLast.current = false;
            setSelectedIndices(set.nodes.length > 0 ? [set.nodes.length - 1] : []);
            if (set.nodes.length > 0) focusIndex(set.nodes.length - 1);
          } else if (pendingSelectAfterEdit.current !== null) {
            const idx = pendingSelectAfterEdit.current;
            pendingSelectAfterEdit.current = null;
            setSelectedIndices(idx < set.nodes.length ? [idx] : []);
            if (idx < set.nodes.length) focusIndex(idx);
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
          const contextTotal = r.focus.reduce((n, _f, depth) => n + r.sets[depth].nodes.length - 1, 0);
          let contextDone = 0;
          for (let depth = 0; depth < r.focus.length; depth++) {
            const level = r.sets[depth];
            for (const node of level.nodes) {
              if (node.index === r.focus[depth].index) continue;
              const modifier = nodeModifier(level, node);
              if (modifier === '*' || modifier === '%') continue;
              if (guardInactive(level.guards[node.index] ?? null)) continue;
              const job = isolatedRender(level, node, graph.context);
              contextDone++;
              renderProgressRef.current = { startedAt, part: contextDone, parts: contextTotal, stage: null, context: true };
              const known = timingsRef.current.get(job.source);
              const quality = chooseQuality(previewMode, previewSegments, known, forceFull);
              const result = await renderCached(job.source, job.flatSource, quality, previewMode === 'auto' && known === undefined);
              checkCancelled();
              if ('bytes' in result) {
                if (result.reduced) reducedParts++;
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
          if (isCurrent && fitAfterRenderRef.current) {
            fitAfterRenderRef.current = false;
            setResetViewToken((t) => t + 1);
          }
          renderStats().workingMeshes = meshes.length;
          renderStats().contextMeshes = context.length;
          renderStats().previewMeshes = reducedParts;
          setRenderDetail({ parts: meshes.length + context.length, reduced: reducedParts });

          const expected = set.nodes.length - disabledCount - emptyCount;
          const suffixParts = [
            ...(disabledCount > 0 ? [`${disabledCount} disabled`] : []),
            ...(emptyCount > 0 ? [`${emptyCount} empty`] : []),
          ];
          const disabledSuffix = suffixParts.length > 0 ? ` (${suffixParts.join(', ')})` : '';
          const lostPrefix = r.lost ? 'Left drill-in (that node no longer exists). ' : '';
          setStatus(
            lostPrefix +
              (meshes.length === expected
                ? `Rendered${reducedParts > 0 ? ' (preview)' : ''}${disabledSuffix}`
                : `Rendered ${meshes.length}/${expected} nodes${disabledSuffix}${firstFailure ? ` — ${firstFailure}` : ''}`),
          );
        } catch (err) {
          if (isRenderCancelled(err)) {
            // The last finished render stays on screen (no longer greyed).
            setStatus('Render cancelled');
          } else {
            setStatus(`Render failed: ${(err as Error).message}`);
            console.error('[scadstudio] render failed', err);
          }
        } finally {
          renderingRef.current = false;
          renderProgressRef.current = null;
          setRenderStartedAt(null);
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
  // M11: the included files, rescanned on the same triggers.
  useEffect(() => {
    if (useKey === null) return;
    let cancelled = false;
    window.scadstudio
      .scanIncludes(sourceRef.current)
      .then((files) => {
        if (!cancelled) setIncludedFiles(files);
      })
      .catch((err) => console.error('[scadstudio] include scan failed', err));
    return () => {
      cancelled = true;
    };
  }, [useKey, filePath, libraryVersion]);
  useEffect(() => setCursorOffset(null), [filePath]);
  useEffect(
    () =>
      window.scadstudio.onModulesChanged(() => {
        // A used file changed: its modules may have, and so may the
        // geometry of every call into it.
        renderCache.current.clear();
        timingsRef.current.clear();
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
    timingsRef.current.clear();
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

  // M10a: the progress overlay's Cancel. Stops the render process (main) and
  // the per-part loop here; what was on screen before stays.
  const handleCancelRender = useCallback(() => {
    if (!renderingRef.current) return;
    cancelGenRef.current++;
    void window.scadstudio.cancelRender();
  }, []);

  // M18: Render (F6): everything on screen at full detail, once. Later
  // edits go back to the Auto rule (parts measured slow render as previews).
  const handleFullRender = useCallback(() => {
    forceFullRef.current = true;
    runRender(sourceRef.current);
  }, [runRender]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F6' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      handleFullRender();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleFullRender]);

  // M10a: the step the render process is on, for the overlay.
  useEffect(
    () =>
      window.scadstudio.onRenderStage((stage) => {
        if (renderProgressRef.current) renderProgressRef.current = { ...renderProgressRef.current, stage };
      }),
    [],
  );

  const openWith = useCallback(async (open: () => ReturnType<Window['scadstudio']['openFile']>) => {
    let result = await open();
    if (result && 'saveFirst' in result) {
      if (!(await handleSave(false))) return;
      result = await open();
    }
    if (!result || 'saveFirst' in result) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    // M10a: the previous file's render is no use now (it would otherwise
    // run to the end first, over a minute for the gag trophy), and its
    // meshes must not show under the new file's name.
    if (renderingRef.current) {
      cancelGenRef.current++;
      void window.scadstudio.cancelRender();
    }
    setNodeMeshes([]);
    setContextMeshes([]);
    // A new document starts at its top level.
    focusRef.current = [];
    focusEpochRef.current++;
    filePathRef.current = result.filePath;
    setSelectedIndices([]);
    setFilePath(result.filePath);
    setSavedSource(result.contents);
    setDocumentToken((t) => t + 1);
    fitAfterRenderRef.current = true;
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
        case 'text': {
          // M15: text isn't a loop of points, so it goes straight into the
          // source as its own statement on this plane (drilled in: into
          // the focused node, in its local frame, like Finish Sketch).
          if (!activeSketchPlane) return;
          const set = currentSet(resolvedRef.current);
          let next: string;
          if (set?.container) {
            const local = worldToFrame(set.frame, activeSketchPlane.origin, activeSketchPlane.rotationDeg);
            next = insertIntoContainer(sourceRef.current, set.container, sketchTextStatement(local.origin, local.rotationDeg, p));
          } else {
            next = appendStatement(sourceRef.current, sketchTextStatement(activeSketchPlane.origin, activeSketchPlane.rotationDeg, p));
          }
          // With nothing else drawn, leave sketch mode with the new text
          // selected, so its panel (words, font, size) is right there.
          // Otherwise stay, keeping the loops drawn so far.
          const leave = cur.profiles.length === 0 && cur.open.length === 0;
          if (leave) pendingSelectLast.current = true;
          if (debounceTimer.current) clearTimeout(debounceTimer.current);
          setSource(next);
          runRender(next);
          if (leave) {
            setActiveSketchPlane(null);
            resetSketch();
            // M10a: the view goes back to where it was before the sketch,
            // then frames the new text once it has rendered.
            focusAfterRenderRef.current = true;
          }
          return;
        }
      }
    },
    [sketchTool, toolAnchors, curveSegments, setSketchTracked, activeSketchPlane, runRender, resetSketch],
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
    focusAfterRenderRef.current = true;
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
    focusAfterRenderRef.current = true;
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
      let patched = patchTransform(sourceRef.current, tree, node, transform);
      // M11 linked drag: an expression axis that moves with a position
      // variable moves that variable, so the linked parts come along.
      const mesh = nodeMeshesRef.current.find((m) => m.index === index);
      if (mesh?.transform.exprs) {
        const anchors = positionAnchors(readVariables(tree.rootNode), nodeMeshesRef.current.map((m) => m.transform));
        const moved = new Map<string, number>();
        for (const d of drivenAxes(tree, node, mesh.transform, anchors)) {
          const delta = transform.translate[d.axis] - mesh.transform.translate[d.axis];
          const base = moved.get(d.anchor.name) ?? Number(d.anchor.display);
          if (Math.abs(delta) > 1e-9 && Number.isFinite(base)) moved.set(d.anchor.name, base + delta);
        }
        if (moved.size > 0) {
          const parsed = parseScadSync(patched);
          if (parsed) {
            const edits = readVariables(parsed.rootNode)
              .filter((v) => moved.has(v.name))
              .map((v) => ({ start: v.valueStart, end: v.valueEnd, text: formatNumber(moved.get(v.name)!) }));
            parsed.delete();
            patched = applyEdits(patched, edits);
          }
        }
      }
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
      // A new color is written as a vector, replacing a name or hex string.
      handleTransformCommit(primarySelectedIndex, { ...current, color, colorText: undefined });
    },
    [primarySelectedIndex, nodeMeshes, handleTransformCommit],
  );

  const handleClearColor = useCallback(() => {
    if (primarySelectedIndex === null) return;
    const current = nodeMeshes.find((m) => m.index === primarySelectedIndex)?.transform;
    if (!current) return;
    handleTransformCommit(primarySelectedIndex, { ...current, color: null, colorText: undefined });
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
      const text = valueText.trim();
      if (text === '') return;
      const translate = [...current.translate] as [number, number, number];
      const exprs = copyExprs(current);
      // M11: a number places the axis (and detaches an expression); any
      // other valid expression is written as is.
      if (NUMBER_TEXT.test(text)) {
        translate[axis] = Number(text);
        exprs.translate[axis] = null;
      } else if (isExpression(text)) {
        if (exprs.translate[axis] === text) return;
        exprs.translate[axis] = text;
      } else {
        setStatus(`Not an OpenSCAD expression: ${text}`);
        return;
      }
      handleTransformCommit(primarySelectedIndex, { ...current, translate, exprs });
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
    // M11: while a tool panel is open, a click fills the slot being picked
    // (and otherwise leaves the slots alone).
    const active = toolRef.current;
    if (active) {
      if (index === null || !active.picking) return;
      setTool(pickIntoTool(active, index));
      return;
    }
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
    return { callName: selectedArgs.callName, custom: !!custom, fields: panelFields(selectedArgs, params, !!custom || LIST_UNSET_BUILTINS.has(selectedArgs.callName)) };
  }, [selectedArgs, customTools]);

  // M15: persisted app settings (Settings > Fonts: the code editor's font).
  const [settings, setSettings] = useState<AppSettingsState>({ editorFontFamily: '', editorFontSize: 13, previewMode: 'auto', previewSegments: 24 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    void window.scadstudio
      .getSettings()
      .then(setSettings)
      .catch((err) => console.error('[scadstudio] settings', err));
  }, []);
  // M18: the preview settings reach the render loop through a ref; a change
  // re-renders (from the cache where it can).
  useEffect(() => {
    const prev = previewSettingsRef.current;
    if (prev.mode === settings.previewMode && prev.segments === settings.previewSegments) return;
    previewSettingsRef.current = { mode: settings.previewMode, segments: settings.previewSegments };
    runRender(sourceRef.current);
  }, [settings.previewMode, settings.previewSegments, runRender]);
  const handleSettingsChange = useCallback((patch: Partial<AppSettingsState>) => {
    setSettings((s) => ({ ...s, ...patch }));
    void window.scadstudio
      .updateSettings(patch)
      .then(setSettings)
      .catch((err) => console.error('[scadstudio] settings', err));
  }, []);

  // M15: the fonts the Text panel's font picker offers, fetched when a
  // panel with a font field first shows and again whenever the document's
  // libraries or `use <font.ttf>` files change (the same trigger as the
  // Custom toolbar's module scan).
  const [fontList, setFontList] = useState<FontEntry[] | null>(null);
  const [fontListStale, setFontListStale] = useState(true);
  const wantsFonts = !!panel?.fields.some((f) => f.widget === 'font');
  const fontRequestRef = useRef(0);
  useEffect(() => {
    if (!wantsFonts || !fontListStale) return;
    setFontListStale(false);
    // Only the newest request's answer is kept (a later one may follow
    // while this is in flight, after a library or font file changed).
    const id = ++fontRequestRef.current;
    void window.scadstudio
      .listFonts(sourceRef.current)
      .then((list) => {
        if (id === fontRequestRef.current) setFontList(list);
      })
      .catch((err) => console.error('[scadstudio] font list', err));
  }, [wantsFonts, fontListStale]);
  const fontUseKey = useMemo(() => (source.match(/\buse\s*<[^>\n]*\.(?:ttf|otf|ttc|otc)\s*>/gi) ?? []).join('|'), [source]);
  useEffect(() => setFontListStale(true), [fontUseKey, documentToken]);
  useEffect(() => window.scadstudio.onModulesChanged(() => setFontListStale(true)), []);

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

  // M11: every visual edit below ends the same way.
  const commitEdit = useCallback(
    (next: string) => {
      if (next === sourceRef.current) return;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setSource(next);
      runRender(next);
    },
    [runRender, setSource],
  );

  // M11: the document's variables, from the last rendered parse.
  const variables = useMemo(() => (tree ? readVariables(tree.rootNode) : []), [tree]);
  // M11 visible scopes: variables from included files, read-only. Their
  // uses are this document's reads of them (none once it assigns the name
  // again, since OpenSCAD keeps the last assignment).
  const includedParsed = useMemo(
    () =>
      includedFiles.flatMap((file) => {
        const parsed = parseScadSync(file.contents);
        if (!parsed) return [];
        const vars = readVariables(parsed.rootNode).map((v) => ({ ...v, uses: [] as VariableInfo['uses'] }));
        parsed.delete();
        return [{ path: file.path, via: file.via, variables: vars }];
      }),
    [includedFiles],
  );
  const includedSections = useMemo((): IncludedSection[] => {
    if (!tree) return [];
    const assigned = new Map(variables.map((v) => [v.name, v.line]));
    return includedParsed.map((file) => {
      const overridden = new Map<string, number>();
      const vars = file.variables.map((v) => {
        const line = assigned.get(v.name);
        if (line !== undefined) {
          overridden.set(v.name, line);
          return v;
        }
        return { ...v, uses: variableReferences(tree.rootNode, v.name).map((id) => ({ start: id.startIndex, end: id.endIndex, line: id.startPosition.row })) };
      });
      return { path: file.path, via: file.via, variables: vars, overridden };
    });
  }, [tree, variables, includedParsed]);
  // The assignment block a scope names, in the current text.
  const scopeContainer = useCallback((scope: VariableScope) => {
    const t = treeRef.current;
    if (!t) return null;
    if (scope.kind === 'file') return t.rootNode;
    const def = moduleAt(t.rootNode, scope.definitionStart);
    return def && def.startIndex === scope.definitionStart ? def.childForFieldName('body') : null;
  }, []);
  // The same variable in the current text (it may have moved since).
  const liveVariable = useCallback(
    (v: VariableInfo, scope: VariableScope = { kind: 'file' }): VariableInfo | null => {
      const t = treeRef.current;
      const container = scopeContainer(scope);
      if (!t || !container) return null;
      const all = readVariables(t.rootNode, container).filter((x) => x.name === v.name);
      return all.find((x) => x.line === v.line) ?? all[all.length - 1] ?? null;
    },
    [scopeContainer],
  );
  const handleVariableSet = useCallback(
    (v: VariableInfo, valueText: string, scope: VariableScope = { kind: 'file' }) => {
      const live = liveVariable(v, scope);
      if (!live) return;
      if (!isExpression(valueText)) {
        setStatus(`Not an OpenSCAD expression: ${valueText}`);
        return;
      }
      commitEdit(setVariableValue(sourceRef.current, live, valueText));
    },
    [liveVariable, commitEdit],
  );
  const handleVariableAdd = useCallback(
    (name: string, valueText: string): string | null => {
      const t = treeRef.current;
      if (!t) return 'The file is still loading.';
      if (!isValidName(name)) return 'A name starts with a letter or _ and has only letters, digits and _.';
      if (!nameAvailable(t.rootNode, name)) return `${name} is already used in this file.`;
      if (!isExpression(valueText)) return `Not an OpenSCAD expression: ${valueText}`;
      commitEdit(insertVariable(sourceRef.current, t.rootNode, name, valueText));
      return null;
    },
    [commitEdit],
  );
  const handleVariableRename = useCallback(
    (v: VariableInfo, newName: string, scope: VariableScope = { kind: 'file' }): string | null => {
      const t = treeRef.current;
      const container = scopeContainer(scope);
      if (!t || !container) return 'The file is still loading.';
      if (!isValidName(newName)) return 'A name starts with a letter or _ and has only letters, digits and _.';
      if (!nameAvailable(t.rootNode, newName)) return `${newName} is already used in this file.`;
      commitEdit(renameVariable(sourceRef.current, t.rootNode, v.name, newName, container));
      return null;
    },
    [commitEdit, scopeContainer],
  );
  const handleVariableDelete = useCallback(
    (v: VariableInfo, inline: boolean, scope: VariableScope = { kind: 'file' }) => {
      const t = treeRef.current;
      const container = scopeContainer(scope);
      const live = liveVariable(v, scope);
      if (!t || !live || !container) return;
      commitEdit(deleteVariable(sourceRef.current, t.rootNode, live, inline, container));
    },
    [liveVariable, commitEdit, scopeContainer],
  );
  const handleReveal = useCallback((start: number, end: number) => {
    setRevealRequest((prev) => ({ start, end, token: (prev?.token ?? 0) + 1 }));
  }, []);

  // M11 Make variable: the name prompt opens with a suggestion.
  const startMakeVariable = useCallback(
    (target: NonNullable<typeof makeVar>['target']) => {
      const t = treeRef.current;
      if (!t) return;
      const call = selectedArgs?.callName ?? 'part';
      const base = target.kind === 'position' ? `${call}_${'xyz'[target.axis]}` : `${call}_${/^#/.test(target.label) ? 'value' : target.label}`;
      setMakeVar({ target, name: uniqueName(t.rootNode, base), error: null });
    },
    [selectedArgs],
  );
  const handleMakeVariable = useCallback(
    (name: string) => {
      const t = treeRef.current;
      const node = sceneNodesRef.current.find((n) => n.index === primarySelectedIndex);
      if (!t || !node || !makeVar) return;
      const fail = (error: string) => setMakeVar({ ...makeVar, name, error });
      if (!isValidName(name)) return fail('A name starts with a letter or _ and has only letters, digits and _.');
      if (!nameAvailable(t.rootNode, name)) return fail(`${name} is already used in this file.`);
      const src = sourceRef.current;
      let next: string | null = null;
      const target = makeVar.target;
      const thenInsert = (step: string, valueText: string) => {
        const parsed = parseScadSync(step);
        if (!parsed) return null;
        try {
          return insertVariable(step, parsed.rootNode, name, valueText);
        } finally {
          parsed.delete();
        }
      };
      if (target.kind === 'arg') {
        const args = primitiveArgs(t.rootNode, node);
        const arg = target.argIndex !== null ? args?.args[target.argIndex] : null;
        if (arg) next = makeVariable(src, t.rootNode, { start: arg.valueStart, end: arg.valueEnd }, name);
        else if (target.defaultText !== null) next = thenInsert(addNamedArgument(src, t, node, target.label, name), target.defaultText);
      } else {
        const d = decomposeNode(t.rootNode, node);
        const mesh = nodeMeshes.find((m) => m.index === node.index);
        if (d && mesh) {
          const comp = translateComponents(d)[target.axis];
          if (comp) next = makeVariable(src, t.rootNode, { start: comp.startIndex, end: comp.endIndex }, name);
          else {
            const exprs = copyExprs(mesh.transform);
            exprs.translate[target.axis] = name;
            next = thenInsert(patchTransform(src, t, node, { ...mesh.transform, exprs }), formatNumber(mesh.transform.translate[target.axis]));
          }
        }
      }
      if (!next) return fail('This value can’t be made a variable here.');
      setMakeVar(null);
      commitEdit(next);
    },
    [makeVar, primarySelectedIndex, nodeMeshes, commitEdit],
  );

  // M11 tool panel, M10b floating tool windows: Distance, Align, Pattern,
  // the booleans and the extrudes. Slots start from the selection: the
  // first selected part moves (it keeps the boolean tools' orange), the
  // second is the reference (red). Starting a tool replaces the open one
  // (nothing is written, like Cancel).
  // The toolbar's Extrude and Boolean buttons open on the operation used
  // last (the window switches between them), remembered across restarts.
  const lastOps = useRef<{ extrude: ExtrudeOp; boolean: BooleanOp }>({ extrude: 'linear_extrude', boolean: 'union' });
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem('scadstudio.lastOps') ?? '{}') as { extrude?: string; boolean?: string };
      if (v.extrude === 'linear_extrude' || v.extrude === 'rotate_extrude') lastOps.current.extrude = v.extrude;
      if (v.boolean === 'union' || v.boolean === 'difference' || v.boolean === 'intersection') lastOps.current.boolean = v.boolean;
    } catch {
      // Defaults.
    }
  }, []);
  const rememberOp = useCallback((t: ToolState) => {
    if (t.kind === 'extrude') lastOps.current.extrude = t.op;
    else if (t.kind === 'boolean') lastOps.current.boolean = t.op;
    else return;
    try {
      localStorage.setItem('scadstudio.lastOps', JSON.stringify(lastOps.current));
    } catch {
      // Storage unavailable.
    }
  }, []);
  const startTool = useCallback((kind: ToolKind, opts: Parameters<typeof initialTool>[2] = {}) => {
    setMakeVar(null);
    setTool(initialTool(kind, selectedRef.current, opts));
  }, []);
  // The viewport highlights the slots in the panel's colors.
  useEffect(() => {
    if (!tool) return;
    setSelectedIndices(toolSlotIndices(tool));
  }, [tool]);
  // M10b: a sketch takes over the viewport; an open tool window closes.
  const sketchingNow = activeSketchPlane !== null || pickingFace;
  useEffect(() => {
    if (sketchingNow) setTool(null);
  }, [sketchingNow]);
  // A drill in or out changes what the slots' indices mean.
  const toolFocusDepth = resolved?.focus.length ?? 0;
  useEffect(() => {
    setTool(null);
    setMakeVar(null);
  }, [toolFocusDepth]);
  // M18: a part an open Distance / Align / Pattern tool sizes from its mesh
  // must be the full render (a coarser circle is smaller). While the tool is
  // open its parts always render in full; if one on screen is a preview,
  // render it again now.
  useEffect(() => {
    const indices = new Set(!tool || tool.kind === 'boolean' || tool.kind === 'extrude' ? [] : toolSlotIndices(tool));
    toolFullIndicesRef.current = indices;
    if (nodeMeshes.some((m) => m.reduced && indices.has(m.index))) runRender(sourceRef.current);
  }, [tool, nodeMeshes, runRender]);
  const measureIndex = useCallback((index: number) => () => meshBox(nodeMeshes.find((m) => m.index === index)), [nodeMeshes]);
  // Distance's default: the distance the parts are at now.
  useEffect(() => {
    if (tool?.kind !== 'distance' || tool.move === null || tool.reference === null || tool.offset !== '') return;
    const t = treeRef.current;
    const nodes = sceneNodesRef.current;
    if (!t || !nodes[tool.move] || !nodes[tool.reference]) return;
    const d = currentOffset(t, {
      move: nodes[tool.move],
      reference: nodes[tool.reference],
      axis: tool.axis,
      moveEdge: tool.moveEdge,
      referenceEdge: tool.referenceEdge,
      measureMove: measureIndex(tool.move),
      measureReference: measureIndex(tool.reference),
    });
    setTool({ ...tool, offset: d === null ? '0' : String(d) });
  }, [tool, measureIndex]);
  // Pattern's default pitch: the part's width plus 5.
  useEffect(() => {
    if (tool?.kind !== 'pattern' || tool.part === null || tool.spacing !== '') return;
    const t = treeRef.current;
    const node = sceneNodesRef.current[tool.part];
    if (!t || !node) return;
    const ext = partExtents(t, node, measureIndex(tool.part));
    const width = ext ? linValue(sub(ext.axes[tool.axis].max, ext.axes[tool.axis].min)) : NaN;
    setTool({ ...tool, spacing: tool.spacingMode === 'gap' ? '5' : Number.isFinite(width) ? formatNumber(width + 5) : '10' });
  }, [tool, measureIndex]);
  const labelOf = useCallback(
    (index: number | null) => {
      if (index === null) return null;
      const node = sceneNodes[index];
      return node ? node.label.trim().replace(/\s+/g, ' ').slice(0, 28) : null;
    },
    [sceneNodes],
  );
  const toolPreview = useMemo(() => {
    if (!tool) return null;
    const t = treeRef.current;
    const src = sourceRef.current;
    const nodes = sceneNodesRef.current;
    if (!t) return null;
    if (tool.kind === 'boolean') {
      const parts = toolSlotIndices(tool);
      const picked = parts.map((i) => nodes[i]).filter((n): n is SceneNode => n !== undefined);
      if (tool.op === 'difference' && (tool.base === null || tool.tools.length === 0)) {
        return { ok: false as const, reason: 'Pick the base and at least one part to subtract: click a slot, then parts in the viewport.' };
      }
      if (picked.length < 2) return { ok: false as const, reason: 'Pick at least two parts: click the slot, then parts in the viewport.' };
      const next = wrapInBoolean(src, picked, tool.op);
      if (next === src) return { ok: false as const, reason: 'These parts can’t be combined here.' };
      return {
        ok: true as const,
        lines: [`${tool.op}() {`, ...parts.map((i) => `    ${labelOf(i)}`), '}'],
        notes: tool.op === 'difference' ? [] : ['The order doesn’t matter for this operation.'],
        source: next,
        select: Math.min(...parts),
      };
    }
    if (tool.kind === 'extrude') {
      const args = extrudeArgs(tool);
      if (!args.ok) return args;
      for (const field of tool.op === 'linear_extrude' ? [tool.height, tool.twist] : [tool.angle]) {
        if (field.trim() !== '' && !isExpression(field)) return { ok: false as const, reason: `Not an OpenSCAD expression: ${field}` };
      }
      if (tool.profile === null || !nodes[tool.profile]) {
        const statement = defaultExtrudeStatement(tool.op, args.args);
        const set = currentSet(resolvedRef.current);
        const placed = set?.container ? insertIntoContainer(src, set.container, statement) : appendStatement(src, statement);
        return {
          ok: true as const,
          lines: [statement],
          notes: ['No profile picked, so Apply inserts a new one. To extrude a part, click the Profile slot, then a 2D part.'],
          source: placed,
          select: 'last' as const,
        };
      }
      const mesh = nodeMeshes.find((m) => m.index === tool.profile);
      if (mesh && !mesh.flat) {
        return { ok: false as const, reason: `${labelOf(tool.profile)} is 3D. Extrude takes a 2D profile: a sketch, square, circle, polygon or text.` };
      }
      const next = wrapInExtrude(src, t.rootNode, nodes[tool.profile], tool.op, args.args);
      return { ok: true as const, lines: [`${tool.op}(${args.args}) {`, `    ${labelOf(tool.profile)}`, '}'], notes: [], source: next, select: tool.profile };
    }
    if (tool.kind !== 'pattern') {
      if (tool.move === null || tool.reference === null || !nodes[tool.move] || !nodes[tool.reference]) {
        return { ok: false as const, reason: 'Pick both parts: click a slot, then a part in the viewport.' };
      }
      if (tool.offset.trim() !== '' && !isExpression(tool.offset)) return { ok: false as const, reason: `Not an OpenSCAD expression: ${tool.offset}` };
      const r = planRelate(src, t, {
        move: nodes[tool.move],
        reference: nodes[tool.reference],
        axis: tool.axis,
        moveEdge: tool.moveEdge,
        referenceEdge: tool.referenceEdge,
        offsetText: tool.offset,
        offsetName: tool.offsetName.trim() || null,
        follow: tool.follow,
        attach: tool.kind === 'distance',
        measureMove: measureIndex(tool.move),
        measureReference: measureIndex(tool.reference),
      });
      if (!r.ok) return r;
      const notes: string[] = [];
      if (r.plan.measured.reference) notes.push(`${labelOf(tool.reference)} can’t be sized from its code, so its measured size is used: the part follows when it moves, not when it changes size.`);
      if (r.plan.measured.move) notes.push(`${labelOf(tool.move)} is sized from its rendered mesh: if it changes size, its edge won’t stay put.`);
      if (!tool.follow) notes.push('Numbers are copied: the part won’t follow later changes.');
      else if (tool.kind === 'distance') notes.push('Locked together: drag either part in any direction and the other follows. Change the distance in the Variables panel.');
      return {
        ok: true as const,
        lines: [...r.plan.newVariables.map((v) => `${v.name} = ${v.valueText};`), `${labelOf(tool.move)} → translate ${'XYZ'[tool.axis]} = ${r.plan.expression}`],
        notes,
        source: r.plan.source,
      };
    }
    if (tool.part === null || !nodes[tool.part]) return { ok: false as const, reason: 'Pick the part: click the slot, then a part in the viewport.' };
    if (!isExpression(tool.count)) return { ok: false as const, reason: 'Enter a count.' };
    const node = nodes[tool.part];
    const notes: string[] = [];
    let opts: PatternOptions;
    if (tool.mode === 'linear') {
      if (!isExpression(tool.spacing)) return { ok: false as const, reason: 'Enter a spacing.' };
      let spacing = tool.spacing.trim();
      if (tool.spacingMode === 'gap') {
        const ext = partExtents(t, node, measureIndex(tool.part));
        if (!ext) return { ok: false as const, reason: 'The part’s size isn’t known, so use Pitch.' };
        const width = sub(ext.axes[tool.axis].max, ext.axes[tool.axis].min);
        const gap = NUMBER_TEXT.test(spacing) ? constant(Number(spacing)) : fromTerm(term(spacing, NaN));
        spacing = formatLin(add(width, gap));
        if (ext.axes[tool.axis].measured) notes.push('The part’s width is measured, so the spacing won’t follow if it changes size.');
      }
      opts = { kind: 'linear', axis: tool.axis, count: tool.count, spacing };
    } else {
      if (!tool.fullCircle && !isExpression(tool.step)) return { ok: false as const, reason: 'Enter a step angle.' };
      opts = { kind: 'circular', axis: tool.axis, count: tool.count, step: tool.fullCircle ? null : tool.step };
      notes.push(`Copies turn about the ${'XYZ'[tool.axis]} axis through the origin.`);
    }
    const next = wrapInPattern(src, t, node, opts);
    if (!next) return { ok: false as const, reason: 'This part can’t be patterned.' };
    const written = next.slice(node.startIndex, node.endIndex + (next.length - src.length));
    return { ok: true as const, lines: written.split('\n').slice(0, 3).map((l) => l.trim()), notes, source: next };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, tree, nodeMeshes, source, measureIndex, labelOf]);
  const handleApplyTool = useCallback(() => {
    if (!tool || !toolPreview?.ok) return;
    const select = 'select' in toolPreview ? toolPreview.select : tool.kind === 'pattern' ? tool.part : tool.kind === 'distance' || tool.kind === 'align' ? tool.move : null;
    rememberOp(tool);
    if (select === 'last') pendingSelectLast.current = true;
    else pendingSelectAfterEdit.current = select ?? null;
    setTool(null);
    commitEdit(toolPreview.source);
  }, [tool, toolPreview, commitEdit, rememberOp]);
  // Esc leaves the tool panel without writing anything.
  useEffect(() => {
    if (!tool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTool(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool]);

  // M11: a selected pattern's count and spacing, editable after the fact.
  const selectedPattern = useMemo(() => {
    if (!tree || primarySelectedIndex === null) return null;
    const node = sceneNodes.find((n) => n.index === primarySelectedIndex);
    return node ? readPattern(tree, node) : null;
  }, [tree, sceneNodes, primarySelectedIndex]);
  const handlePatternCommit = useCallback(
    (field: 'count' | 'spacing', text: string) => {
      const t = treeRef.current;
      const node = sceneNodesRef.current.find((n) => n.index === primarySelectedIndex);
      const p = t && node ? readPattern(t, node) : null;
      if (!p || !isExpression(text)) return;
      commitEdit(applyEdits(sourceRef.current, field === 'count' ? patternCountEdits(p, text) : patternSpacingEdits(p, text)));
    },
    [primarySelectedIndex, commitEdit],
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
  // A path (from "Show parts") drills through several levels at once.
  const handleDrill = useCallback(
    (indexOrPath: number | number[]) => {
      const r = resolvedRef.current;
      const tree = treeRef.current;
      const set = currentSet(r);
      if (!r || !tree || !set || activeSketchPlane || pickingFace) return;
      const path = typeof indexOrPath === 'number' ? [indexOrPath] : indexOrPath;
      if (path.length === 0 || !canDrill(set, path[0], resolveModule)) return;
      let focus = [...r.focus, { index: path[0], siblings: set.fingerprints }];
      for (const index of path.slice(1)) {
        const step = resolveFocus({ kind: 'document', path: filePathRef.current, text: sourceRef.current, tree }, focus, resolveModule);
        if (step.lost) break;
        focus = [...step.focus, { index, siblings: currentSet(step)!.fingerprints }];
      }
      focusRef.current = focus;
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
    // An open tool window takes Esc itself (it closes, writing nothing).
    if (toolRef.current) return;
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
  // M10a: Focus (F, like Unity's editor): frame the selected parts, keeping
  // the view's angle. With nothing selected, the same as Reset View.
  const focusSelectionRef = useRef<() => void>(() => {});
  focusSelectionRef.current = () => {
    const indices = selectedRef.current.filter((i) => nodeMeshesRef.current.some((m) => m.index === i));
    if (indices.length === 0) setResetViewToken((t) => t + 1);
    else setFocusRequest((r) => ({ token: (r?.token ?? 0) + 1, indices }));
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const isFocusKey = (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key !== 'Escape' && !isFocusKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.monaco-editor, input, textarea, select, [contenteditable="true"]')) return;
      if (isFocusKey) focusSelectionRef.current();
      else escapeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const workingSet = currentSet(resolved);
  const focusDepth = resolved?.focus.length ?? 0;
  const readOnly = workingSet?.readOnly ?? null;

  // M11 visible scopes: the module the drill-in or the editor cursor is
  // inside. Drilled into a library module, its variables show read-only.
  const variablesModule = useMemo((): ModuleSection | null => {
    if (!tree) return null;
    const container = workingSet?.container ?? null;
    if (workingSet && container && workingSet.doc.kind === 'library') {
      const def = moduleAt(workingSet.doc.tree.rootNode, container.body.start);
      const info = def ? readModuleVariables(workingSet.doc.tree.rootNode, def) : null;
      if (!info) return null;
      const { body: _body, ...rest } = info;
      return { ...rest, file: workingSet.doc.path };
    }
    const offset = workingSet?.editingModule && container ? container.body.start : cursorOffset;
    if (offset === null) return null;
    const def = moduleAt(tree.rootNode, offset);
    const info = def ? readModuleVariables(tree.rootNode, def) : null;
    if (!info) return null;
    const { body: _body, ...rest } = info;
    return { ...rest, file: null };
  }, [tree, workingSet, cursorOffset]);
  // Transform edits need the working set's frame as a matrix (drillIn.ts);
  // sketches also need it rigid, since a sketch plane can't be scaled.
  const transformEditable = !readOnly && (workingSet?.bakedPrefix ?? '') === '';
  const sketchAllowed = transformEditable && (!workingSet || frameIsRigid(workingSet.frame));
  const selectedCanDrill = useMemo(() => {
    if (!workingSet || primarySelectedIndex === null || selectedIndices.length !== 1) return null;
    return drillLabel(workingSet, primarySelectedIndex, resolveModule);
  }, [workingSet, primarySelectedIndex, selectedIndices.length, resolveModule]);
  // "Show parts": for the selected node, or the last statement of a top
  // level with nothing selected, the path down through every level with a
  // single statement in use (partPath). Offered when that is more than one
  // level, i.e. more than "Open ... ▸" already does.
  const showParts = useMemo(() => {
    if (!workingSet || resolved === null || selectedIndices.length > 1) return null;
    const target = primarySelectedIndex ?? (focusDepth === 0 && workingSet.nodes.length > 0 ? workingSet.nodes.length - 1 : null);
    if (target === null) return null;
    const path = partPath(workingSet, target, resolveModule);
    if (path.length < 2) return null;
    const doc = workingSet.doc;
    if (doc.kind !== 'document') return null;
    const deeper = resolveFocus(doc, [...resolved.focus], resolveModule);
    let focus = deeper.focus;
    let crumbs = deeper.crumbs;
    for (const index of path) {
      const step = resolveFocus(doc, focus, resolveModule);
      focus = [...step.focus, { index, siblings: currentSet(step)!.fingerprints }];
      crumbs = resolveFocus(doc, focus, resolveModule).crumbs;
    }
    const added = crumbs.slice(-path.length).map((c) => c.label.replace(/ #\d+$/, ''));
    const named = [...added].reverse().find((l) => /^[A-Za-z_$][\w$]*\(\)$/.test(l));
    return { path, label: named ?? added[added.length - 1] };
  }, [workingSet, resolved, primarySelectedIndex, selectedIndices.length, focusDepth, resolveModule]);
  // "Go to definition" for a selected call of a module defined in the
  // document (at the top level or nested inside another module).
  const selectedDefinition = useMemo(() => {
    if (!workingSet || readOnly || primarySelectedIndex === null || selectedIndices.length !== 1) return null;
    const def = callDefinition(workingSet, primarySelectedIndex, resolveModule);
    return def && def.doc.kind === 'document' ? def : null;
  }, [workingSet, readOnly, primarySelectedIndex, selectedIndices.length, resolveModule]);
  const [revealRequest, setRevealRequest] = useState<{ start: number; end: number; token: number } | null>(null);
  // The note on an `if ($preview) ... else ...`: which branch is the part.
  // Shown at that level and every level inside it ("Show parts" goes
  // straight through it).
  const branchNote = useMemo(() => {
    if (!resolved) return null;
    for (let depth = resolved.sets.length - 1; depth >= 1; depth--) {
      const set = resolved.sets[depth];
      const condition = set.containerCall === 'if' ? set.condition : null;
      if (!condition || !condition.includes('$preview')) continue;
      const value = staticCondition(condition);
      if (value === null) continue;
      if (depth === resolved.sets.length - 1) {
        return value
          ? 'if ($preview): the if branch is the part as rendered and exported. The else branch only applies in OpenSCAD\'s F5 preview.'
          : 'if ($preview): the else branch is the part as rendered and exported ($preview is false there). The if branch only poses it for OpenSCAD\'s F5 preview.';
      }
      // Deeper: say which branch the path went through.
      const taken = resolved.sets[depth].guards[resolved.focus[depth].index];
      const viaElse = taken?.negated ?? false;
      return viaElse === !value
        ? `Inside the ${viaElse ? 'else' : 'if'} branch of if ($preview): the part as rendered and exported.`
        : `Inside the ${viaElse ? 'else' : 'if'} branch of if ($preview), which only applies in OpenSCAD's F5 preview: nothing here is rendered.`;
    }
    return null;
  }, [resolved]);
  const visibleCustomTools = workingSet?.editingModule ? customTools.filter((t) => t.callName !== workingSet.editingModule) : customTools;

  // M11: say why some gizmo handles are missing.
  // M11 linked drag: the selected part's axes that move a position variable.
  const primaryDriven = useMemo(() => {
    const mesh = nodeMeshes.find((m) => m.index === primarySelectedIndex);
    const node = sceneNodesRef.current.find((n) => n.index === primarySelectedIndex);
    if (!tree || !mesh || !node || readOnly) return [];
    return drivenAxes(tree, node, mesh.transform, positionAnchors(variables, nodeMeshes.map((m) => m.transform)));
  }, [tree, nodeMeshes, primarySelectedIndex, variables, readOnly]);
  const primaryFreeAxes = useMemo(() => [0, 1, 2].map((axis) => primaryDriven.some((d) => d.axis === axis)), [primaryDriven]);
  const lockNote = useMemo(() => {
    const mesh = nodeMeshes.find((m) => m.index === primarySelectedIndex);
    if (!mesh) return null;
    const axes = gizmoAxes(mesh.transform, mesh.frame, gizmoMode, primaryFreeAxes);
    if (axes.locked.length === 0) {
      if (gizmoMode !== 'translate' || primaryDriven.length === 0) return null;
      const names = [...new Set(primaryDriven.map((d) => d.anchor.name))];
      const uses = new Set(primaryDriven.flatMap((d) => d.anchor.uses.map((u) => u.start))).size;
      return `Linked: dragging moves ${names.join(', ')}, and every part that reads ${names.length > 1 ? 'them' : 'it'} moves too (${uses} use${uses === 1 ? '' : 's'}).`;
    }
    const what = axes.locked.map((l) => `${'XYZ'[l.axis]} = ${l.text}`).join(', ');
    if (!axes.visible) return `${gizmoMode === 'rotate' ? 'Rotation' : gizmoMode === 'scale' ? 'Scale' : 'Position'} is set by an expression (${what}), so the ${gizmoMode} gizmo is off.`;
    return `${what} (expression): the gizmo moves the other axes.`;
  }, [nodeMeshes, primarySelectedIndex, gizmoMode, primaryFreeAxes, primaryDriven]);
  // Make variable's prompt belongs to one selected part.
  useEffect(() => setMakeVar(null), [primarySelectedIndex]);

  const breadcrumb =
    focusDepth > 0 || selectedCanDrill || showParts || selectedDefinition ? (
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
        {branchNote && (
          <div role="status" data-testid="branch-note" style={{ background: 'rgba(20,45,60,0.92)', padding: '4px 8px', borderRadius: 4 }}>
            {branchNote}
          </div>
        )}
        {!sketching && (selectedCanDrill || showParts || selectedDefinition) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignSelf: 'flex-start', pointerEvents: 'auto' }}>
            {selectedCanDrill && (
              <button
                onClick={() => primarySelectedIndex !== null && handleDrill(primarySelectedIndex)}
                title="Edit what's inside: its children become the working set (or double-click the shape)"
              >
                Open {selectedCanDrill} ▸
              </button>
            )}
            {showParts && (
              <button
                onClick={() => handleDrill(showParts.path)}
                title="Open every level that holds just one statement, down to the first level with several parts"
              >
                Show parts of {showParts.label} ▸▸
              </button>
            )}
            {selectedDefinition && (
              <button
                onClick={() =>
                  setRevealRequest((prev) => ({ start: selectedDefinition.nameStart, end: selectedDefinition.nameEnd, token: (prev?.token ?? 0) + 1 }))
                }
                title="Show where this module is defined in the editor"
              >
                Go to {selectedDefinition.name}() definition
              </button>
            )}
          </div>
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

  // M10b (QC L2, Jordan 2026-11-26): Extrude only takes a 2D profile, so
  // it is off while a 3D part is selected (wrapping one used to make the
  // part vanish). A part is 2D when it only rendered through the 2D retry.
  const extrudeBlocked = useMemo(() => {
    if (primarySelectedIndex === null) return null;
    const mesh = nodeMeshes.find((m) => m.index === primarySelectedIndex);
    if (!mesh || mesh.flat) return null;
    return 'Extrude needs a 2D profile (a sketch, square, circle, polygon or text), and the selected part is 3D. Select a 2D part, or nothing to insert a new extrusion.';
  }, [primarySelectedIndex, nodeMeshes]);

  // M10b: the selected part's properties (the M5 parameter panel, M11's
  // pattern count/spacing and Make variable, position, gizmo mode, mirror,
  // color, modifier) in one floating window over the viewport. It steps
  // aside while a tool window is open or a sketch is being drawn.
  const selectedMesh = primarySelectedIndex === null ? undefined : nodeMeshes.find((m) => m.index === primarySelectedIndex);
  const propertiesWindow =
    primarySelectedIndex !== null && !tool && !sketching ? (
      <FloatingWindow
        title={panel?.callName ?? labelOf(primarySelectedIndex) ?? 'Part'}
        label="Properties"
        storageKey="properties"
        testId="properties-window"
        collapsible
        width={260}
        badge={
          selectedIndices.length > 1 ? (
            <span style={{ opacity: 0.65, flex: 'none' }} title="Several parts are selected; this window edits the last one clicked">
              +{selectedIndices.length - 1} selected
            </span>
          ) : undefined
        }
      >
        {panel && panel.fields.length > 0 && (
          <WindowSection title="Parameters">
            {panel.fields.map((field, i) => (
              // Keyed on the value text too, not just index: after a commit
              // lands, the canonical (possibly reformatted) text should
              // replace whatever the user typed, which an uncontrolled input
              // only does on remount — see handleArgCommit's comment.
              <ParamField
                key={`${i}-${field.label}-${field.valueText}`}
                field={field}
                fonts={field.widget === 'font' ? fontList : undefined}
                disabled={!!readOnly}
                onCommit={(text) => (field.argIndex !== null ? handleArgCommit(field.argIndex, text) : handleAddArg(field.label, text))}
                onMakeVariable={
                  readOnly || (field.valueText !== null && !/^\s*(-?[\d.]+(e[-+]?\d+)?|true|false|\[[-\d.,\s]+\])\s*$/i.test(field.valueText)) || (field.valueText === null && !field.param?.defaultText)
                    ? undefined
                    : () => startMakeVariable({ kind: 'arg', argIndex: field.argIndex, label: field.label, defaultText: field.param?.defaultText ?? null })
                }
              />
            ))}
          </WindowSection>
        )}
        {selectedPattern && (
          <div role="group" aria-label="Pattern">
          <WindowSection title={selectedPattern.kind === 'linear' ? `Linear pattern along ${'XYZ'[selectedPattern.axis]}` : `Circular pattern around ${'XYZ'[selectedPattern.axis]}`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <WindowRow label="Count">
                <input
                  key={`count-${selectedPattern.countText}`}
                  aria-label="Pattern count"
                  list={VARIABLE_DATALIST_ID}
                  defaultValue={selectedPattern.countText}
                  size={5}
                  disabled={!!readOnly}
                  onBlur={(e) => e.target.value.trim() !== selectedPattern.countText && handlePatternCommit('count', e.target.value.trim())}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
              </WindowRow>
              {selectedPattern.spacingText !== null ? (
                <WindowRow label={selectedPattern.kind === 'linear' ? 'Pitch' : 'Step°'}>
                  <input
                    key={`spacing-${selectedPattern.spacingText}`}
                    aria-label="Pattern spacing"
                    list={VARIABLE_DATALIST_ID}
                    defaultValue={selectedPattern.spacingText}
                    size={Math.max(5, selectedPattern.spacingText.length + 1)}
                    disabled={!!readOnly}
                    onBlur={(e) => e.target.value.trim() !== selectedPattern.spacingText && handlePatternCommit('spacing', e.target.value.trim())}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                </WindowRow>
              ) : (
                selectedPattern.kind === 'circular' && <span style={{ opacity: 0.7 }}>Spread over the full circle</span>
              )}
            </div>
          </WindowSection>
          </div>
        )}
        {transformEditable && (
          <WindowSection title="Placement">
            <WindowRow label="Gizmo">
              {GIZMO_MODE_BUTTONS.map(({ mode, label }) => (
                <button key={mode} onClick={() => setGizmoMode(mode)} aria-pressed={gizmoMode === mode} style={{ fontWeight: gizmoMode === mode ? 'bold' : 'normal' }}>
                  {label}
                </button>
              ))}
            </WindowRow>
            {gizmoMode === 'rotate' && (
              <WindowRow label="Space">
                {ROTATE_SPACE_BUTTONS.map(({ space, label }) => (
                  <button key={space} onClick={() => setRotateSpace(space)} aria-pressed={rotateSpace === space} style={{ fontWeight: rotateSpace === space ? 'bold' : 'normal' }}>
                    {label}
                  </button>
                ))}
              </WindowRow>
            )}
            <WindowRow label="Position">
              {(['X', 'Y', 'Z'] as const).map((label, axis) => {
                const value = selectedMesh?.transform.translate[axis] ?? 0;
                // M11: an axis written as an expression shows (and edits) the
                // expression; typing a number detaches it.
                const expr = selectedMesh?.transform.exprs?.translate[axis] ?? null;
                const shown = expr ?? formatNumber(value);
                return (
                  <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <span style={{ opacity: 0.6 }}>{label}</span>
                    {/* Keyed on the value too, same reformat-after-commit reasoning as the parameter panel's inputs. */}
                    <input
                      key={`${primarySelectedIndex}-${axis}-${shown}`}
                      type="text"
                      inputMode="decimal"
                      list={VARIABLE_DATALIST_ID}
                      aria-label={`Position ${label}`}
                      defaultValue={shown}
                      size={expr ? Math.min(24, Math.max(5, expr.length + 1)) : 5}
                      title={expr ? `Set by an expression (comes to ${formatNumber(value)}). Type a number to detach it.` : 'A number, a variable name or an expression'}
                      style={expr ? { fontFamily: 'monospace', color: '#9cdcfe', fontStyle: 'italic' } : { width: 46 }}
                      onBlur={(e) => {
                        if (e.target.value.trim() !== shown) handlePositionCommit(axis as 0 | 1 | 2, e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                    />
                    {!expr && (
                      <button
                        className="make-variable"
                        aria-label={`Make position ${label} a variable`}
                        title="Make variable: name this position at the top of the file"
                        onClick={() => startMakeVariable({ kind: 'position', axis: axis as 0 | 1 | 2 })}
                        style={{ fontSize: 11, padding: '0 3px', fontStyle: 'italic' }}
                      >
                        ƒx
                      </button>
                    )}
                  </span>
                );
              })}
            </WindowRow>
            {lockNote && (
              <span role="note" data-testid="gizmo-lock-note" style={{ color: '#9cdcfe', opacity: 0.85 }}>
                {lockNote}
              </span>
            )}
            <WindowRow label="Mirror">
              {MIRROR_AXIS_BUTTONS.map(({ axis, label }) => (
                <button key={axis} onClick={() => handleMirrorAxis(axis)}>
                  {label}
                </button>
              ))}
            </WindowRow>
          </WindowSection>
        )}
        {!readOnly && (
          <WindowSection title="Appearance">
            {transformEditable && (
              <WindowRow label="Color">
                <input type="color" aria-label="Color" value={rgbToHex(selectedMesh?.transform.color ?? null)} onChange={(e) => handleColorChange(e.target.value)} />
                {selectedMesh?.transform.color && <button onClick={handleClearColor}>Clear</button>}
              </WindowRow>
            )}
            <WindowRow label="Modifier">
              {MODIFIER_BUTTONS.map(({ modifier, label }) => (
                <button
                  key={modifier}
                  onClick={() => handleModifierToggle(modifier)}
                  aria-pressed={selectedModifier === modifier}
                  style={{ fontWeight: selectedModifier === modifier ? 'bold' : 'normal' }}
                >
                  {label}
                </button>
              ))}
            </WindowRow>
          </WindowSection>
        )}
        {makeVar && (
          <form
            aria-label="Make variable"
            onSubmit={(e) => {
              e.preventDefault();
              handleMakeVariable(String(new FormData(e.currentTarget).get('name') ?? '').trim());
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, background: '#22323f', border: '1px solid #3d5366', borderRadius: 4 }}
          >
            <WindowRow label="Variable named">
              <input name="name" aria-label="Variable name" defaultValue={makeVar.name} autoFocus size={14} style={{ fontFamily: 'monospace' }} />
            </WindowRow>
            <span style={{ opacity: 0.7 }}>It goes at the top of the file, and the name replaces the value here.</span>
            {makeVar.error && (
              <span role="alert" style={{ color: '#e8a05a' }}>
                {makeVar.error}
              </span>
            )}
            <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button type="submit">Make variable</button>
              <button type="button" onClick={() => setMakeVar(null)}>
                Cancel
              </button>
            </span>
          </form>
        )}
      </FloatingWindow>
    ) : null;

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
        <button onClick={() => focusSelectionRef.current()} title="Frame the selected part, keeping the view angle (F)">
          Focus
        </button>
        <select aria-label="Shading mode" title="How the 3D view draws the model" value={shading} onChange={(e) => setShading(e.target.value as ShadingMode)}>
          {SHADING_OPTIONS.map(({ mode, label }) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </select>
        <button onClick={() => setSettingsOpen(true)} title="Settings (editor font, quick preview)">
          Settings
        </button>
        <button onClick={() => setVariablesOpen((o) => !o)} aria-pressed={variablesOpen} title="Show or hide the variables panel">
          Variables{variables.length > 0 ? ` (${variables.length})` : ''}
        </button>
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
        {!readOnly && !sketching && (
        <span role="group" aria-label="Insert" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Insert:
          {INSERT_TOOLS.map((tool) => (
            <button key={tool.id} onClick={() => handleInsertTool(tool)}>
              {tool.label}
            </button>
          ))}
        </span>
        )}
        {!readOnly && !sketching && (
          <span role="group" aria-label="Operations" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={() => startTool('extrude', { extrudeOp: lastOps.current.extrude })}
              disabled={extrudeBlocked !== null}
              aria-pressed={tool?.kind === 'extrude'}
              title={extrudeBlocked ?? 'Extrude a 2D profile (the selected one, if it is 2D): Linear or Rotate, in the window'}
            >
              Extrude
            </button>
            <button
              onClick={() => startTool('boolean', { booleanOp: lastOps.current.boolean })}
              aria-pressed={tool?.kind === 'boolean'}
              title="Union, Difference or Intersection of parts (the selected ones fill the slots), in the window"
            >
              Boolean
            </button>
          </span>
        )}
        {!readOnly && !sketching && visibleCustomTools.length > 0 && (
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
              <span role="group" aria-label="Sketch tools" style={{ display: 'contents' }}>
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
              </span>
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
        {transformEditable && !sketching && (
          <span role="group" aria-label="Constrain" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Constrain:
            <button onClick={() => startTool('distance')} aria-pressed={tool?.kind === 'distance'} title="Place one part a distance from another, as an expression that follows it">
              Distance
            </button>
            <button onClick={() => startTool('align')} aria-pressed={tool?.kind === 'align'} title="Line up one part's edge or center with another's, as an expression that follows it">
              Align
            </button>
            <span
              data-testid="constrain-experimental"
              title="Distance and Align are temporary: they will be redone with a real constraint solver (picking faces, with dimension lines). What they write stays plain OpenSCAD."
              style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#e8a05a', border: '1px solid #e8a05a', borderRadius: 3, padding: '0 4px' }}
            >
              experimental
            </span>
            <button onClick={() => startTool('pattern')} aria-pressed={tool?.kind === 'pattern'} title="Copies of a part in a row or around an axis, as a for loop">
              Pattern
            </button>
          </span>
        )}
      </div>
      <datalist id={VARIABLE_DATALIST_ID}>
        {variables.map((v) => (
          <option key={`${v.name}:${v.line}`} value={v.name} />
        ))}
      </datalist>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {variablesOpen && (
          <VariablesPanel
            variables={variables}
            readOnly={false}
            onSetValue={handleVariableSet}
            onAdd={handleVariableAdd}
            onRename={handleVariableRename}
            onDelete={handleVariableDelete}
            onReveal={handleReveal}
            onOpenFile={handleOpenLibrary}
            module={variablesModule}
            included={includedSections}
            onClose={() => setVariablesOpen(false)}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Editor
            value={source}
            onChange={handleSourceChange}
            nodes={readOnly ? [] : sceneNodes}
            focusRange={
              !readOnly && workingSet?.container
                ? workingSet.container.focus ?? { start: workingSet.container.body.start, end: workingSet.container.body.end }
                : null
            }
            revealRequest={revealRequest}
            fontFamily={settings.editorFontFamily}
            fontSize={settings.editorFontSize}
            selectedIndex={readOnly ? null : primarySelectedIndex}
            onSelectNode={(index) => handleSelect(index, 'replace')}
            onCursorOffset={setCursorOffset}
            documentKey={documentToken}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid #333', position: 'relative' }}>
          {renderStartedAt !== null && renderIsSlow && <RenderProgressOverlay progressRef={renderProgressRef} onCancel={handleCancelRender} />}
          <RenderDetailBadge detail={renderDetail} rendering={renderStartedAt !== null} onRender={handleFullRender} />
          {tool && (
            <ToolPanel
              tool={tool}
              labelOf={labelOf}
              onChange={setTool}
              onApply={handleApplyTool}
              onCancel={() => setTool(null)}
              preview={toolPreview}
              gapAvailable={tool.kind === 'pattern' && tool.part !== null}
              applyLabel={tool.kind === 'extrude' && tool.profile === null ? 'Insert new' : undefined}
            />
          )}
          {propertiesWindow}
          {activeSketchPlane && (
            // M10b: the sketch tool's hint sits over the viewport, top center,
            // so the sketch toolbar stays one row.
            <div
              data-testid="sketch-hint"
              role="status"
              style={{
                position: 'absolute',
                top: 8,
                left: '50%',
                transform: 'translateX(-50%)',
                maxWidth: 'calc(100% - 260px)',
                zIndex: 10,
                pointerEvents: 'none',
                background: 'rgba(30,30,30,0.85)',
                color: '#ddd',
                fontSize: 12,
                fontFamily: 'sans-serif',
                padding: '4px 10px',
                borderRadius: 4,
                textAlign: 'center',
              }}
            >
              {sketchToolHint(sketchTool, toolAnchors.length, sketch.open.length)} ({sketch.profiles.length} loop
              {sketch.profiles.length === 1 ? '' : 's'}, {allSketchPoints(sketch).length} points)
            </div>
          )}
          <ErrorBoundary label="The 3D view" resetKey={nodeMeshes}>
            <Viewport
              meshes={nodeMeshes}
              selectedIndices={selectedIndices}
              onSelect={handleSelect}
              gizmoMode={gizmoMode}
              rotateSpace={rotateSpace}
              onTransformCommit={handleTransformCommit}
              fitToken={`${filePath ?? 'default'}:${resetViewToken}`}
              focusRequest={focusRequest}
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
              editable={!readOnly && !tool}
              freeAxes={primaryFreeAxes}
              cuttersFirst={workingSet?.containerCall === 'difference'}
              stale={renderStartedAt !== null && renderIsSlow}
              shading={shading}
            />
          </ErrorBoundary>
        </div>
      </div>
      {settingsOpen && <SettingsDialog settings={settings} onChange={handleSettingsChange} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

// M11: the variable names offered while typing in a value field.
const VARIABLE_DATALIST_ID = 'scad-variable-names';

// M8: one parameter-panel field, its widget inferred from the parameter's
// default (or the argument's own literal; see paramPanel.ts). Every widget
// commits OpenSCAD source text, so a commit is the same targeted argument
// patch whichever widget made it.
function ParamField({
  field,
  onCommit,
  disabled = false,
  fonts = null,
  onMakeVariable,
}: {
  field: PanelField;
  onCommit: (valueText: string) => void;
  disabled?: boolean;
  // M15: every font text() can use here, or null while still loading.
  fonts?: FontEntry[] | null;
  // M11: offered for a value that is a literal (or not passed yet).
  onMakeVariable?: () => void;
}) {
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
            // M11: text, not number, so a variable name or an expression
            // can be typed (names autocomplete from the variables list).
            type="text"
            inputMode="decimal"
            list={VARIABLE_DATALIST_ID}
            aria-label={label}
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
              type="text"
              inputMode="decimal"
              list={VARIABLE_DATALIST_ID}
              aria-label={`${label} ${axis}`}
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
    case 'choice': {
      const current = /^\s*"/.test(shown) ? unquoteScadString(shown) : shown;
      const choices = field.param?.choices ?? [];
      control = (
        <select aria-label={label} defaultValue={current} onChange={(e) => onCommit(quoteScadString(e.target.value))}>
          {!choices.includes(current) && <option value={current}>{current}</option>}
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
      break;
    }
    case 'font': {
      // M15: the font is written in the code (font="Family:style=Style");
      // this lists what can render it. A name not installed here still
      // shows, flagged, since another computer may have it.
      const current = /^\s*"/.test(shown) ? unquoteScadString(shown) : shown;
      const groups = fontGroups(fonts ?? []);
      const match = findOption(current, groups);
      const missing = fonts !== null && !isFontAvailable(current, fonts);
      control = (
        <>
          <select
            aria-label={label}
            value={match?.value ?? current}
            style={{ maxWidth: 220, fontFamily: current.split(':')[0] }}
            onChange={(e) => onCommit(quoteScadString(e.target.value))}
          >
            {!match && <option value={current}>{fonts === null ? current : `${current} (not installed)`}</option>}
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {missing && (
            <span role="note" style={{ color: '#e8a05a' }} title="OpenSCAD substitutes another font when the named one isn't installed. Install the font, or add it to the project with use <font.ttf>.">
              Not installed here: renders in a substitute font
            </span>
          )}
        </>
      );
      break;
    }
    default:
      control = (
        <input
          type="text"
          list={VARIABLE_DATALIST_ID}
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
      {onMakeVariable && (field.widget === 'number' || field.widget === 'angle' || field.widget === 'xyz' || field.widget === 'checkbox') && (
        <button
          className="make-variable"
          aria-label={`Make ${field.label} a variable`}
          title="Make variable: name this value at the top of the file and use the name here"
          onClick={onMakeVariable}
          style={{ fontSize: 11, padding: '0 4px', fontStyle: 'italic' }}
        >
          ƒx
        </button>
      )}
    </span>
    </fieldset>
  );
}
