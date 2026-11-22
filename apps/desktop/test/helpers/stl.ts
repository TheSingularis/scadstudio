import { Box3, Matrix4, Vector3, type BufferGeometry } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { transformToQuaternion, type NodeTransform } from '../../src/renderer/src/targetedPatch';

export function parseStl(bytes: Uint8Array | string): BufferGeometry {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const copy = data.slice().buffer as ArrayBuffer;
  return new STLLoader().parse(copy);
}

export function triangleCount(geometry: BufferGeometry): number {
  return geometry.getAttribute('position').count / 3;
}

/** Apply a node transform exactly as Viewport.tsx's pivot group does (T·R·S). */
export function applyNodeTransform(geometry: BufferGeometry, t: NodeTransform): BufferGeometry {
  const m = new Matrix4().compose(new Vector3(...t.translate), transformToQuaternion(t.rotateDeg), new Vector3(...t.scale));
  return geometry.clone().applyMatrix4(m);
}

export function bbox(geometry: BufferGeometry): { min: number[]; max: number[] } {
  const box = new Box3().setFromBufferAttribute(geometry.getAttribute('position') as never);
  return { min: box.min.toArray(), max: box.max.toArray() };
}
