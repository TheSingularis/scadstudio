import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Bounds, Center, TransformControls } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { ThreeEvent } from '@react-three/fiber';
import { Color, Vector3, type Group } from 'three';

const DEFAULT_MESH_COLOR = '#4a90d9';
const SELECTED_MESH_COLOR = '#e8a33d';
import { transformToQuaternion, quaternionToRotateDeg, type NodeTransform } from '../targetedPatch';

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
}

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type RotateSpace = 'local' | 'world';

interface ViewportProps {
  meshes: NodeMesh[];
  // Ordered by selection sequence (oldest first), not document order — M6's
  // boolean toolbar needs click order to know which shape is "the base" vs
  // "the tool" for difference(), where argument order is semantically load-
  // bearing. The last entry is the "primary" selection: the one the gizmo
  // attaches to and the one mirror/color/parameter-panel edit, since those
  // are inherently single-target operations.
  selectedIndices: number[];
  onSelect: (index: number | null, additive: boolean) => void;
  gizmoMode: GizmoMode;
  rotateSpace: RotateSpace;
  onTransformCommit: (index: number, transform: NodeTransform) => void;
}

function NodeModel({
  mesh,
  selected,
  onSelect,
  onGroupRef,
}: {
  mesh: NodeMesh;
  selected: boolean;
  onSelect: (index: number, additive: boolean) => void;
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
  const materialColor = useMemo(
    () => (selected ? SELECTED_MESH_COLOR : mesh.transform.color ? new Color(...mesh.transform.color) : DEFAULT_MESH_COLOR),
    [selected, mesh.transform.color],
  );

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
          onSelect(mesh.index, e.shiftKey);
        }}
      >
        <meshStandardMaterial color={materialColor} side={2} />
      </mesh>
    </group>
  );
}

interface DragSnapshot {
  position: Vector3;
  quaternion: [number, number, number, number];
  scale: Vector3;
}

export function Viewport({ meshes, selectedIndices, onSelect, gizmoMode, rotateSpace, onTransformCommit }: ViewportProps) {
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

  return (
    <Canvas
      camera={{ position: [50, 50, 50], fov: 45 }}
      onPointerMissed={() => {
        if (!isTransformingRef.current) onSelect(null, false);
      }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 20, 10]} intensity={0.8} />
      {meshes.length > 0 && (
        <Bounds fit clip observe margin={1.2}>
          <Center>
            {meshes.map((mesh) => (
              <NodeModel
                key={mesh.index}
                mesh={mesh}
                selected={selectedIndices.includes(mesh.index)}
                onSelect={onSelect}
                onGroupRef={handleGroupRef}
              />
            ))}
          </Center>
        </Bounds>
      )}
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
