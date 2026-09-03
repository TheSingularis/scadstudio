import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Bounds, Center } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import * as THREE from 'three';

interface ViewportProps {
  stlBytes: Uint8Array | null;
}

function Model({ stlBytes }: { stlBytes: Uint8Array }): JSX.Element {
  const geometry = useMemo(() => {
    const loader = new STLLoader();
    const geom = loader.parse(stlBytes.buffer as ArrayBuffer);
    geom.computeVertexNormals();
    return geom;
  }, [stlBytes]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#4a90d9" />
    </mesh>
  );
}

export function Viewport({ stlBytes }: ViewportProps): JSX.Element {
  return (
    <Canvas camera={{ position: [50, 50, 50], fov: 45 }}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 20, 10]} intensity={0.8} />
      {stlBytes && (
        <Bounds fit clip observe margin={1.2}>
          <Center>
            <Model stlBytes={stlBytes} />
          </Center>
        </Bounds>
      )}
      <OrbitControls makeDefault />
      <gridHelper args={[200, 20]} />
    </Canvas>
  );
}
