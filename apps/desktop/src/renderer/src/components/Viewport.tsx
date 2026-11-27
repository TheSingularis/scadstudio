import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Bounds, Center, TransformControls, useBounds, Line, Edges, Html } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { ThreeEvent } from '@react-three/fiber';
import { Box3, Sphere, BufferGeometry, Color, DirectionalLight, SRGBColorSpace, EdgesGeometry, Mesh, MeshStandardMaterial, Vector3, Quaternion, PerspectiveCamera, type Group } from 'three';
import { readFaceColors, summarizeFaceColors, vertexColorAttribute } from '../meshColors';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

const DEFAULT_MESH_COLOR = '#4a90d9';
// The same, as sRGB bytes, for faces nothing colored (meshColors.ts).
const DEFAULT_MESH_RGB: [number, number, number] = [0x4a, 0x90, 0xd9];
// A single selection (or the *first*-clicked shape in a multi-select) reads
// as the "base" — the thing difference() subtracts from, union()/
// intersection()'s first argument, etc. Every other selected shape reads as
// an "operand" being combined/subtracted into it, in a visually distinct
// color, so which-shape-cuts-which is legible in the viewport itself instead
// of only inferable from click order (see App.tsx's Boolean toolbar legend).
export const SELECTED_MESH_COLOR = '#e8a33d';
export const OPERAND_MESH_COLOR = '#d9534f';
// `#` (highlight) styling — distinct from both the default and the two
// selection-role colors above so it reads unambiguously regardless of
// whether the highlighted node is also currently selected.
export const HIGHLIGHT_MESH_COLOR = '#a855f7';
// M10a: selection, boolean roles, `#` and hover are a tint over the part's
// own colors (and, for selection, its crease edges drawn in the role color),
// not a replacement color, so a selected part still shows what color it is.
// A part with no colors of its own (the default blue) is still drawn fully
// in the highlight color, as before.
// How far each pulls the surface color toward its highlight color:
const SELECTED_TINT = 0.45;
const HIGHLIGHT_TINT = 0.5;
const HOVER_TINT = 0.18;
const HOVER_TINT_COLOR = '#ffffff';
// Edges sharper than this get the role-colored outline when selected. Much
// coarser than the shading mode's 1 degree, so a dense curved surface shows
// its outline and creases, not every facet.
const SELECTION_EDGE_THRESHOLD_DEG = 35;
// M10a: while a render is running, the parts on screen are the previous
// render's: they are pulled most of the way toward grey, so it reads as out
// of date until the new meshes arrive.
const STALE_TINT_COLOR = '#7d828a';
const STALE_TINT = 0.65;
// `%` (background/ghost) opacity — real OpenSCAD renders these translucent
// and excludes them from the final CSG output; this app only ever renders
// top-level statements independently (no single merged CSG output to
// exclude from), so the translucency is the whole of what's reproduced here.
const GHOST_OPACITY = 0.35;
// M7.5 on-plane editing: the sketch being edited stays visible as a faint
// "before" reference behind its live handles.
const EDITING_REFERENCE_OPACITY = 0.2;
// M9 drill-in: everything outside the current working set is drawn dimmed
// (and can't be clicked), so the focused statements stand out.
const CONTEXT_MESH_COLOR = '#8a8f98';
const CONTEXT_OPACITY = 0.14;
// The confirm-flash after a typed edit (PLAN.md risk 5): the still-selected
// node glows briefly, so a selection that followed the wrong node shows.
const FLASH_MS = 600;
const FLASH_EMISSIVE = '#ffffff';
const SEE_THROUGH_BASE_OPACITY = 0.45;
// Handle colors while sketching — idle points keep the existing sketch
// preview amber; the hovered/dragged one turns white so it's obvious which
// point a drag will move.
const SKETCH_HANDLE_ACTIVE_COLOR = '#ffffff';
const SKETCH_OVERLAY_RENDER_ORDER = 999;
import { transformToQuaternion, quaternionToRotateDeg, type NodeTransform, type Modifier } from '../targetedPatch';
import { gizmoAxes } from '../gizmoLocks';
import {
  snapSketchPoint,
  extractOnPlaneGeometry,
  EMPTY_PLANE_SNAP_GEOMETRY,
  type PlaneSnapGeometry,
  type SnapKind,
  type SnapResult,
  type SnapSettings,
  type Vec2,
} from '../sketchSnap';
import type { SketchHandle, SketchState } from '../sketchEditing';
import { toolPreview, type SketchTool } from '../sketchShapes';
import { NavCube, NAMED_VIEWS, NAV_CUBE_MARGIN_PX, type CameraView, type Vec3 } from './NavCube';

// Parsed once per STL buffer and shared between NodeModel (drawing it) and
// sketch snapping (reading its edges) — keyed on the buffer itself, so a
// re-render that produces a new buffer naturally gets a fresh entry and the
// old one is collected along with it.
const geometryCache = new WeakMap<Uint8Array, BufferGeometry>();
function geometryFor(bytes: Uint8Array): BufferGeometry {
  let geom = geometryCache.get(bytes);
  if (!geom) {
    geom = new STLLoader().parse(bytes.buffer as ArrayBuffer);
    geom.computeVertexNormals();
    geometryCache.set(bytes, geom);
  }
  return geom;
}

// M10a: the same geometry with the render's own face colors as a vertex
// color attribute (meshColors.ts), or null when it has none worth drawing
// (no color trailer, or every face uncolored, which draws in the default
// color as before). Shares position/normal with geometryFor's geometry, so
// the GPU holds those once.
interface ColoredGeometry {
  geometry: BufferGeometry;
  translucent: boolean;
}
const coloredCache = new WeakMap<Uint8Array, ColoredGeometry | null>();
function coloredGeometryFor(bytes: Uint8Array): ColoredGeometry | null {
  if (coloredCache.has(bytes)) return coloredCache.get(bytes)!;
  const faces = readFaceColors(bytes);
  let result: ColoredGeometry | null = null;
  if (faces) {
    const summary = summarizeFaceColors(faces);
    if (!summary.allDefault || summary.translucent) {
      const base = geometryFor(bytes);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', base.getAttribute('position'));
      geometry.setAttribute('normal', base.getAttribute('normal'));
      geometry.setAttribute('color', vertexColorAttribute(faces, DEFAULT_MESH_RGB));
      result = { geometry, translucent: summary.translucent };
    }
  }
  coloredCache.set(bytes, result);
  return result;
}

// M10a: crease edges for the selection outline, computed once per geometry,
// as wide lines (plain WebGL lines are one pixel, too thin to notice).
const selectionEdgesCache = new WeakMap<BufferGeometry, LineSegmentsGeometry>();
function selectionEdgesFor(geometry: BufferGeometry): LineSegmentsGeometry {
  let edges = selectionEdgesCache.get(geometry);
  if (!edges) {
    edges = new LineSegmentsGeometry().fromEdgesGeometry(new EdgesGeometry(geometry, SELECTION_EDGE_THRESHOLD_DEG));
    selectionEdgesCache.set(geometry, edges);
  }
  return edges;
}
const SELECTION_EDGE_WIDTH_PX = 2.5;

function SelectionEdges({ geometry, color, opacity }: { geometry: LineSegmentsGeometry; color: string; opacity: number }) {
  const size = useThree((state) => state.size);
  const material = useMemo(() => new LineMaterial({ linewidth: SELECTION_EDGE_WIDTH_PX, transparent: true }), []);
  const line = useMemo(() => {
    const l = new LineSegments2(geometry, material);
    l.raycast = () => {};
    return l;
  }, [geometry, material]);
  useEffect(() => () => material.dispose(), [material]);
  material.color.set(color);
  material.opacity = opacity;
  material.resolution.set(size.width, size.height);
  return <primitive object={line} />;
}

// M10a: MeshStandardMaterial plus one step after the base color is known:
// mix it toward uTint by uTintAmount. That is what lets selection, hover and
// the stale state tint a part's real colors (vertex colors included) instead
// of replacing them. One shader program for every mesh (the cache key), and
// changing the tint only updates two uniforms.
function useTintedMaterial(): { material: MeshStandardMaterial; setTint: (color: string | null, amount: number) => void } {
  const material = useMemo(() => {
    // Pushed back a little in depth, so edge lines drawn on the surface
    // (selection outline, Shaded + edges) win over the faces they lie on.
    const m = new MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const uniforms = { uTint: { value: new Color() }, uTintAmount: { value: 0 } };
    m.userData.tint = uniforms;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTint = uniforms.uTint;
      shader.uniforms.uTintAmount = uniforms.uTintAmount;
      shader.fragmentShader =
        'uniform vec3 uTint;\nuniform float uTintAmount;\n' +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, uTint, uTintAmount);',
        );
    };
    m.customProgramCacheKey = () => 'scadstudio-tint';
    return m;
  }, []);
  useEffect(() => () => material.dispose(), [material]);
  const setTint = useCallback(
    (color: string | null, amount: number) => {
      const u = material.userData.tint as { uTint: { value: Color }; uTintAmount: { value: number } };
      if (color) u.uTint.value.set(color);
      u.uTintAmount.value = color ? amount : 0;
    },
    [material],
  );
  return { material, setTint };
}

// M7.5 point 5: how meshes draw. 'edges' overlays each mesh's facet edges
// (EdgesGeometry, so coplanar triangle diagonals from the STL triangulation
// are dropped and only real polygon boundaries show — the same facets real
// OpenSCAD's "Show Edges" draws); 'wireframe' draws only those edges, with
// the surface hidden but still clickable.
export type ShadingMode = 'shaded' | 'edges' | 'wireframe';
const SHADING_OPTIONS: { mode: ShadingMode; label: string }[] = [
  { mode: 'shaded', label: 'Shaded' },
  { mode: 'edges', label: 'Shaded + edges' },
  { mode: 'wireframe', label: 'Wireframe' },
];
// Facets of a coplanar face differ by ~0°; adjacent facets of even a dense
// curved surface (a $fn=64 cylinder: 5.6°) are well above this.
const EDGE_THRESHOLD_DEG = 1;
const EDGE_OVERLAY_COLOR = '#1b1b1b';

// Derived from drei's own component rather than three's OrbitControls
// directly — drei pins a slightly different three.js generic signature and
// the two named types don't structurally match.
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

