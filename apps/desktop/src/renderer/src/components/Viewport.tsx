import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Bounds, Center, TransformControls } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { ThreeEvent } from '@react-three/fiber';
import { Vector3, type Group } from 'three';

// Derived from drei's own component rather than three's OrbitControls
// directly — drei pins a slightly different three.js generic signature and
// the two named types don't structurally match.
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

export interface NodeMesh {
  index: number;
  bytes: Uint8Array;
}

export type GizmoMode = 'translate' | 'rotate' | 'scale';

interface ViewportProps {
  meshes: NodeMesh[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  gizmoMode: GizmoMode;
  onTransformCommit: (index: number, mode: GizmoMode, value: [number, number, number]) => void;
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
  // wrap the mesh in a pivot group centered on its own bounding box, offset
  // the mesh by -center inside it, and attach the gizmo to the *group*. The
  // mesh is a child, so dragging the group's transform drags the visible
  // shape along with it for free, via ordinary scene-graph parenting.
  const { geometry, center } = useMemo(() => {
    const geom = new STLLoader().parse(mesh.bytes.buffer as ArrayBuffer);
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    const c = new Vector3();
    geom.boundingBox?.getCenter(c);
    return { geometry: geom, center: c };
  }, [mesh.bytes]);

  return (
    // rotation/scale are set explicitly (not left to default) so that a fresh
    // render — which already bakes any committed rotate/scale into the STL
    // vertices themselves — forces the pivot back to identity every time,
    // clearing whatever the previous drag left on this same Object3D. Without
    // this, a committed rotate/scale would apply twice: once baked into the
    // new geometry, once left over from the gizmo's last imperative mutation.
    <group ref={(g) => onGroupRef(mesh.index, g)} position={center} rotation={[0, 0, 0]} scale={[1, 1, 1]}>
      <mesh
        position={[-center.x, -center.y, -center.z]}
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

const RAD_TO_DEG = 180 / Math.PI;

// What each gizmo mode reads off the target Object3D — translate/rotate read
// additively (end - start), scale reads as a ratio (end / start, since scale
// always starts at the group's reset identity of 1 — see NodeModel's
// rotation/scale reset comment).
function readModeVector(target: Group, mode: GizmoMode): [number, number, number] {
  if (mode === 'rotate') return [target.rotation.x, target.rotation.y, target.rotation.z];
  if (mode === 'scale') return [target.scale.x, target.scale.y, target.scale.z];
  return [target.position.x, target.position.y, target.position.z];
}

export function Viewport({ meshes, selectedIndex, onSelect, gizmoMode, onTransformCommit }: ViewportProps) {
  const orbitControlsRef = useRef<OrbitControlsImpl>(null);
  const dragStart = useRef<[number, number, number] | null>(null);
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
            dragStart.current = readModeVector(transformTarget, gizmoMode);
          }}
          onMouseUp={() => {
            if (orbitControlsRef.current) orbitControlsRef.current.enabled = true;
            const start = dragStart.current;
            dragStart.current = null;
            // Deferred a tick past the native 'click' that follows this
            // 'mouseup' — see isTransformingRef's declaration above.
            setTimeout(() => {
              isTransformingRef.current = false;
            }, 0);
            if (!start || selectedIndex === null) return;
            const end = readModeVector(transformTarget, gizmoMode);
            const value: [number, number, number] =
              gizmoMode === 'scale'
                ? [end[0] / start[0], end[1] / start[1], end[2] / start[2]]
                : gizmoMode === 'rotate'
                  ? [(end[0] - start[0]) * RAD_TO_DEG, (end[1] - start[1]) * RAD_TO_DEG, (end[2] - start[2]) * RAD_TO_DEG]
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
