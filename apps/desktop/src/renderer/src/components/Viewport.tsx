import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Bounds, Center } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { ThreeEvent } from '@react-three/fiber';

export interface NodeMesh {
  index: number;
  bytes: Uint8Array;
}

interface ViewportProps {
  meshes: NodeMesh[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}

function NodeModel({
  mesh,
  selected,
  onSelect,
}: {
  mesh: NodeMesh;
  selected: boolean;
  onSelect: (index: number) => void;
}) {
  const geometry = useMemo(() => {
    const geom = new STLLoader().parse(mesh.bytes.buffer as ArrayBuffer);
    geom.computeVertexNormals();
    return geom;
  }, [mesh.bytes]);

  return (
    <mesh
      geometry={geometry}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onSelect(mesh.index);
      }}
    >
      <meshStandardMaterial color={selected ? '#e8a33d' : '#4a90d9'} />
    </mesh>
  );
}

export function Viewport({ meshes, selectedIndex, onSelect }: ViewportProps) {
  return (
    <Canvas camera={{ position: [50, 50, 50], fov: 45 }} onPointerMissed={() => onSelect(null)}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 20, 10]} intensity={0.8} />
      {meshes.length > 0 && (
        <Bounds fit clip observe margin={1.2}>
          <Center>
            {meshes.map((mesh) => (
              <NodeModel key={mesh.index} mesh={mesh} selected={mesh.index === selectedIndex} onSelect={onSelect} />
            ))}
          </Center>
        </Bounds>
      )}
      <OrbitControls makeDefault />
      <gridHelper args={[200, 20]} />
    </Canvas>
  );
}