export interface NodeMesh {
  index: number;
  bytes: Uint8Array;
  // Placement is a real transform now, not baked into the geometry — see
  // targetedPatch.ts's decomposeNode. This is what actually fixed the pivot
  // bug (rotate/scale correctly pivot around the shape's own local origin,
  // since that's where the geometry's own (0,0,0) already is) *and* the
  // "scale looks world-aligned after rotating" bug (the gizmo can now
  // legitimately operate in the object's local space, because the object
  // really does carry the rotation as its own transform).
  transform: NodeTransform;
  // `*` (disable) never reaches here — App.tsx skips rendering (and the WASM
  // call entirely) for disabled nodes, same as real OpenSCAD not evaluating
  // disabled geometry — so this is only ever '#' | '!' | '%' | null.
  modifier: Modifier | null;
  // M9: column-major world matrix of the working set this node belongs to
  // (its parent's placement when drilled in; absent/identity at the top
  // level). The node's own transform above is local to it.
  frame?: number[];
  // False when the frame couldn't be expressed as a matrix and the parent's
  // transforms are baked into `bytes` instead (drillIn.ts): no gizmo then.
  transformEditable?: boolean;
  // Unique key for context (dimmed) meshes, which have no working-set index.
  key?: string;
  // M18: rendered as a quick preview (curve detail lowered).
  reduced?: boolean;
  // M10a: text, which has an up and a reading direction (its local +Y and
  // +X, seen from +Z). Focus faces it square and level.
  upright?: boolean;
}

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type RotateSpace = 'local' | 'world';
// 'replace' (plain click) and 'toggle' (ctrl/cmd-click) preserve selection
// *sequence* order — M6's boolean toolbar needs click order to know which
// shape is "the base" vs "the tool" for difference(), where argument order
// is semantically load-bearing. 'range' (shift-click) instead produces a
// fresh contiguous span in document order between the last replace/toggle
// target and the clicked node, same as the usual file-manager convention.
export type SelectMode = 'replace' | 'toggle' | 'range';

interface ViewportProps {
  meshes: NodeMesh[];
  // See SelectMode above for how this gets ordered. The last entry is the
  // "primary" selection: the one the gizmo attaches to and the one mirror/
  // color/parameter-panel edit, since those are inherently single-target
  // operations.
  selectedIndices: number[];
  onSelect: (index: number | null, mode: SelectMode) => void;
  gizmoMode: GizmoMode;
  rotateSpace: RotateSpace;
  onTransformCommit: (index: number, transform: NodeTransform) => void;
  // Changing this value re-fits/re-centers the camera on the current scene
  // (see FitController below) — deliberately *not* derived from
  // `meshes` itself, so routine edits (dragging a gizmo, tweaking a
  // parameter) don't yank the camera around. App.tsx changes it only when a
  // genuinely new file is opened or the user explicitly clicks "Reset View".
  fitToken: string;
  // M10a: frame this node once its mesh is on screen (a shape a sketch just
  // added or changed). A new token asks again.
  focusRequest?: FocusRequest | null;
  // M7.5: null outside sketch mode (free orbit, as today). Non-null drives
  // the camera to that plane's canonical view (SketchController) and locks
  // orbit rotation (pan/zoom still work) for the duration — see PLAN.md
  // "Sketch mode (M7.5)". Generalized (slice 3) from a fixed XY/XZ/YZ enum
  // to an arbitrary origin+rotation, so a plane derived from a picked face
  // (kind: 'face') works through the exact same camera/drawing/codegen path
  // as the three global planes, not a parallel one.
  activeSketchPlane: ActiveSketchPlane | null;
  // M7.5 slice 3: true only during the brief "waiting for a face click"
  // window between clicking "Pick Face" and actually clicking one — camera
  // stays free-orbit (need to look around to find the right face), and
  // NodeModel's onClick computes a plane from the hit instead of selecting.
  // Mutually exclusive with activeSketchPlane being non-null (never both).
  pickingFace: boolean;
  onPickFace: (point: [number, number, number], rotationDeg: [number, number, number], normal: [number, number, number]) => void;
  // M7.5: the sketch session's loops and open polyline, in sketch-local
  // (u,v) — App.tsx owns it (cleared on entering/finishing/exiting a
  // sketch), Viewport renders it (SketchPointsPreview) and reports clicks on
  // the plane (SketchDrawingPlane → onSketchClick), already snapped. What a
  // click *does* depends on the active tool, which App.tsx decides; the
  // snap kind is passed along so a 'close' snap can close the open loop.
  sketch: SketchState;
  onSketchClick: (u: number, v: number, kind: SnapKind) => void;
  // M7.5 richer sketch tools: the active tool, the clicks it has collected
  // so far (a rectangle's first corner, a circle's center, an arc's end
  // point) and the segment count for circles/arcs — only for the live
  // preview; the shapes are built in App.tsx from the same functions.
  sketchTool: SketchTool;
  toolAnchors: [number, number][];
  curveSegments: number;
  // A plain click (no drag) on a handle. The handle sits on top of the
  // plane and swallows the click, so the plane never sees it; App.tsx
  // treats it as a click exactly on that point (closing the loop when it's
  // the open polyline's first point).
  onHandleClick: (handle: SketchHandle) => void;
  // M7.5 on-plane editing. Every placed point is a draggable handle while
  // sketching (drawing a new profile or editing a committed one): a drag
  // calls onSketchDragStart once on its first movement (App.tsx snapshots
  // the sketch for Undo there) and onMoveSketchPoint on every move after,
  // with the new sketch-local (u, v). Double-clicking a handle (with the
  // Edit Points tool) deletes it; Shift+double-click deletes its whole loop.
  onMoveSketchPoint: (handle: SketchHandle, u: number, v: number) => void;
  onSketchDragStart: () => void;
  onDeleteSketchPoint: (handle: SketchHandle, wholeLoop: boolean) => void;
  // Non-null while editing an already-committed sketch ("Edit Sketch"): that
  // node's mesh is drawn as a translucent, unclickable reference of its
  // pre-edit shape, and the preview draws the profile as a closed loop (it's
  // a finished polygon, not an in-progress polyline).
  editingNodeIndex: number | null;
  // M7.5 snap-while-drawing: which snap sources are on (App.tsx's sketch
  // toolbar owns them).
  snapSettings: SnapSettings;
  // M9 drill-in. The dimmed, unclickable rest of the design around the
  // working set; a double-click on a working-set shape asks to drill into
  // it; flashToken changes to flash the selected shapes; `overlay` (the
  // breadcrumb) is drawn over the viewport; `editable` false (a library
  // module, view-only) hides the gizmo.
  contextMeshes?: NodeMesh[];
  onDrill?: (index: number) => void;
  flashToken?: number;
  overlay?: ReactNode;
  editable?: boolean;
  // M11: the selected part's translate axes that drag by moving a
  // position variable (linkedDrag.ts).
  freeAxes?: readonly boolean[];
  // Drilled into a difference(): its first child (the base) is drawn
  // see-through and a click that passes through it picks the cutter behind
  // it, so subtracted shapes inside the base can be seen and selected.
  cuttersFirst?: boolean;
  // M10a: a render is running and has taken long enough to notice, so the
  // meshes on screen are out of date: they are drawn greyed out.
  stale?: boolean;
}

// M9: places a working set's nodes in their parent's frame. A plain group
// with its matrix set directly (no position/rotation/scale props), so the
// pivot groups inside keep holding just the node's own local transform,
// which is what a gizmo drag commits.
function FrameGroup({ frame, children }: { frame?: number[]; children: ReactNode }) {
  const ref = useRef<Group>(null);
  useLayoutEffect(() => {
    const g = ref.current;
    if (!g) return;
    if (frame) g.matrix.fromArray(frame);
    else g.matrix.identity();
    g.matrixWorldNeedsUpdate = true;
  }, [frame]);
  return (
    <group ref={ref} matrixAutoUpdate={false}>
      {children}
    </group>
  );
}

// M9: a mesh outside the working set, drawn faint and never hit-tested.
function ContextModel({ mesh, shading }: { mesh: NodeMesh; shading: ShadingMode }) {
  const geometry = useMemo(() => geometryFor(mesh.bytes), [mesh.bytes]);
  const quaternion = useMemo(() => transformToQuaternion(mesh.transform.rotateDeg), [mesh.transform.rotateDeg]);
  if (mesh.modifier === '%') return null;
  return (
    <FrameGroup frame={mesh.frame}>
      <group position={mesh.transform.translate} quaternion={[quaternion.x, quaternion.y, quaternion.z, quaternion.w]} scale={mesh.transform.scale}>
        <mesh geometry={geometry} raycast={() => null} renderOrder={-1}>
          <meshStandardMaterial
            color={CONTEXT_MESH_COLOR}
            side={2}
            transparent
            opacity={CONTEXT_OPACITY}
            depthWrite={false}
            visible={shading !== 'wireframe'}
          />
          {shading !== 'shaded' && <Edges threshold={EDGE_THRESHOLD_DEG} color={CONTEXT_MESH_COLOR} transparent opacity={0.35} />}
        </mesh>
      </group>
    </FrameGroup>
  );
}

type SelectionRole = 'none' | 'base' | 'operand';

