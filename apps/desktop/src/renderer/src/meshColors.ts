// M10a: per-face colors from a render, as a vertex-color attribute.
//
// The render process exports OFF (which keeps every face's color) and sends
// binary STL with a color trailer: after the triangles, "RGBA" and four bytes
// per triangle. The writer is src/main/offMesh.ts; keep the two in step.
//
// Faces nothing colored come out of the engine in OpenSCAD's own default
// (249, 215, 44); those take the app's default color, so an uncolored part
// looks the way it always has.
//
// The node's own outer color() is not part of the render (the app strips
// that wrap and applies it itself, so the color picker can edit it). In
// OpenSCAD an outer color() wins over every color() inside it (engine-checked
// 2026-11-26: `color("red") { color("blue") cube(5); }` exports all red), so
// when a node has one, the viewport uses it for the whole mesh and ignores
// these face colors.

import { BufferAttribute } from 'three';

export const ENGINE_DEFAULT_RGB: readonly [number, number, number] = [249, 215, 44];
const MAGIC = [0x52, 0x47, 0x42, 0x41]; // "RGBA"

// The trailer's four bytes per triangle, or null when the bytes are plain
// binary STL (no trailer, or a size that doesn't fit one).
export function readFaceColors(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 84) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(80, true);
  const stlSize = 84 + n * 50;
  if (bytes.byteLength !== stlSize + 4 + n * 4) return null;
  for (let k = 0; k < 4; k++) if (bytes[stlSize + k] !== MAGIC[k]) return null;
  return bytes.subarray(stlSize + 4, stlSize + 4 + n * 4);
}

export interface FaceColorSummary {
  // Every face has the engine's default color (nothing in the node is colored).
  allDefault: boolean;
  // Some face has its own alpha below 1.
  translucent: boolean;
}

export function summarizeFaceColors(faces: Uint8Array): FaceColorSummary {
  let allDefault = true;
  let translucent = false;
  for (let i = 0; i < faces.length; i += 4) {
    if (faces[i + 3] < 255) translucent = true;
    if (allDefault && !isEngineDefault(faces, i)) allDefault = false;
    if (translucent && !allDefault) break;
  }
  return { allDefault, translucent };
}

function isEngineDefault(faces: Uint8Array, i: number): boolean {
  return faces[i] === ENGINE_DEFAULT_RGB[0] && faces[i + 1] === ENGINE_DEFAULT_RGB[1] && faces[i + 2] === ENGINE_DEFAULT_RGB[2] && faces[i + 3] === 255;
}

// sRGB byte -> linear 0-65535. three.js treats vertex colors as linear
// (material colors given as hex/CSS are converted for you, attributes are
// not), so the engine's sRGB bytes are converted here; without it every
// color looks washed out. 16 bits so dark colors don't band.
const SRGB_TO_LINEAR16 = (() => {
  const lut = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const linear = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    lut[i] = Math.round(linear * 65535);
  }
  return lut;
})();

// A non-indexed (three vertices per triangle, as STLLoader builds it) color
// attribute: linear RGB plus alpha as normalized 16-bit values, so the GPU
// sees 0-1. `fallback` is the sRGB color, 0-255, for faces nothing colored.
export function vertexColorAttribute(faces: Uint8Array, fallback: readonly [number, number, number]): BufferAttribute {
  const [fr, fg, fb] = fallback;
  const triangles = faces.length / 4;
  const out = new Uint16Array(triangles * 12);
  for (let t = 0; t < triangles; t++) {
    const i = t * 4;
    let r = faces[i];
    let g = faces[i + 1];
    let b = faces[i + 2];
    let a = faces[i + 3];
    if (isEngineDefault(faces, i)) {
      r = fr;
      g = fg;
      b = fb;
      a = 255;
    }
    const o = t * 12;
    for (let v = 0; v < 12; v += 4) {
      out[o + v] = SRGB_TO_LINEAR16[r];
      out[o + v + 1] = SRGB_TO_LINEAR16[g];
      out[o + v + 2] = SRGB_TO_LINEAR16[b];
      out[o + v + 3] = a * 257;
    }
  }
  return new BufferAttribute(out, 4, true);
}
