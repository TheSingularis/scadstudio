import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Bounds, Center, TransformControls } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { ThreeEvent } from '@react-three/fiber';
import { Quaternion, Vector3, type Group } from 'three';

// Derived from drei's own component rather than three's OrbitControls
// directly — drei pins a slightly different three.js generic signature and
// the two named types don't structurally match.
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

export interface NodeMesh {
  index: number;
  bytes: Uint8Array;
  // World-space point OpenSCAD would rotate/scale this node around (an
  // enclosing translate's xyz, or the origin) — see targetedPatch.ts's
  // getPivotOrigin. Deliberately *not* the mesh's own bounding-box center:
  // an off-center primitive (e.g. a default, non-`center=true` cylinder)
  // would otherwise visibly displace on every rotate/scale commit, since
  // three.js would be pivoting around a different point than OpenSCAD does.
  pivot: [number, number, number];
}

export type GizmoMode = 'translate' | 'rotate' | 'scale';

// translate/scale commit as a plain 3-vector (delta / ratio); rotate commits
// as a quaternion (x,y,z,w) — see targetedPatch.ts's patchRotate for why a
// raw Euler delta isn't enough to compose multi-axis rotations correctly.
export type GizmoCommitValue = [number, number, number] | [number, number, number, number];

interface ViewportProps {
  meshes: NodeMesh[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  gizmoMode: GizmoMode;
  onTransformCommit: (index: number, mode: GizmoMode, value: GizmoCommitValue) => void;
}

function NodeModel({
  mesh,
  selected,
  onSelect,
  onGroupRef,
}: {
  mesh: NodeMesh;
  selected: boolean;
  onSelect: (index: number) => void;
  onGroupRef: (index: number, group: Group | null) => void;
}) {
  // openscad-wasm bakes every node's absolute position into its STL vertices
  // (there's no separate "transform" the mesh Object3D could hold) — so the
  // mesh's own origin sits wherever OpenSCAD's coordinate origin happened to
  // be, not on the shape itself. A gizmo attached directly to the mesh would
  // render there instead of on the shape (see PLAN.md M4 build notes). Fix:
  // wrap the mesh in a pivot group positioned at the node's true OpenSCAD
  // pivot (see NodeMesh.pivot), offset the mesh by -pivot inside it, and
  // attach the gizmo to the *group*. The mesh is a child, so dragging the
  // group's transform drags the visible shape along with it for free, via
  // ordinary scene-graph parenting.
  const geometry = useMemo(() => {
    const geom = new STLLoader().parse(mesh.bytes.buffer as ArrayBuffer);
    geom.computeVertexNormals();
    return geom;
  }, [mesh.bytes]);

  const pivot = useMemo(() => new Vector3(...mesh.pivot), [mesh.pivot]);

  const groupRef = useRef<Group>(null);
  // A fresh render already bakes any committed rotate/scale into the new STL
  // vertices, so the pivot's own rotation/scale must go back to identity —
  // otherwise a committed value would apply twice: once baked into the
  // geometry, once left over from the gizmo's last imperative mutation. A
  // declarative `rotation={[0,0,0]} scale={[1,1,1]}` prop does *not* achieve
  // this: react-three-fiber diffs against the last value *it* applied, and
  // since that literal never changes across renders, it silently skips
  // reapplying it even though TransformControls mutated the live object in
  // between — confirmed by a live drag's `dragStart` reading the previous
  // drag's leftover value instead of identity. Position doesn't have this
  // problem because `pivot` is a genuinely new value on every geometry
  // change. Resetting imperatively on the ref, bypassing prop-diffing
  // entirely, is what actually works.
  useLayoutEffect(() => {
    groupRef.current?.rotation.set(0, 0, 0);
    groupRef.current?.scale.set(1, 1, 1);
  }, [geometry]);

  return (
    <group
      ref={(g) => {
        groupRef.current = g;
        onGroupRef(mesh.index, g);
      }}
      position={pivot}
    >
      <mesh
        position={[-pivot.x, -pivot.y, -pivot.z]}
        geometry={geometry}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect(mesh.index);
        }}
      >
        <meshStandardMaterial color={selected ? '#e8a33d' : '#4a90d9'} />
      </mesh>
    </group>
  );
}

export function Viewport({ meshes, selectedIndex, onSelect, gizmoMode, onTransformCommit }: ViewportProps) {
  const orbitControlsRef = useRef<OrbitControlsImpl>(null);
  // Translate/scale drag baseline (position or scale, mode-dependent).
  const dragStartVector = useRef<[number, number, number] | null>(null);
  // Rotate drag baseline, kept as a quaternion rather than Euler — see
  // targetedPatch.ts's patchRotate for why raw Euler deltas can't be summed
  // correctly across multi-axis drags.
  const dragStartQuat = useRef<Quaternion | null>(null);
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
      if (index === selectedIndex) setTransformTarget(group);
    },
    [selectedIndex],
  );

  useEffect(() => {
    setTransformTarget(selectedIndex !== null ? (groupsByIndex.current.get(selectedIndex) ?? null) : null);
  }, [selectedIndex]);

  return (
    <Canvas
      camera={{ position: [50, 50, 50], fov: 45 }}
      onPointerMissed={() => {
        if (!isTransformingRef.current) onSelect(null);
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
                selected={mesh.index === selectedIndex}
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
          onMouseDown={() => {
            isTransformingRef.current = true;
            if (orbitControlsRef.current) orbitControlsRef.current.enabled = false;
            if (gizmoMode === 'rotate') {
              dragStartQuat.current = transformTarget.quaternion.clone();
            } else if (gizmoMode === 'scale') {
              dragStartVector.current = transformTarget.scale.toArray();
            } else {
              dragStartVector.current = transformTarget.position.toArray();
            }
          }}
          onMouseUp={() => {
            if (orbitControlsRef.current) orbitControlsRef.current.enabled = true;
            // Deferred a tick past the native 'click' that follows this
            // 'mouseup' — see isTransformingRef's declaration above.
            setTimeout(() => {
              isTransformingRef.current = false;
            }, 0);
            if (selectedIndex === null) return;

            if (gizmoMode === 'rotate') {
              const start = dragStartQuat.current;
              dragStartQuat.current = null;
              if (!start) return;
              // Delta = end * start⁻¹ — the rotation applied *during* this
              // drag, independent of whatever the group's baseline was.
              const delta = transformTarget.quaternion.clone().multiply(start.clone().invert());
              if (Math.abs(delta.w) < 1 - 1e-6) onTransformCommit(selectedIndex, 'rotate', delta.toArray() as GizmoCommitValue);
              return;
            }

            const start = dragStartVector.current;
            dragStartVector.current = null;
            if (!start) return;
            const end =
              gizmoMode === 'scale' ? transformTarget.scale.toArray() : transformTarget.position.toArray();
            const value: [number, number, number] =
              gizmoMode === 'scale'
                ? [end[0] / start[0], end[1] / start[1], end[2] / start[2]]
                : [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
            const changed =
              gizmoMode === 'scale' ? value.some((v) => Math.abs(v - 1) > 1e-6) : value.some((v) => Math.abs(v) > 1e-6);
            if (changed) onTransformCommit(selectedIndex, gizmoMode, value);
          }}
        />
      )}
      <OrbitControls ref={orbitControlsRef} makeDefault />
      <gridHelper args={[200, 20]} />
    </Canvas>
  );
}