function NodeModel({
  mesh,
  role,
  onSelect,
  onGroupRef,
  sketchActive,
  pickingFace,
  onPickFace,
  editing,
  shading,
  onDrill,
  flashToken,
  cuttersFirst = false,
  hovered = false,
  onHover,
  stale = false,
}: {
  mesh: NodeMesh;
  cuttersFirst?: boolean;
  // M10a: the pointer is over this part (a light tint), and whether the
  // viewport shows an older render while a new one runs (grey tint).
  hovered?: boolean;
  onHover?: (index: number | null) => void;
  stale?: boolean;
  role: SelectionRole;
  shading: ShadingMode;
  onDrill?: (index: number) => void;
  // Changes to flash this node (only passed for selected nodes).
  flashToken?: number;
  onSelect: (index: number, mode: SelectMode) => void;
  onGroupRef: (index: number, group: Group | null) => void;
  // M7.5 slice 2: existing shapes stop intercepting clicks while sketching,
  // so clicking anywhere (including "through" a shape sitting between the
  // camera and the sketch plane) always reaches the sketch surface below
  // instead of selecting/occluding it — sketching and normal shape
  // selection are mutually exclusive modes, not competing for the same
  // click.
  sketchActive: boolean;
  // M7.5 slice 3: while true, a click on this shape computes a sketch plane
  // from the hit face instead of selecting the shape — raycasting stays
  // enabled here (unlike sketchActive), since picking a face requires
  // actually hitting real geometry.
  pickingFace: boolean;
  onPickFace: (point: [number, number, number], rotationDeg: [number, number, number], normal: [number, number, number]) => void;
  // M7.5 on-plane editing: this is the sketch currently being edited — shown
  // ghosted as a reference of its pre-edit shape while the live handles
  // (SketchPointsPreview) show the shape it's becoming.
  editing: boolean;
}) {
  // openscad-wasm renders just the bare primitive now (translate/rotate/
  // scale are stripped before sending source to WASM — see App.tsx), so this
  // geometry already sits at the primitive's own OpenSCAD-local origin with
  // no placement baked in. The pivot group's position/quaternion/scale *are*
  // the node's translate/rotate/scale, applied via three.js's own transform
  // composition (T·R·S, the same order OpenSCAD composes them in) — so no
  // manual pivot/bounding-box math and no reset-on-render hack are needed:
  // these props are always driven fresh from the parsed source, exactly like
  // a normal declarative React prop.
  //
  // M10a: the render's own face colors draw as vertex colors, unless the
  // node has an outer color() of its own, which in OpenSCAD wins over every
  // color inside it (meshColors.ts), so then the whole mesh takes that one.
  const plainGeometry = useMemo(() => geometryFor(mesh.bytes), [mesh.bytes]);
  const colored = useMemo(() => (mesh.transform.color ? null : coloredGeometryFor(mesh.bytes)), [mesh.bytes, mesh.transform.color]);
  const geometry = colored?.geometry ?? plainGeometry;

  const quaternion = useMemo(() => transformToQuaternion(mesh.transform.rotateDeg), [mesh.transform.rotateDeg]);
  // OpenSCAD's color() takes 0-1 sRGB values. three.js's Color(r, g, b)
  // reads them as linear, which washed every color() out (found in M10a,
  // comparing with the same color drawn from the render's face colors), so
  // they are given as sRGB.
  const ownColor = useMemo(() => {
    const c = mesh.transform.color;
    return c ? new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace) : DEFAULT_MESH_COLOR;
  }, [mesh.transform.color]);
  // The highlight this part wears: selection role first, then `#`, then hover.
  const roleColor = role === 'base' ? SELECTED_MESH_COLOR : role === 'operand' ? OPERAND_MESH_COLOR : null;
  const highlightColor = roleColor ?? (mesh.modifier === '#' ? HIGHLIGHT_MESH_COLOR : null);
  // Wireframe has no surface to tint, so its lines carry the highlight.
  const wireColor = highlightColor ?? ownColor;
  // color([r,g,b,a])'s alpha, shown translucent the way OpenSCAD's preview
  // shows it (QC audit M2).
  const colorAlpha = mesh.transform.color?.length === 4 ? Math.min(1, Math.max(0, mesh.transform.color[3])) : 1;
  const { material, setTint } = useTintedMaterial();
  // A part with no colors of its own draws in the app's default blue, which
  // isn't a color the user chose: there the highlight replaces it fully, as
  // before M10a (a half tint of amber over blue comes out a muddy grey).
  const hasOwnColors = !!colored || !!mesh.transform.color;
  useEffect(() => {
    if (highlightColor) setTint(highlightColor, !hasOwnColors ? 1 : roleColor ? SELECTED_TINT : HIGHLIGHT_TINT);
    else if (hovered) setTint(HOVER_TINT_COLOR, HOVER_TINT);
    else if (stale) setTint(STALE_TINT_COLOR, STALE_TINT);
    else setTint(null, 0);
  }, [highlightColor, roleColor, hovered, stale, setTint, hasOwnColors]);
  const selectionEdges = useMemo(
    () => (roleColor && shading === 'shaded' ? selectionEdgesFor(plainGeometry) : null),
    [roleColor, shading, plainGeometry],
  );
  // `%` stays translucent regardless of selection/highlight — it's a
  // persistent "ghost reference" state, not something selecting the node
  // should visually override.
  const isGhost = mesh.modifier === '%' || editing;
  // See ViewportProps.cuttersFirst.
  const seeThroughBase = cuttersFirst && mesh.index === 0 && role === 'none';
  // The working-set index a click on this mesh means: the base hands a
  // click on to a cutter behind it.
  const clickedIndex = (e: ThreeEvent<MouseEvent>) => {
    if (!cuttersFirst || mesh.index !== 0) return mesh.index;
    const cutter = e.intersections.find((i) => typeof i.object.userData.scadIndex === 'number' && i.object.userData.scadIndex > 0);
    return cutter ? (cutter.object.userData.scadIndex as number) : mesh.index;
  };
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!flashToken) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashToken]);

  return (
    <group
      ref={(g) => {
        if (g) g.userData.mesh = mesh;
        onGroupRef(mesh.index, g);
      }}
      position={mesh.transform.translate}
      quaternion={[quaternion.x, quaternion.y, quaternion.z, quaternion.w]}
      scale={mesh.transform.scale}
    >
      <mesh
        geometry={geometry}
        // Disables raycasting for this mesh entirely while sketching (three.js
        // calls this instead of its default Mesh.raycast; doing nothing means
        // no hit is ever recorded) — see the sketchActive prop's doc comment.
        // Switching back must pass Mesh.prototype.raycast explicitly, not
        // `undefined`: r3f doesn't restore a function prop's default when it
        // goes undefined, so the no-op stuck around after the first sketch
        // session and every shape stayed unclickable (no selection, no Pick
        // Face) until the app was restarted.
        raycast={sketchActive ? () => null : Mesh.prototype.raycast}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          if (sketchActive) return;
          e.stopPropagation();
          if (pickingFace) {
            // e.face.normal is in the mesh's own local space — transformDirection
            // via the mesh's actual world matrix (which already folds in the
            // parent group's translate/rotate/scale) converts it to the world-
            // space normal this plane actually needs. e.point is already a
            // world-space hit, no transform needed.
            if (!e.face) return;
            const worldNormal = e.face.normal.clone().transformDirection(e.object.matrixWorld).normalize();
            const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), worldNormal);
            onPickFace([e.point.x, e.point.y, e.point.z], quaternionToRotateDeg(rotation), [worldNormal.x, worldNormal.y, worldNormal.z]);
            return;
          }
          // metaKey covers Cmd on macOS, where ctrl-click is reserved for
          // the OS's own right-click emulation.
          onSelect(clickedIndex(e), e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
        }}
        onDoubleClick={(e: ThreeEvent<MouseEvent>) => {
          if (sketchActive || pickingFace || !onDrill) return;
          e.stopPropagation();
          onDrill(clickedIndex(e));
        }}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          if (sketchActive || !onHover) return;
          e.stopPropagation();
          onHover(mesh.index);
        }}
        onPointerOut={() => onHover?.(null)}
        userData={{ scadIndex: mesh.index }}
      >
        <primitive
          object={material}
          attach="material"
          color={colored ? '#ffffff' : ownColor}
          vertexColors={!!colored}
          emissive={flashing ? FLASH_EMISSIVE : '#000000'}
          emissiveIntensity={flashing ? 0.55 : 0}
          side={2}
          transparent={isGhost || colorAlpha < 1 || seeThroughBase || !!colored?.translucent}
          opacity={editing ? EDITING_REFERENCE_OPACITY : isGhost ? GHOST_OPACITY : seeThroughBase ? SEE_THROUGH_BASE_OPACITY : colorAlpha}
          depthWrite={!editing && !seeThroughBase}
          // Hidden surface still raycasts (only drawing is skipped, same
          // split as SketchDrawingPlane's material) — shapes stay clickable
          // in wireframe mode.
          visible={shading !== 'wireframe'}
        />
        {selectionEdges && <SelectionEdges geometry={selectionEdges} color={roleColor!} opacity={isGhost ? GHOST_OPACITY : 1} />}
        {shading !== 'shaded' && (
          <Edges
            threshold={EDGE_THRESHOLD_DEG}
            // Wireframe carries the selection/highlight color on the edges
            // themselves, since there's no surface left to show it.
            color={shading === 'wireframe' ? wireColor : roleColor ?? EDGE_OVERLAY_COLOR}
            lineWidth={shading === 'wireframe' ? 1.5 : 1}
            transparent={isGhost}
            opacity={isGhost ? GHOST_OPACITY : 1}
          />
        )}
      </mesh>
    </group>
  );
}

// M10a lighting. With real model colors on screen they should look the way
// OpenSCAD shows them, and the old fixed light (from +Y, behind the default
// front-right-top view) left every face facing the camera in shadow, about
// half its color. A light that rides with the camera (as OpenSCAD's own
// viewer and most CAD viewers do) keeps whatever faces you look at lit,
// from slightly above and to the left so the faces still read apart.
const AMBIENT_LIGHT = 0.7;
const HEADLIGHT = 1.6;
const HEADLIGHT_OFFSET = new Vector3(-0.35, 0.5, 0); // camera-space: left, up
function HeadLight() {
  const light = useMemo(() => new DirectionalLight('#ffffff', HEADLIGHT), []);
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    scene.add(light.target);
    return () => {
      scene.remove(light.target);
    };
  }, [scene, light]);
  const forward = useMemo(() => new Vector3(), []);
  const offset = useMemo(() => new Vector3(), []);
  useFrame(() => {
    camera.getWorldDirection(forward);
    offset.copy(HEADLIGHT_OFFSET).applyQuaternion(camera.quaternion);
    light.position.copy(camera.position).add(offset);
    light.target.position.copy(camera.position).add(forward);
    light.target.updateMatrixWorld();
  });
  return <primitive object={light} />;
}

// Matches <Canvas camera={{ position: DEFAULT_CAMERA_POSITION, ... }}> below —
// the one true "default angle" every fit should return to. Z-up, like
// OpenSCAD itself (the viewport was three.js's default Y-up until the nav
// cube made that visible — see PLAN.md M7.5 nav-cube notes), looking from
// front-right-top: the FRONT/RIGHT/TOP faces of the nav cube face the user.
const DEFAULT_CAMERA_POSITION: Vec3 = [50, -50, 50];
const DEFAULT_CAMERA_UP: Vec3 = [0, 0, 1];

