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

interface ViewportProps {
  meshes: NodeMesh[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  onTransformCommit: (index: number, delta: [number, number, number]) => void;
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
    <group ref={(g) => onGroupRef(mesh.index, g)} position={center}>
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

export function Viewport({ meshes, selectedIndex, onSelect, onTransformCommit }: ViewportProps) {
  const orbitControlsRef = useRef<OrbitControlsImpl>(null);
  const dragStart = useRef<Vector3 | null>(null);
  const groupsByIndex = useRef(new Map<number, Group>());
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
    <Canvas camera={{ position: [50, 50, 50], fov: 45 }} onPointerMissed={() => onSelect(null)}>
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
          mode="translate"
          onMouseDown={() => {
            if (orbitControlsRef.current) orbitControlsRef.current.enabled = false;
            dragStart.current = transformTarget.position.clone();
          }}
          onMouseUp={() => {
            if (orbitControlsRef.current) orbitControlsRef.current.enabled = true;
            const start = dragStart.current;
            dragStart.current = null;
            if (!start || selectedIndex === null) return;
            const end = transformTarget.position;
            const delta: [number, number, number] = [end.x - start.x, end.y - start.y, end.z - start.z];
            if (delta.some((d) => Math.abs(d) > 1e-6)) onTransformCommit(selectedIndex, delta);
          }}
        />
      )}
      <OrbitControls ref={orbitControlsRef} makeDefault />
      <gridHelper args={[200, 20]} />
    </Canvas>
  );
}
