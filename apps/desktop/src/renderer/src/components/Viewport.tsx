import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Bounds, Center, TransformControls, useBounds } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { ThreeEvent } from '@react-three/fiber';
import { Color, Vector3, type Group } from 'three';

const DEFAULT_MESH_COLOR = '#4a90d9';
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
// `%` (background/ghost) opacity — real OpenSCAD renders these translucent
// and excludes them from the final CSG output; this app only ever renders
// top-level statements independently (no single merged CSG output to
// exclude from), so the translucency is the whole of what's reproduced here.
const GHOST_OPACITY = 0.35;
import { transformToQuaternion, quaternionToRotateDeg, type NodeTransform, type Modifier } from '../targetedPatch';

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
  // (see the <Bounds key={fitToken}> below) — deliberately *not* derived from
  // `meshes` itself, so routine edits (dragging a gizmo, tweaking a
  // parameter) don't yank the camera around. App.tsx changes it only when a
  // genuinely new file is opened or the user explicitly clicks "Reset View".
  fitToken: string;
  // M7.5 slice 1: null outside sketch mode (free orbit, as today). Non-null
  // drives the camera to that plane's canonical view (SketchController) and
  // locks orbit rotation (pan/zoom still work) for the duration — see PLAN.md
  // "Sketch mode (M7.5)".
  sketchPlane: SketchPlane | null;
}

type SelectionRole = 'none' | 'base' | 'operand';

function NodeModel({
  mesh,
  role,
  onSelect,
  onGroupRef,
}: {
  mesh: NodeMesh;
  role: SelectionRole;
  onSelect: (index: number, mode: SelectMode) => void;
  onGroupRef: (index: number, group: Group | null) => void;
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
  const geometry = useMemo(() => {
    const geom = new STLLoader().parse(mesh.bytes.buffer as ArrayBuffer);
    geom.computeVertexNormals();
    return geom;
  }, [mesh.bytes]);

  const quaternion = useMemo(() => transformToQuaternion(mesh.transform.rotateDeg), [mesh.transform.rotateDeg]);
  // OpenSCAD's color() takes 0-1 floats, which is exactly what three.js's
  // Color(r, g, b) constructor expects — no conversion needed.
  const materialColor = useMemo(() => {
    if (role === 'base') return SELECTED_MESH_COLOR;
    if (role === 'operand') return OPERAND_MESH_COLOR;
    if (mesh.modifier === '#') return HIGHLIGHT_MESH_COLOR;
    return mesh.transform.color ? new Color(...mesh.transform.color) : DEFAULT_MESH_COLOR;
  }, [role, mesh.modifier, mesh.transform.color]);
  // `%` stays translucent regardless of selection/highlight — it's a
  // persistent "ghost reference" state, not something selecting the node
  // should visually override.
  const isGhost = mesh.modifier === '%';

  return (
    <group
      ref={(g) => onGroupRef(mesh.index, g)}
      position={mesh.transform.translate}
      quaternion={[quaternion.x, quaternion.y, quaternion.z, quaternion.w]}
      scale={mesh.transform.scale}
    >
      <mesh
        geometry={geometry}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          // metaKey covers Cmd on macOS, where ctrl-click is reserved for
          // the OS's own right-click emulation.
          onSelect(mesh.index, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
        }}
      >
        <meshStandardMaterial color={materialColor} side={2} transparent={isGhost} opacity={isGhost ? GHOST_OPACITY : 1} />
      </mesh>
    </group>
  );
}

// Matches <Canvas camera={{ position: DEFAULT_CAMERA_POSITION, ... }}> below —
// the one true "default angle" every fit should return to.
const DEFAULT_CAMERA_POSITION: [number, number, number] = [50, 50, 50];

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
    camera.position.set(...DEFAULT_CAMERA_POSITION);
    const controls = orbitControlsRef.current;
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
    bounds.refresh().fit().clip();
    // fitToken is the only intentional trigger — see its own doc comment on
    // ViewportProps for why this must NOT depend on meshes/content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken]);
  return null;
}