// Lives inside <Bounds> (needs its context via useBounds) and fires whenever
// fitToken changes. drei's own bounds.reset()/fit() fits distance along
// whatever direction the camera *currently* faces — exactly wrong for an
// explicit reset after the user has orbited away, since it would just
// re-frame along the orbited angle instead of returning to the standard
// isometric view. Snapping the camera back to the canonical position first
// makes reset()'s direction computation come out canonical too.
function FitController({ fitToken, orbitControlsRef }: { fitToken: string; orbitControlsRef: RefObject<OrbitControlsImpl | null> }) {
  const bounds = useBounds();
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    // Offset from the content's center, not the world origin: reset() keeps
    // whatever direction the camera has *relative to that center*, so a
    // position fixed relative to the origin came out skewed whenever the
    // content isn't centered on it (e.g. Reset View on the default example
    // landed noticeably off the front-right-top diagonal).
    const { center } = bounds.refresh().getSize();
    camera.position.set(...DEFAULT_CAMERA_POSITION).add(center);
    // A nav-cube view or sketch-plane lock leaves camera.up at that view's
    // screen-up (e.g. +Y after Top), which OrbitControls then orbits around —
    // reset it too, or "Reset View" would return to the right position with
    // the wrong orbit axis.
    camera.up.set(...DEFAULT_CAMERA_UP);
    const controls = orbitControlsRef.current;
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    bounds.refresh().fit().clip();
    // fitToken is the only intentional trigger — see its own doc comment on
    // ViewportProps for why this must NOT depend on meshes/content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken]);
  return null;
}

// M7.5: a sketch plane is an arbitrary origin+rotation now (slice 3 —
// generalized from the original fixed XY/XZ/YZ-only version to also support
// a plane derived from a picked face; see PLAN.md "Sketch mode (M7.5)").
// Tuples are used directly as three.js vectors, same as translate/rotate
// everywhere else in this app (see App.tsx/targetedPatch — there's no
// OpenSCAD-Z-up-to-three.js-Y-up remap anywhere), so a global "XY plane"
// means the plane where the third (Z) component is 0, matching real
// OpenSCAD's own XY/XZ/YZ naming, not three.js's default Y-up framing.
export type SketchPlaneKind = 'XY' | 'XZ' | 'YZ' | 'face';
export interface ActiveSketchPlane {
  kind: SketchPlaneKind;
  origin: [number, number, number];
  // The rotate() that places a flat (z=0) sketch's local (u,v) points onto
  // this plane in world space. Reused as-is by primitives.ts's
  // `appendSketchPolygon` codegen for the final `translate([...])
  // rotate([...]) polygon(...)` statement — using the exact same origin and
  // rotation for the live in-progress preview (below) and the committed
  // source is what guarantees they can never drift apart.
  rotationDeg: [number, number, number];
  // Where the locked sketch camera centers. Defaults to `origin`; a
  // face-picked plane sets it to the clicked point, since its origin is
  // moved off the click to the world origin's projection onto the face (see
  // buildFaceSketchPlane) and may sit well away from the face itself.
  focus?: [number, number, number];
}

// Hand-picked camera framing for the three global planes, preserved exactly
// as slice 1 shipped and verified it (Z reads as "up" on screen for all
// three) — kept separate from the general face-derived formula in
// SketchController below rather than deriving these three from rotationDeg
// too, since the derived "up" for YZ doesn't happen to match this
// (documented where GLOBAL_SKETCH_PLANE_ROTATIONS is defined below); no reason to
// risk already-verified behavior switching formulas to unify a cosmetic.
// These are exactly the nav cube's Top/Front/Right views (same
// position-at-distance-60 and up as slice 1's original hand-picked tuples).
const GLOBAL_SKETCH_PLANE_VIEWS: Record<'XY' | 'XZ' | 'YZ', CameraView> = {
  XY: NAMED_VIEWS.top,
  XZ: NAMED_VIEWS.front,
  YZ: NAMED_VIEWS.right,
};
// Camera distance for a sketch plane on an empty scene. With content, the
// distance fits it instead (M10a: the fixed 60 was too close for a large
// model and too far for a small one; see sketchCameraDistance).
const SKETCH_CAMERA_DISTANCE = 60;
const SKETCH_CAMERA_MIN_DISTANCE = 10;

// M10a: far enough back to see everything on screen from `target`: the
// distance Bounds would fit the content at, plus how far the content's
// center is from where the camera looks.
function sketchCameraDistance(bounds: BoundsApi, target: Vec3): number {
  const { center, distance } = bounds.refresh().getSize();
  if (!Number.isFinite(distance) || distance <= 0) return SKETCH_CAMERA_DISTANCE;
  return Math.max(SKETCH_CAMERA_MIN_DISTANCE, distance + center.distanceTo(new Vector3(...target)));
}

// The actual world-space mapping each rotation produces per axis is a
// documented side effect of the rotation math, not something independently
// chosen to match GLOBAL_SKETCH_PLANE_VIEWS's camera "up" above (getting
// both to agree is a cosmetic nice-to-have, not attempted here).
const GLOBAL_SKETCH_PLANE_ROTATIONS: Record<'XY' | 'XZ' | 'YZ', [number, number, number]> = {
  XY: [0, 0, 0],
  XZ: [90, 0, 0],
  YZ: [0, 90, 0],
};

export function buildGlobalSketchPlane(kind: 'XY' | 'XZ' | 'YZ'): ActiveSketchPlane {
  return { kind, origin: [0, 0, 0], rotationDeg: GLOBAL_SKETCH_PLANE_ROTATIONS[kind] };
}

// The plane's origin is the world origin's projection onto the face
// (normal * (normal . point)), not the clicked point itself: sketch-local
// (u, v) is measured from the origin, so this is what makes grid snapping
// on a face land on the same round world coordinates as on a global plane
// (for any axis-aligned face) instead of on a grid offset by wherever the
// click happened to land — and it keeps the emitted translate() to the
// face's real offset (e.g. [0, 15, 0]) rather than an arbitrary hit point.
// The click still decides where the camera looks (focus).
export function buildFaceSketchPlane(
  point: [number, number, number],
  rotationDeg: [number, number, number],
  normal: [number, number, number],
): ActiveSketchPlane {
  const n = new Vector3(...normal).normalize();
  const offset = n.dot(new Vector3(...point));
  // Rounded so float noise from the raycast doesn't leak into the source as
  // e.g. translate([0, 0, 3.9999999]) — formatNumber rounds to 3 decimals on
  // output anyway, so rounding here keeps the live plane identical to the
  // committed one.
  const clean = (v: number) => Math.round(v * 1000) / 1000 + 0;
  return {
    kind: 'face',
    origin: [clean(n.x * offset), clean(n.y * offset), clean(n.z * offset)],
    rotationDeg: [clean(rotationDeg[0]), clean(rotationDeg[1]), clean(rotationDeg[2])],
    focus: point,
  };
}

// M7.5 on-plane editing: rebuilds the plane a committed sketch was drawn on
// from its own translate()/rotate() wrap — the inverse of what
// appendSketchPolygon emitted. A wrap that matches one of the three global
// planes exactly (origin at 0, same rotation) maps back to that plane, so
// re-editing an XY/XZ/YZ sketch gets the same hand-picked camera framing it
// was drawn with; anything else (a picked face, or a sketch the gizmo has
// since moved/rotated) goes through the general face-derived camera path,
// which frames any origin+rotation correctly.
export function sketchPlaneFromTransform(origin: [number, number, number], rotationDeg: [number, number, number]): ActiveSketchPlane {
  if (origin.every((v) => v === 0)) {
    for (const kind of ['XY', 'XZ', 'YZ'] as const) {
      if (GLOBAL_SKETCH_PLANE_ROTATIONS[kind].every((v, i) => v === rotationDeg[i])) return buildGlobalSketchPlane(kind);
    }
  }
  return { kind: 'face', origin, rotationDeg };
}

// The one "animate the camera to a given orientation" primitive (PLAN.md
// M7.5 point 5): sketch-mode's plane lock, nav-cube clicks, and the nav
// cube's step arrows all go through this — no second animation path. Uses
// Bounds' lower-level moveTo/lookAt rather than fit()/reset(), since each of
// these is a fixed given orientation, not something derived from content.
type BoundsApi = ReturnType<typeof useBounds>;
function animateCameraTo(bounds: BoundsApi, target: Vec3, view: CameraView, distance: number) {
  const position = new Vector3(...view.direction).normalize().multiplyScalar(distance).add(new Vector3(...target));
  bounds.refresh().moveTo([position.x, position.y, position.z]).lookAt({ target, up: view.up });
}

// Sibling to FitController, same "lives inside <Bounds> for useBounds, fires
// on prop change only" shape.
//
// M10a: entering sketch mode saves the view, and leaving puts it back
// (it used to reset to the default view, which threw away the user's angle;
// Jordan, 2026-11-27). A shape added in the sketch is then framed by
// FocusController once it has rendered.
function SketchController({ activeSketchPlane, viewApiRef }: { activeSketchPlane: ActiveSketchPlane | null; viewApiRef: RefObject<ViewApi | null> }) {
  const bounds = useBounds();
  const savedRef = useRef<SavedView | null>(null);
  useEffect(() => {
    if (!activeSketchPlane) {
      const saved = savedRef.current;
      savedRef.current = null;
      if (saved) viewApiRef.current?.restore(saved);
      return;
    }
    if (!savedRef.current) savedRef.current = viewApiRef.current?.snapshot() ?? null;
    const { kind, rotationDeg } = activeSketchPlane;
    const focus = activeSketchPlane.focus ?? activeSketchPlane.origin;
    if (kind !== 'face') {
      animateCameraTo(bounds, [0, 0, 0], GLOBAL_SKETCH_PLANE_VIEWS[kind], sketchCameraDistance(bounds, [0, 0, 0]));
      return;
    }
    // Face-derived plane: no hand-picked view to preserve, so the view is
    // derived directly from the plane's own rotation — look back along the
    // plane's local +Z (its normal), with the plane's local +Y as
    // screen-up, centered on the picked point rather than the world origin.
    const rotation = transformToQuaternion(rotationDeg);
    const normal = new Vector3(0, 0, 1).applyQuaternion(rotation);
    const up = new Vector3(0, 1, 0).applyQuaternion(rotation);
    animateCameraTo(
      bounds,
      focus,
      { direction: [normal.x, normal.y, normal.z], up: [up.x, up.y, up.z] },
      sketchCameraDistance(bounds, focus),
    );
    // viewApiRef is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSketchPlane, bounds]);
  return null;
}

// M10a: frame some parts, keeping the view's angle (like Unity's F): the
// Focus button / F key on the selection, and a shape a sketch just added
// or changed once its new mesh is on screen. Waits (a few frames at most)
// for each part's group to hold its current mesh, since the Canvas mounts
// a new one a frame or so after the meshes change. The box is the parts'
// world bounds, so their own translate/rotate and any drill-in frame count.
export interface FocusRequest {
  token: number;
  indices: number[];
}
function FocusController({
  request,
  meshes,
  groupsByIndex,
  viewApiRef,
}: {
  request: FocusRequest | null;
  meshes: NodeMesh[];
  groupsByIndex: RefObject<Map<number, Group>>;
  viewApiRef: RefObject<ViewApi | null>;
}) {
  const pending = useRef<{ indices: number[]; frames: number } | null>(null);
  useEffect(() => {
    pending.current = request && request.indices.length > 0 ? { indices: request.indices, frames: 0 } : null;
  }, [request?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(() => {
    const p = pending.current;
    if (!p) return;
    if (++p.frames > 120) {
      pending.current = null;
      return;
    }
    const box = new Box3();
    for (const index of p.indices) {
      const mesh = meshes.find((m) => m.index === index);
      const group = groupsByIndex.current?.get(index);
      if (!mesh || !group || group.userData.mesh !== mesh) return;
      box.expandByObject(group);
    }
    if (box.isEmpty()) return;
    pending.current = null;
    // One upright part (text): look at its face, its up as screen-up.
    let facing: CameraView | undefined;
    const only = p.indices.length === 1 ? meshes.find((m) => m.index === p.indices[0]) : undefined;
    const group = only?.upright ? groupsByIndex.current?.get(only.index) : undefined;
    if (group) {
      const q = group.getWorldQuaternion(new Quaternion());
      const n = new Vector3(0, 0, 1).applyQuaternion(q);
      const up = new Vector3(0, 1, 0).applyQuaternion(q);
      facing = { direction: [n.x, n.y, n.z], up: [up.x, up.y, up.z] };
    }
    viewApiRef.current?.frameBox(box, facing);
  });
  return null;
}

// 90° steps, named for which way the *model* turns on screen (the same way
// it turns when orbit-dragging in that direction), plus a 90° roll.
export type ViewStep = 'left' | 'right' | 'up' | 'down' | 'rollCw' | 'rollCcw';
const VIEW_STEPS: { step: ViewStep; glyph: string; title: string; dx: number; dy: number }[] = [
  { step: 'up', glyph: '▲', title: 'Rotate view up 90°', dx: 0, dy: -70 },
  { step: 'down', glyph: '▼', title: 'Rotate view down 90°', dx: 0, dy: 70 },
  { step: 'left', glyph: '◀', title: 'Rotate view left 90°', dx: -70, dy: 0 },
  { step: 'right', glyph: '▶', title: 'Rotate view right 90°', dx: 70, dy: 0 },
  { step: 'rollCcw', glyph: '↺', title: 'Roll view counter-clockwise 90°', dx: -58, dy: -58 },
  { step: 'rollCw', glyph: '↻', title: 'Roll view clockwise 90°', dx: 58, dy: -58 },
];

interface SavedView {
  view: CameraView;
  target: Vec3;
  distance: number;
}
interface ViewApi {
  orient: (view: CameraView) => void;
  step: (step: ViewStep) => void;
  // M10a: the view as it is now (or where it's animating to), and a move
  // back to one saved earlier. Sketch mode saves on entry and restores on
  // leaving, instead of resetting to the default view.
  snapshot: () => SavedView;
  restore: (saved: SavedView) => void;
  // M10a: keeps the view's direction and centers on `box`, close enough to
  // fill the view with it (a new sketch shape, after leaving sketch mode).
  // With `view`, turns to that direction and screen-up as well.
  frameBox: (box: Box3, view?: CameraView) => void;
}

// How much room frameBox leaves around the box (same as <Bounds margin>).
const FRAME_MARGIN = 1.2;
const FRAME_MIN_DISTANCE = 5;

// Bounds' default animation length (its maxDuration prop, left unset below).
const VIEW_ANIMATION_MS = 1000;

// Lives inside <Bounds> like the two controllers above; exposes the camera
// moves the nav cube (in its own HUD scene) and the HTML step arrows (outside
// the Canvas entirely) trigger, via a ref instead of a prop-change trigger
// since these are imperative one-shot clicks, not state.
function ViewController({ apiRef }: { apiRef: RefObject<ViewApi | null> }) {
  const bounds = useBounds();
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as OrbitControlsImpl | null;
  useEffect(() => {
    // The view most recently animated to. A step clicked while the previous
    // one is still animating builds on that goal rather than the half-turned
    // camera, so rapid clicks still land on exact 90° multiples. An orbit
    // drag (which also cancels Bounds' animation) invalidates it.
    let pending: { view: CameraView; target: Vec3; distance: number; at: number } | null = null;
    const clearPending = () => {
      pending = null;
    };
    controls?.addEventListener('start', clearPending);

    const current = () => {
      if (pending && performance.now() - pending.at < VIEW_ANIMATION_MS) return pending;
      const target = controls ? controls.target.clone() : new Vector3();
      const direction = camera.position.clone().sub(target).normalize();
      // Screen-up from the camera's actual orientation, not camera.up, which
      // only approximates it (OrbitControls treats it as an orbit axis).
      const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      return {
        view: { direction: [direction.x, direction.y, direction.z] as Vec3, up: [up.x, up.y, up.z] as Vec3 },
        target: [target.x, target.y, target.z] as Vec3,
        distance: camera.position.distanceTo(target),
      };
    };
    const go = (view: CameraView, target: Vec3, distance: number) => {
      pending = { view, target, distance, at: performance.now() };
      animateCameraTo(bounds, target, view, distance);
    };

    apiRef.current = {
      // Keeps the current look-at target and zoom distance — only the
      // orientation changes, same as Onshape/Fusion's view cubes.
      orient: (view) => {
        const { target, distance } = current();
        go(view, target, distance);
      },
      step: (step) => {
        const { view, target, distance } = current();
        const direction = new Vector3(...view.direction);
        const up = new Vector3(...view.up);
        const right = up.clone().cross(direction).normalize();
        const quarter = Math.PI / 2;
        if (step === 'left' || step === 'right') {
          // Model turns right ⇔ camera orbits left around screen-up.
          direction.applyAxisAngle(up, step === 'right' ? -quarter : quarter);
        } else if (step === 'up' || step === 'down') {
          // Model tips up (front face rolls to the top) ⇔ camera drops below.
          const angle = step === 'up' ? quarter : -quarter;
          direction.applyAxisAngle(right, angle);
          up.applyAxisAngle(right, angle);
        } else {
          // Model turns clockwise on screen ⇔ screen-up rotates the other way
          // around the view axis.
          up.applyAxisAngle(direction, step === 'rollCw' ? quarter : -quarter);
        }
        go({ direction: [direction.x, direction.y, direction.z], up: [up.x, up.y, up.z] }, target, distance);
      },
      snapshot: () => {
        const { view, target, distance } = current();
        return { view, target, distance };
      },
      restore: (saved) => go(saved.view, saved.target, saved.distance),
      frameBox: (box, facing) => {
        const view = facing ?? current().view;
        const sphere = box.getBoundingSphere(new Sphere());
        const fov = camera instanceof PerspectiveCamera ? camera.fov : 45;
        const aspect = camera instanceof PerspectiveCamera ? camera.aspect : 1;
        // The narrower of the two view angles decides how far back to sit.
        const halfV = (fov * Math.PI) / 360;
        const half = Math.min(halfV, Math.atan(Math.tan(halfV) * aspect));
        const distance = Math.max(FRAME_MIN_DISTANCE, (sphere.radius * FRAME_MARGIN) / Math.sin(half));
        go(view, [sphere.center.x, sphere.center.y, sphere.center.z], distance);
      },
    };
    return () => {
      controls?.removeEventListener('start', clearPending);
      apiRef.current = null;
    };
  }, [apiRef, bounds, camera, controls]);
  return null;
}

const overlayButtonStyle = {
  position: 'absolute',
  width: 22,
  height: 22,
  padding: 0,
  border: '1px solid #aaa',
  borderRadius: 4,
  background: 'rgba(255, 255, 255, 0.85)',
  color: '#333',
  fontSize: 12,
  lineHeight: '20px',
  textAlign: 'center',
  cursor: 'pointer',
} as const;

// M7.5 snap-while-drawing: how close (in screen pixels) the cursor has to
// get to a snap target for it to grab — converted to sketch-local units
// per pointer event (see SketchDrawingPlane's snapAt), so it feels the same
// at any zoom level instead of being a fixed world distance.
const SNAP_RADIUS_PX = 10;
// Preview-only geometry (grid, markers) sits this far off the sketch plane
// toward the camera (every plane's camera looks down its local +Z — see
// SketchController), so it doesn't z-fight with an existing face the sketch
// was picked from. Never applied to committed coordinates.
const PREVIEW_LIFT = 0.01;
// Grid overlay is SKETCH_GRID_EXTENT units across, centered on the plane origin.
const SKETCH_GRID_EXTENT = 200;
const SNAP_POINT_COLOR = '#2da44e';
const SNAP_MARKER_COLORS: Record<SnapKind, string> = {
  close: SNAP_POINT_COLOR,
  endpoint: SNAP_POINT_COLOR,
  midpoint: SNAP_POINT_COLOR,
  origin: SNAP_POINT_COLOR,
  edge: '#1f9fb4',
  align: '#a855f7',
  grid: '#555555',
  none: SELECTED_MESH_COLOR,
};
const SNAP_LABELS: Record<SnapKind, string> = {
  close: 'Close loop',
  endpoint: 'Endpoint',
  midpoint: 'Midpoint',
  origin: 'Origin',
  edge: 'On edge',
  align: 'Aligned',
  grid: 'Grid',
  none: 'Free',
};
// GridHelper lies in its own XZ plane; this turns its lines into the
// sketch's local XY (u, v) plane before the plane's own rotation applies.
const GRID_TO_SKETCH_LOCAL = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);

function formatCoord(n: number): string {
  return String(Math.round(n * 1000) / 1000 + 0);
}

// M7.5 slice 2: a large invisible mesh exactly at the active sketch plane —
// the actual click target for placing points. Real r3f mesh + onClick
// (not a raw DOM listener) so it participates in the normal raycast/event
// system rather than fighting it; existing shapes disable their own
// raycasting while sketching (NodeModel's sketchActive prop), so this plane
// is always what a click lands on regardless of what's visually in front of
// it from the camera's angle. Lives outside <Bounds> (same reasoning as the
// gizmo below) — its generous 1000x1000 size would badly skew any
// fit-to-content bounding box if it were counted.
function SketchDrawingPlane({
  activeSketchPlane,
  onAddPoint,
  onPointerMoveLocal,
  suppressClickRef,
  snapSettings,
  getSnapContext,
  onHover,
}: {
  activeSketchPlane: ActiveSketchPlane;
  onAddPoint: (u: number, v: number, kind: SnapKind) => void;
  // M7.5 on-plane editing: every pointer move over the plane, already
  // converted to sketch-local (u,v) — Viewport uses it to drive a handle
  // drag. The plane (not the handle itself) is the move target on purpose:
  // the 0.8-unit handle sphere falls out from under a fast-moving cursor
  // immediately, the 1000x1000 plane never does.
  onPointerMoveLocal: (u: number, v: number) => void;
  // True for the one native 'click' that follows the mouseup ending a
  // handle drag — that release shouldn't also add a point wherever the
  // drag happened to end.
  suppressClickRef: RefObject<boolean>;
  // M7.5 snap-while-drawing (sketchSnap.ts). Points handed to onAddPoint /
  // onPointerMoveLocal are already snapped; the raw cursor is never exposed.
  snapSettings: SnapSettings;
  // What to snap against right now: the points used for alignment guides
  // (the open polyline first, so its first point is the close target), the
  // on-plane geometry (existing shapes plus this session's closed loops),
  // and whether clicking the first point closes the loop. While dragging,
  // the dragged point's own loop is left out of the geometry (it would snap
  // to its own old position).
  getSnapContext: () => { points: Vec2[]; geometry: PlaneSnapGeometry; allowClose: boolean };
  onHover: (snap: SnapResult | null) => void;
}) {
  const camera = useThree((state) => state.camera);
  const viewportHeightPx = useThree((state) => state.size.height);
  const quaternion = useMemo(() => transformToQuaternion(activeSketchPlane.rotationDeg), [activeSketchPlane.rotationDeg]);
  const inverseQuaternion = useMemo(() => quaternion.clone().invert(), [quaternion]);
  // e.point is the world-space hit — subtracting the plane's own origin then
  // inverse-rotating back through the same rotation that places the plane
  // recovers the sketch-local (u,v) the pointer is over (local z comes out
  // ~0, discarded). Identity for global planes (origin always [0,0,0]
  // there), load-bearing for a face-derived one.
  const toLocal = (point: Vector3) => point.clone().sub(new Vector3(...activeSketchPlane.origin)).applyQuaternion(inverseQuaternion);
  const snapAt = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): SnapResult => {
    const local = toLocal(e.point);
    const raw: Vec2 = [local.x, local.y];
    // Alt is the usual CAD "don't snap this one" modifier.
    if (e.nativeEvent.altKey) return { point: raw, kind: 'none', alignedU: null, alignedV: null };
    // World units covered by one screen pixel at the hit's depth — the
    // canvas camera is always perspective (see <Canvas camera> below).
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 45;
    const depth = camera.position.distanceTo(e.point);
    const unitsPerPx = (2 * depth * Math.tan((fov * Math.PI) / 360)) / (camera.zoom * viewportHeightPx);
    const { points, geometry, allowClose } = getSnapContext();
    return snapSketchPoint(raw, points, geometry, snapSettings, SNAP_RADIUS_PX * unitsPerPx, allowClose);
  };
  return (
    <mesh
      position={activeSketchPlane.origin}
      quaternion={[quaternion.x, quaternion.y, quaternion.z, quaternion.w]}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (suppressClickRef.current) return;
        // Recomputed from the click itself rather than reusing the last
        // hover result, so a click always commits exactly what the snap
        // rules say about where it actually landed.
        const snap = snapAt(e);
        onAddPoint(snap.point[0], snap.point[1], snap.kind);
      }}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        const snap = snapAt(e);
        onHover(snap);
        onPointerMoveLocal(snap.point[0], snap.point[1]);
      }}
      onPointerOut={() => onHover(null)}
    >
      <planeGeometry args={[1000, 1000]} />
      {/* Invisible material, not an invisible mesh — Object3D.visible=false
          would also disable raycasting; material.visible=false only skips
          drawing it, which is exactly the "clickable but unseen" split
          this needs. */}
      <meshBasicMaterial visible={false} />
    </mesh>
  );
}