// M7.5 slice 1: global sketch planes only (no face-picking yet — see PLAN.md
// "Sketch mode (M7.5)"). Tuples are used directly as three.js vectors, same
// as translate/rotate everywhere else in this app (see App.tsx/targetedPatch
// — there's no OpenSCAD-Z-up-to-three.js-Y-up remap anywhere), so "XY plane"
// here means the plane where the third (Z) component is 0, matching real
// OpenSCAD's own XY/XZ/YZ naming, not three.js's default Y-up framing.
export type SketchPlane = 'XY' | 'XZ' | 'YZ';
const SKETCH_PLANE_VIEWS: Record<SketchPlane, { position: [number, number, number]; up: [number, number, number] }> = {
  XY: { position: [0, 0, 60], up: [0, 1, 0] },
  XZ: { position: [0, -60, 0], up: [0, 0, 1] },
  YZ: { position: [60, 0, 0], up: [0, 0, 1] },
};

// Sibling to FitController, same "lives inside <Bounds> for useBounds, fires
// on prop change only" shape — but calls the lower-level moveTo/lookAt
// directly instead of fit()/reset(), since a sketch plane view is a fixed
// given orientation, not something derived from current content/camera
// state. This is the "animate camera to a target orientation" primitive the
// nav-cube (PLAN.md M7.5 point 5) will want too — reuse this rather than
// building a second animation path when the nav-cube is built.
function SketchController({ sketchPlane }: { sketchPlane: SketchPlane | null }) {
  const bounds = useBounds();
  useEffect(() => {
    if (!sketchPlane) return;
    const { position, up } = SKETCH_PLANE_VIEWS[sketchPlane];
    bounds.refresh().moveTo(position).lookAt({ target: [0, 0, 0], up });
  }, [sketchPlane, bounds]);
  return null;
}

interface DragSnapshot {
  position: Vector3;
  quaternion: [number, number, number, number];
  scale: Vector3;
}

export function Viewport({ meshes, selectedIndices, onSelect, gizmoMode, rotateSpace, onTransformCommit, fitToken, sketchPlane }: ViewportProps) {
  // `!` ("show only this") — real OpenSCAD discards everything else from the
  // render entirely when any statement is marked. Nothing stops marking more
  // than one, so this shows the union of all of them rather than assuming a
  // single one.
  const hasRootModifier = useMemo(() => meshes.some((m) => m.modifier === '!'), [meshes]);
  const visibleMeshes = useMemo(
    () => (hasRootModifier ? meshes.filter((m) => m.modifier === '!') : meshes),
    [meshes, hasRootModifier],
  );
  // The gizmo only ever targets one object — the most recently selected one.
  const primaryIndex = selectedIndices.length > 0 ? selectedIndices[selectedIndices.length - 1] : null;
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

  // M7.5 slice 1: lock rotation while sketching (pan/zoom still allowed) so
  // the plane view SketchController just animated to doesn't get orbited
  // away from immediately after — the whole point of a sketch-plane view is
  // that it stays straight-on while you work.
  useEffect(() => {
    const controls = orbitControlsRef.current;
    if (controls) controls.enableRotate = sketchPlane === null;
  }, [sketchPlane]);

  return (
    <Canvas
      camera={{ position: DEFAULT_CAMERA_POSITION, fov: 45 }}
      onPointerMissed={() => {
        if (!isTransformingRef.current) onSelect(null, 'replace');
      }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 20, 10]} intensity={0.8} />
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
        <SketchController sketchPlane={sketchPlane} />
        <Center>
          {visibleMeshes.map((mesh) => {
            const selPos = selectedIndices.indexOf(mesh.index);
            const role: SelectionRole = selPos === -1 ? 'none' : selPos === 0 ? 'base' : 'operand';
            return <NodeModel key={mesh.index} mesh={mesh} role={role} onSelect={onSelect} onGroupRef={handleGroupRef} />;
          })}
        </Center>
      </Bounds>
      {transformTarget && (
        <TransformControls
          object={transformTarget}
          mode={gizmoMode}
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
            const p = transformTarget.position;
            const s = transformTarget.scale;
            const transform: NodeTransform = {
              translate: [p.x, p.y, p.z],
              rotateDeg: quaternionToRotateDeg(q),
              color: meshes.find((m) => m.index === primaryIndex)?.transform.color ?? null,
              scale: [s.x, s.y, s.z],
            };
            onTransformCommit(primaryIndex, transform);
          }}
        />
      )}
      <OrbitControls ref={orbitControlsRef} makeDefault />
      <gridHelper args={[200, 20]} />
    </Canvas>
  );
}