// The snap grid, rubber band from the last placed point, alignment guides
// and the labelled marker for whatever the cursor is currently snapping to.
// Preview-only: none of it ever reaches the committed source.
function SketchSnapOverlay({
  activeSketchPlane,
  snapSettings,
  hover,
  lastPoint,
  drawing,
  tool,
  anchors,
  curveSegments,
}: {
  activeSketchPlane: ActiveSketchPlane;
  snapSettings: SnapSettings;
  hover: SnapResult | null;
  lastPoint: Vec2 | null;
  // The straight rubber band only makes sense while the Line tool (or the
  // Arc tool, before its end point) is appending to an open profile.
  drawing: boolean;
  tool: SketchTool;
  anchors: Vec2[];
  curveSegments: number;
}) {
  const quaternion = useMemo(() => transformToQuaternion(activeSketchPlane.rotationDeg), [activeSketchPlane.rotationDeg]);
  const origin = useMemo(() => new Vector3(...activeSketchPlane.origin), [activeSketchPlane.origin]);
  const gridQuaternion = useMemo(() => quaternion.clone().multiply(GRID_TO_SKETCH_LOCAL), [quaternion]);
  const toWorld = useCallback(
    ([u, v]: Vec2) => new Vector3(u, v, PREVIEW_LIFT).applyQuaternion(quaternion).add(origin),
    [quaternion, origin],
  );
  const gridPosition = useMemo(() => toWorld([0, 0]), [toWorld]);
  // What the active tool would add if the next click landed under the
  // cursor — built by the same sketchShapes.ts functions the commit uses.
  const preview = hover ? toolPreview(tool, anchors, lastPoint, hover.point, curveSegments) : null;
  return (
    <>
      {snapSettings.grid && snapSettings.gridSize > 0 && (
        <gridHelper
          // Keyed on spacing: GridHelper bakes its lines in at construction,
          // so a new spacing needs a new instance, not a prop update.
          key={snapSettings.gridSize}
          args={[SKETCH_GRID_EXTENT, Math.round(SKETCH_GRID_EXTENT / snapSettings.gridSize), '#8a8a8a', '#d4d4d4']}
          position={gridPosition}
          quaternion={[gridQuaternion.x, gridQuaternion.y, gridQuaternion.z, gridQuaternion.w]}
        />
      )}
      {anchors.map((a, i) => (
        <mesh key={`anchor-${i}`} position={toWorld(a)} renderOrder={SKETCH_OVERLAY_RENDER_ORDER}>
          <sphereGeometry args={[0.6, 12, 12]} />
          <meshBasicMaterial color={SELECTED_MESH_COLOR} depthTest={false} />
        </mesh>
      ))}
      {preview && preview.points.length > 1 && (
        <Line
          points={(preview.closed ? [...preview.points, preview.points[0]] : preview.points).map(toWorld)}
          color={SELECTED_MESH_COLOR}
          lineWidth={1.5}
          dashed
          dashSize={1}
          gapSize={0.6}
          depthTest={false}
          renderOrder={SKETCH_OVERLAY_RENDER_ORDER}
        />
      )}
      {hover && (
        <>
          {drawing && lastPoint && (
            <Line
              points={[toWorld(lastPoint), toWorld(hover.point)]}
              color={SELECTED_MESH_COLOR}
              lineWidth={1}
              dashed
              dashSize={1}
              gapSize={0.6}
              depthTest={false}
              renderOrder={SKETCH_OVERLAY_RENDER_ORDER}
            />
          )}
          {[hover.alignedU, hover.alignedV].map(
            (ref, i) =>
              ref && (
                <Line
                  key={i}
                  points={[toWorld(ref), toWorld(hover.point)]}
                  color={SNAP_MARKER_COLORS.align}
                  lineWidth={1}
                  dashed
                  dashSize={0.5}
                  gapSize={0.5}
                  depthTest={false}
                  renderOrder={SKETCH_OVERLAY_RENDER_ORDER}
                />
              ),
          )}
          <mesh position={toWorld(hover.point)} renderOrder={SKETCH_OVERLAY_RENDER_ORDER}>
            <sphereGeometry args={[hover.kind === 'close' ? 1.2 : 0.6, 12, 12]} />
            <meshBasicMaterial color={SNAP_MARKER_COLORS[hover.kind]} depthTest={false} />
          </mesh>
          <Html position={toWorld(hover.point)} style={{ pointerEvents: 'none' }}>
            <div
              data-testid="sketch-snap-label"
              style={{
                transform: 'translate(12px, 8px)',
                whiteSpace: 'nowrap',
                fontFamily: 'sans-serif',
                fontSize: 11,
                padding: '2px 6px',
                borderRadius: 3,
                color: '#fff',
                background: SNAP_MARKER_COLORS[hover.kind],
              }}
            >
              {SNAP_LABELS[hover.kind]} ({formatCoord(hover.point[0])}, {formatCoord(hover.point[1])})
            </div>
          </Html>
        </>
      )}
    </>
  );
}

// The session's sketch geometry, rendered live: every closed loop, plus the
// open polyline the Line/Arc tools are appending to (not closed until its
// first point is clicked, or Finish/Save). Same outside-<Bounds> reasoning
// as the drawing plane: this is drawing-session UI, not modeled content.
function SketchPointsPreview({
  activeSketchPlane,
  sketch,
  activeHandle,
  onHandleDown,
  onHandleHover,
  onHandleDelete,
  onHandleClick,
}: {
  activeSketchPlane: ActiveSketchPlane;
  sketch: SketchState;
  // Hovered or currently-dragged handle, highlighted.
  activeHandle: SketchHandle | null;
  onHandleDown: (handle: SketchHandle) => void;
  onHandleHover: (handle: SketchHandle | null) => void;
  onHandleDelete: (handle: SketchHandle, wholeLoop: boolean) => void;
  // A plain click (no drag) on a handle — see ViewportProps.onHandleClick.
  onHandleClick: (handle: SketchHandle) => void;
}) {
  const quaternion = useMemo(() => transformToQuaternion(activeSketchPlane.rotationDeg), [activeSketchPlane.rotationDeg]);
  const origin = useMemo(() => new Vector3(...activeSketchPlane.origin), [activeSketchPlane.origin]);
  const loops = useMemo(() => {
    const toWorld = ([u, v]: [number, number]) => new Vector3(u, v, 0).applyQuaternion(quaternion).add(origin);
    return [
      ...sketch.profiles.map((points, profile) => ({ profile, closed: true, world: points.map(toWorld) })),
      { profile: -1, closed: false, world: sketch.open.map(toWorld) },
    ];
  }, [sketch, quaternion, origin]);
  return (
    <>
      {loops.map(({ profile, closed, world }) => {
        if (world.length === 0) return null;
        const linePoints = closed && world.length > 2 ? [...world, world[0]] : world;
        return (
          <group key={profile}>
            {/* depthTest off + a late renderOrder: the sketch overlay always draws on
                top, so a handle sitting behind other geometry from the camera's
                angle (very common for a face-picked plane — neighboring solids
                stick out toward the camera) stays visible and grabbable. Hit-
                testing already ignores those solids while sketching (sketchActive). */}
            {linePoints.length > 1 && (
              <Line points={linePoints} color={SELECTED_MESH_COLOR} lineWidth={2} depthTest={false} renderOrder={SKETCH_OVERLAY_RENDER_ORDER} />
            )}
            {world.map((p, i) => {
              const handle: SketchHandle = { profile, point: i };
              const active = activeHandle !== null && activeHandle.profile === profile && activeHandle.point === i;
              return (
                <mesh
                  key={i}
                  position={p}
                  renderOrder={SKETCH_OVERLAY_RENDER_ORDER}
                  onPointerDown={(e: ThreeEvent<PointerEvent>) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    onHandleDown(handle);
                  }}
                  // No stopPropagation here, unlike the other handlers: r3f
                  // remembers a stopped pointerover and keeps stopping every later
                  // pointermove while the cursor stays over this handle — which
                  // starves the drawing plane behind it of exactly the moves that
                  // drive a drag (the handle follows the cursor, so the cursor is
                  // over it for most of the drag).
                  onPointerOver={() => onHandleHover(handle)}
                  onPointerOut={() => onHandleHover(null)}
                  // A plain click on a handle (press + release, no drag) must not
                  // fall through to the drawing plane behind it and add a point.
                  onClick={(e: ThreeEvent<MouseEvent>) => {
                    e.stopPropagation();
                    onHandleClick(handle);
                  }}
                  onDoubleClick={(e: ThreeEvent<MouseEvent>) => {
                    e.stopPropagation();
                    onHandleDelete(handle, e.nativeEvent.shiftKey);
                  }}
                >
                  {/* Circles and arcs put many points close together; their
                      handles are drawn smaller so the outline stays readable. */}
                  <sphereGeometry args={[active ? 1.1 : world.length > 12 ? 0.5 : 0.8, 12, 12]} />
                  <meshBasicMaterial color={active ? SKETCH_HANDLE_ACTIVE_COLOR : SELECTED_MESH_COLOR} depthTest={false} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </>
  );
}

interface DragSnapshot {
  position: Vector3;
  quaternion: [number, number, number, number];
  scale: Vector3;
}

export function Viewport({
  meshes,
  selectedIndices,
  onSelect,
  gizmoMode,
  rotateSpace,
  onTransformCommit,
  fitToken,
  focusRequest = null,
  activeSketchPlane,
  pickingFace,
  onPickFace,
  sketch,
  onSketchClick,
  sketchTool,
  toolAnchors,
  curveSegments,
  onHandleClick,
  onMoveSketchPoint,
  onSketchDragStart,
  onDeleteSketchPoint,
  editingNodeIndex,
  snapSettings,
  contextMeshes = [],
  onDrill,
  flashToken,
  overlay,
  editable = true,
  freeAxes,
  cuttersFirst = false,
  stale = false,
}: ViewportProps) {
  // M10a: the part under the pointer, for the hover tint.
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // A new set of meshes may not have the hovered one any more (and an index
  // can mean another part now); the next pointer move sets it again.
  useEffect(() => setHoveredIndex(null), [meshes]);
  // `!` ("show only this") — real OpenSCAD discards everything else from the
  // render entirely when any statement is marked. Nothing stops marking more
  // than one, so this shows the union of all of them rather than assuming a
  // single one.
  const hasRootModifier = useMemo(() => meshes.some((m) => m.modifier === '!'), [meshes]);
  const visibleMeshes = useMemo(
    () => (hasRootModifier ? meshes.filter((m) => m.modifier === '!') : meshes),
    [meshes, hasRootModifier],
  );
  // On-plane edges/vertices of what's currently visible, in the active
  // sketch plane's local (u, v) — recomputed only when the plane, the
  // rendered shapes or the geometry-snap toggle change, not per pointer
  // move. The sketch being edited is left out: it's the thing being moved,
  // so snapping a point to its own pre-edit outline would be a trap.
  const snapGeometry = useMemo(() => {
    if (!activeSketchPlane || !snapSettings.geometry) return EMPTY_PLANE_SNAP_GEOMETRY;
    return extractOnPlaneGeometry(
      [...visibleMeshes.filter((m) => m.index !== editingNodeIndex), ...contextMeshes].map((m) => ({
        geometry: geometryFor(m.bytes),
        transform: m.transform,
        frame: m.frame,
      })),
      activeSketchPlane,
    );
  }, [activeSketchPlane, snapSettings.geometry, visibleMeshes, contextMeshes, editingNodeIndex]);
  const [snapHover, setSnapHover] = useState<SnapResult | null>(null);
  // The gizmo only ever targets one object — the most recently selected one.
  const primaryIndex = selectedIndices.length > 0 ? selectedIndices[selectedIndices.length - 1] : null;
  const primaryMesh = meshes.find((m) => m.index === primaryIndex);
  const primaryAxes = primaryMesh ? gizmoAxes(primaryMesh.transform, primaryMesh.frame, gizmoMode, freeAxes) : null;
  const orbitControlsRef = useRef<OrbitControlsImpl>(null);
  const dragStart = useRef<DragSnapshot | null>(null);
  const groupsByIndex = useRef(new Map<number, Group>());
  // TransformControls' gizmo (rings/arrows) is a raw three.js object, not an
  // r3f-managed one with its own onClick — so releasing a drag on it still
  // makes r3f's raycast-driven `onPointerMissed` (fired from the native
  // 'click' event that follows 'mouseup') think nothing was hit, deselecting
  // the very node the drag just edited. Fix: flag a drag as "still settling"
  // until a macrotask after mouseUp — 'click' dispatches synchronously right
  // after 'mouseup' in the same task, before this clears, but is deferred
  // past it on the next one, so a real empty-space click still deselects.
  const isTransformingRef = useRef(false);
  // The gizmo's target lives outside <Bounds>/<Center> on purpose: Bounds
  // measures the combined bounding box of everything in its subtree to fit
  // the camera, and TransformControls' own internal helpers (notably a huge
  // invisible drag-plane used for raycasting) would get measured right along
  // with the real geometry — nesting it caused the camera to zoom out to fit
  // that plane instead of the actual shapes the first time this was wired up.
  const [transformTarget, setTransformTarget] = useState<Group | null>(null);
  const viewApiRef = useRef<ViewApi | null>(null);
  // View-only preference, not part of the document — lives here rather than
  // App.tsx since nothing outside the viewport reads it.
  const [shading, setShading] = useState<ShadingMode>('shaded');

  const handleGroupRef = useCallback(
    (index: number, group: Group | null) => {
      if (group) groupsByIndex.current.set(index, group);
      else groupsByIndex.current.delete(index);
      if (index === primaryIndex) setTransformTarget(group);
    },
    [primaryIndex],
  );

  useEffect(() => {
    setTransformTarget(primaryIndex !== null ? (groupsByIndex.current.get(primaryIndex) ?? null) : null);
  }, [primaryIndex]);

  // M7.5: lock rotation while actively sketching (pan/zoom still allowed) so
  // the plane view SketchController just animated to doesn't get orbited
  // away from immediately after — the whole point of a sketch-plane view is
  // that it stays straight-on while you work. Deliberately NOT locked during
  // pickingFace (slice 3) — you need to freely orbit to find the face you
  // want to click.
  useEffect(() => {
    const controls = orbitControlsRef.current;
    if (controls) controls.enableRotate = activeSketchPlane === null;
  }, [activeSketchPlane]);

  // M7.5 on-plane editing: handle drag state. The ref is what the move/up
  // handlers read (always current, no stale closure mid-drag); the state
  // copy only exists to re-render the highlight.
  const draggingHandleRef = useRef<SketchHandle | null>(null);
  const dragMovedRef = useRef(false);
  const suppressSketchClickRef = useRef(false);
  const [draggingHandle, setDraggingHandle] = useState<SketchHandle | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<SketchHandle | null>(null);

  const handleHandleDown = useCallback((handle: SketchHandle) => {
    draggingHandleRef.current = handle;
    dragMovedRef.current = false;
    setDraggingHandle(handle);
    // Pan/zoom stay off for the drag's duration so the view can't shift
    // under the point being placed.
    if (orbitControlsRef.current) orbitControlsRef.current.enabled = false;
  }, []);

  const handlePlanePointerMove = useCallback(
    (u: number, v: number) => {
      const handle = draggingHandleRef.current;
      if (handle === null) return;
      if (!dragMovedRef.current) {
        dragMovedRef.current = true;
        onSketchDragStart();
      }
      onMoveSketchPoint(handle, u, v);
    },
    [onMoveSketchPoint, onSketchDragStart],
  );

  // Released on window, not on the handle/plane: the cursor can be anywhere
  // (off the handle, outside the canvas) by the time the button comes up.
  useEffect(() => {
    const onPointerUp = () => {
      if (draggingHandleRef.current === null) return;
      draggingHandleRef.current = null;
      setDraggingHandle(null);
      if (orbitControlsRef.current) orbitControlsRef.current.enabled = true;
      if (dragMovedRef.current) {
        // Same deferred-flag trick as isTransformingRef above: the native
        // 'click' that follows this mouseup dispatches before the timeout
        // fires, so it sees the flag and is ignored.
        suppressSketchClickRef.current = true;
        setTimeout(() => {
          suppressSketchClickRef.current = false;
        }, 0);
      }
    };
    window.addEventListener('pointerup', onPointerUp);
    return () => window.removeEventListener('pointerup', onPointerUp);
  }, []);

  // Leaving sketch mode mid-hover would otherwise leave a stale highlight
  // index around for the next session.
  useEffect(() => {
    if (!activeSketchPlane) {
      setHoveredHandle(null);
      setSnapHover(null);
    }
  }, [activeSketchPlane]);

  // What the plane snaps against right now — see SketchDrawingPlane's
  // getSnapContext. Read through refs/latest props at call time, so it's
  // always current mid-drag.
  //
  // This session's closed loops snap like existing geometry (vertices,
  // midpoints, edges), so a second profile can share a corner or an edge
  // with the first. The open polyline's own points stay alignment-only, as
  // before: landing exactly on one would just add a self-touching vertex.
  const draggingProfile = draggingHandle?.profile ?? null;
  const combinedSnapGeometry = useMemo((): PlaneSnapGeometry => {
    if (!snapSettings.geometry) return EMPTY_PLANE_SNAP_GEOMETRY;
    const points = [...snapGeometry.points];
    const segments = [...snapGeometry.segments];
    sketch.profiles.forEach((loop, li) => {
      if (li === draggingProfile) return;
      loop.forEach((p, i) => {
        points.push(p);
        segments.push({ a: p, b: loop[(i + 1) % loop.length] });
      });
    });
    return { points, segments };
  }, [snapGeometry, sketch.profiles, draggingProfile, snapSettings.geometry]);
  const getSnapContext = useCallback(() => {
    const dragged = draggingHandleRef.current;
    if (dragged !== null) {
      // The dragged point's own loop (minus the point itself) still gives
      // alignment guides, so a rectangle corner can be dragged square.
      const own = dragged.profile === -1 ? sketch.open : (sketch.profiles[dragged.profile] ?? []);
      return { points: own.filter((_, i) => i !== dragged.point), geometry: combinedSnapGeometry, allowClose: false };
    }
    const lineLike = sketchTool === 'line' || (sketchTool === 'arc' && toolAnchors.length === 0);
    return {
      points: [...sketch.open, ...toolAnchors],
      geometry: combinedSnapGeometry,
      allowClose: lineLike && toolAnchors.length === 0,
    };
  }, [sketch, combinedSnapGeometry, sketchTool, toolAnchors]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        camera={{ position: DEFAULT_CAMERA_POSITION, up: DEFAULT_CAMERA_UP, fov: 45 }}
        onPointerMissed={() => {
          if (!isTransformingRef.current) onSelect(null, 'replace');
        }}
      >
        <ambientLight intensity={AMBIENT_LIGHT} />
        <HeadLight />
        {
          // Unconditional now (previously gated on visibleMeshes.length > 0):
          // that gate meant FitController/SketchController never mounted on an
          // empty scene, so "Reset View" and entering sketch mode silently did
          // nothing until at least one shape existed — a real bug for the
          // "start sketching on a blank file" case, found while testing M7.5
          // slice 1. Bounds' own refresh() already falls back gracefully on an
          // empty box (see its source), and <Center> with zero children is a
          // no-op, so there's no real reason for the gate to exist.
          //
          // No `fit`/`clip`/`observe` here: those re-fit/re-center the camera
          // on every geometry change, which was yanking the camera around on
          // routine edits (a gizmo drag, a parameter tweak) — not just on
          // load. FitController below is the sole trigger instead, firing only
          // when App.tsx's fitToken changes: a new file opened, or an explicit
          // "Reset View" click — never as a side effect of editing.
        }
        <Bounds margin={1.2}>
          <FitController fitToken={fitToken} orbitControlsRef={orbitControlsRef} />
          <SketchController activeSketchPlane={activeSketchPlane} viewApiRef={viewApiRef} />
          <ViewController apiRef={viewApiRef} />
          <FocusController request={focusRequest} meshes={visibleMeshes} groupsByIndex={groupsByIndex} viewApiRef={viewApiRef} />
          <Center>
            {contextMeshes.map((mesh) => (
              <ContextModel key={mesh.key ?? `ctx-${mesh.index}`} mesh={mesh} shading={shading} />
            ))}
            {visibleMeshes.map((mesh) => {
              const selPos = selectedIndices.indexOf(mesh.index);
              const role: SelectionRole = selPos === -1 ? 'none' : selPos === 0 ? 'base' : 'operand';
              return (
                <FrameGroup key={mesh.index} frame={mesh.frame}>
                  <NodeModel
                    mesh={mesh}
                    role={role}
                    onSelect={onSelect}
                    onGroupRef={handleGroupRef}
                    sketchActive={activeSketchPlane !== null}
                    pickingFace={pickingFace}
                    onPickFace={onPickFace}
                    shading={shading}
                    editing={mesh.index === editingNodeIndex}
                    onDrill={onDrill}
                    flashToken={role === 'none' ? undefined : flashToken}
                    cuttersFirst={cuttersFirst}
                    hovered={hoveredIndex === mesh.index && activeSketchPlane === null}
                    onHover={setHoveredIndex}
                    stale={stale}
                  />
                </FrameGroup>
              );
            })}
          </Center>
        </Bounds>
        {activeSketchPlane && (
          <SketchDrawingPlane
            activeSketchPlane={activeSketchPlane}
            onAddPoint={onSketchClick}
            onPointerMoveLocal={handlePlanePointerMove}
            suppressClickRef={suppressSketchClickRef}
            snapSettings={snapSettings}
            getSnapContext={getSnapContext}
            onHover={setSnapHover}
          />
        )}
        {activeSketchPlane && (
          <SketchSnapOverlay
            activeSketchPlane={activeSketchPlane}
            snapSettings={snapSettings}
            hover={snapHover}
            lastPoint={sketch.open.length > 0 ? sketch.open[sketch.open.length - 1] : null}
            drawing={draggingHandle === null && (sketchTool === 'line' || (sketchTool === 'arc' && toolAnchors.length === 0))}
            tool={sketchTool}
            anchors={toolAnchors}
            curveSegments={curveSegments}
          />
        )}
        {activeSketchPlane && (
          <SketchPointsPreview
            activeSketchPlane={activeSketchPlane}
            sketch={sketch}
            activeHandle={draggingHandle ?? hoveredHandle}
            onHandleDown={handleHandleDown}
            onHandleHover={setHoveredHandle}
            onHandleDelete={onDeleteSketchPoint}
            onHandleClick={(handle) => {
              // The click ending a handle drag isn't a click on the point.
              if (!suppressSketchClickRef.current) onHandleClick(handle);
            }}
          />
        )}
        {transformTarget && !activeSketchPlane && editable && primaryMesh?.transformEditable !== false && primaryAxes?.visible !== false && (
          <TransformControls
            object={transformTarget}
            mode={gizmoMode}
            // M11: axes written as expressions have no handles (gizmoLocks.ts).
            showX={primaryAxes?.show[0] ?? true}
            showY={primaryAxes?.show[1] ?? true}
            showZ={primaryAxes?.show[2] ?? true}
            // Translate stays world-space (moving "up" should mean world-up
            // even for a rotated object — the usual 3D-tool convention).
            // Scale stays local-only: OpenSCAD's scale() is always a plain
            // per-axis stretch in whatever frame it's placed in, and there's
            // no way to express "stretch along a world axis that doesn't line
            // up with the object's own axes" without a shear-capable
            // multmatrix() call, which isn't supported here — a "global scale"
            // toggle could only ever be honest for unrotated shapes. Rotate is
            // the one mode where both are meaningful and both round-trip
            // cleanly (see onMouseUp below — space only changes how a drag
            // *feels*, not how the result is read back), so it's user-toggled
            // via rotateSpace.
            space={gizmoMode === 'translate' ? 'world' : gizmoMode === 'rotate' ? rotateSpace : 'local'}
            onMouseDown={() => {
              isTransformingRef.current = true;
              if (orbitControlsRef.current) orbitControlsRef.current.enabled = false;
              dragStart.current = {
                position: transformTarget.position.clone(),
                quaternion: transformTarget.quaternion.toArray() as [number, number, number, number],
                scale: transformTarget.scale.clone(),
              };
            }}
            onMouseUp={() => {
              if (orbitControlsRef.current) orbitControlsRef.current.enabled = true;
              // Deferred a tick past the native 'click' that follows this
              // 'mouseup' — see isTransformingRef's declaration above.
              setTimeout(() => {
                isTransformingRef.current = false;
              }, 0);
              const start = dragStart.current;
              dragStart.current = null;
              if (!start || primaryIndex === null) return;

              const q = transformTarget.quaternion;
              const changed =
                !start.position.equals(transformTarget.position) ||
                !start.scale.equals(transformTarget.scale) ||
                start.quaternion[0] !== q.x ||
                start.quaternion[1] !== q.y ||
                start.quaternion[2] !== q.z ||
                start.quaternion[3] !== q.w;
              if (!changed) return;

              // The group's current absolute position/quaternion/scale *is*
              // the node's new transform — no delta/ratio/composition math
              // needed, since (unlike the pre-refactor baked-geometry model)
              // there's no separate "existing" value living in the source to
              // combine with; this object's transform is the single source of
              // truth for placement. color isn't part of the gizmo drag at
              // all, so it's carried forward unchanged from the node's last
              // known transform rather than dropped.
              // colorText too (M10a): without it a drag rewrote
              // color("goldenrod") as numbers (Jordan, 2026-11-27).
              const p = transformTarget.position;
              const s = transformTarget.scale;
              const last = meshes.find((m) => m.index === primaryIndex)?.transform;
              const transform: NodeTransform = {
                translate: [p.x, p.y, p.z],
                rotateDeg: quaternionToRotateDeg(q),
                color: last?.color ?? null,
                colorText: last?.colorText,
                scale: [s.x, s.y, s.z],
              };
              onTransformCommit(primaryIndex, transform);
            }}
          />
        )}
        <OrbitControls ref={orbitControlsRef} makeDefault />
        {/* gridHelper is built in three.js's XZ plane; rotated onto OpenSCAD's
            XY ground plane to match the Z-up camera. */}
        <gridHelper args={[200, 20]} rotation={[Math.PI / 2, 0, 0]} />
        {/* Clicks are ignored while sketching, same as orbit rotation (see the
            rotate-lock effect above): the plane view must stay straight-on. */}
        <NavCube onPick={(view) => viewApiRef.current?.orient(view)} disabled={activeSketchPlane !== null} />
      </Canvas>
      {activeSketchPlane === null &&
        VIEW_STEPS.map(({ step, glyph, title, dx, dy }) => (
          <button
            key={step}
            title={title}
            aria-label={title}
            onClick={() => viewApiRef.current?.step(step)}
            style={{ ...overlayButtonStyle, right: NAV_CUBE_MARGIN_PX - dx, top: NAV_CUBE_MARGIN_PX + dy, transform: 'translate(50%, -50%)' }}
          >
            {glyph}
          </button>
        ))}
      {overlay}
      <select
        aria-label="Shading mode"
        value={shading}
        onChange={(e) => setShading(e.target.value as ShadingMode)}
        style={{ position: 'absolute', right: 12, top: NAV_CUBE_MARGIN_PX * 2 + 8, fontSize: 12 }}
      >
        {SHADING_OPTIONS.map(({ mode, label }) => (
          <option key={mode} value={mode}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
