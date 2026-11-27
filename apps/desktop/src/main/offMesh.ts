// M10a: the engine's OFF export, turned into the bytes the viewport reads.
//
// Renders used to export binary STL, which has no color, so every model came
// out in the app's default blue however its source colored it (Jordan, gag
// trophy, 2026-11-26). OpenSCAD's OFF export writes a color on every face
// (checked against @lofcz/openscad-wasm 0.0.2: `k i0 .. ik r g b` with 0-255
// values, plus a fourth alpha value when the face isn't opaque; faces with no
// color() take OpenSCAD's own default, 249 215 44). Colors survive modules and
// booleans, the same way OpenSCAD's own render shows them.
//
// The output is a binary STL (so every existing reader, three's STLLoader
// included, keeps working on it unchanged) followed by a color trailer:
//
//   [80-byte header][uint32 n][n x 50-byte triangle]["RGBA"][n x 4 bytes r,g,b,a]
//
// STLLoader reads the triangle count from the header and ignores anything
// after the triangles, as long as the header doesn't start with "solid" or
// contain "COLOR=" (which would switch it to ASCII or Materialise colors).
// The renderer side is src/renderer/src/meshColors.ts; keep the two in step
// (test/unit/meshColors.test.ts writes with this file and reads with that one).

export const MESH_HEADER = 'ScadStudio mesh with per-face RGBA trailer';
export const COLOR_TRAILER_MAGIC = 'RGBA';

export class OffParseError extends Error {
  constructor(message: string) {
    super(`Could not read the engine's mesh output: ${message}`);
    this.name = 'OffParseError';
  }
}

function isSpace(c: number): boolean {
  return c === 32 || c === 10 || c === 13 || c === 9;
}

// Parses an OFF file and writes the STL-plus-colors bytes described above.
// Faces with more than three corners are fanned into triangles (OpenSCAD's
// Manifold output is already triangles, but the format allows polygons).
export function offToColoredStl(off: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(off);
  const len = text.length;
  let i = 0;

  // Moves to the next token. A `#` starts a comment to the end of the line.
  const skip = () => {
    while (i < len) {
      const c = text.charCodeAt(i);
      if (isSpace(c)) {
        i++;
      } else if (c === 35) {
        while (i < len && text.charCodeAt(i) !== 10) i++;
      } else {
        break;
      }
    }
  };
  const token = (): string => {
    skip();
    const start = i;
    while (i < len && !isSpace(text.charCodeAt(i))) i++;
    if (start === i) throw new OffParseError('unexpected end of file');
    return text.slice(start, i);
  };
  const int = (): number => {
    skip();
    let n = 0;
    const start = i;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c < 48 || c > 57) break;
      n = n * 10 + (c - 48);
      i++;
    }
    if (start === i) throw new OffParseError(`expected a whole number at offset ${i}`);
    return n;
  };
  const float = (): number => {
    const t = token();
    const v = Number(t);
    if (!Number.isFinite(v)) throw new OffParseError(`bad number "${t.slice(0, 20)}"`);
    return v;
  };
  // Whether the rest of the current line holds another value.
  const moreOnLine = (): boolean => {
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 10) return false;
      if (!isSpace(c)) return true;
      i++;
    }
    return false;
  };

  const magic = token();
  if (magic !== 'OFF' && magic !== 'COFF') throw new OffParseError(`not an OFF file (starts with "${magic.slice(0, 10)}")`);
  const vertexCount = int();
  const faceCount = int();
  int(); // edge count, unused

  const vertices = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount * 3; v++) vertices[v] = float();

  // First pass over faces into compact arrays: triangle corners and colors.
  let tris = new Uint32Array(Math.max(faceCount, 1) * 3);
  let colors = new Uint8Array(Math.max(faceCount, 1) * 4);
  let triCount = 0;
  const corners: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const k = int();
    corners.length = 0;
    for (let c = 0; c < k; c++) {
      const idx = int();
      if (idx >= vertexCount) throw new OffParseError(`face ${f} names vertex ${idx} of ${vertexCount}`);
      corners.push(idx);
    }
    // Optional color: r g b [a], as 0-255 integers or 0-1 floats.
    const rgba: number[] = [];
    while (moreOnLine()) rgba.push(float());
    let r = 249;
    let g = 215;
    let b = 44;
    let a = 255;
    if (rgba.length >= 3) {
      const isFloat = rgba.every((x) => x <= 1) && rgba.some((x) => x > 0 && x < 1);
      const to255 = (x: number) => Math.max(0, Math.min(255, Math.round(isFloat ? x * 255 : x)));
      r = to255(rgba[0]);
      g = to255(rgba[1]);
      b = to255(rgba[2]);
      if (rgba.length >= 4) a = to255(rgba[3]);
    }
    for (let c = 1; c + 1 < k; c++) {
      if (triCount * 3 + 3 > tris.length) {
        const grownTris = new Uint32Array(tris.length * 2);
        grownTris.set(tris);
        tris = grownTris;
        const grownColors = new Uint8Array(colors.length * 2);
        grownColors.set(colors);
        colors = grownColors;
      }
      tris[triCount * 3] = corners[0];
      tris[triCount * 3 + 1] = corners[c];
      tris[triCount * 3 + 2] = corners[c + 1];
      colors[triCount * 4] = r;
      colors[triCount * 4 + 1] = g;
      colors[triCount * 4 + 2] = b;
      colors[triCount * 4 + 3] = a;
      triCount++;
    }
  }

  const stlSize = 84 + triCount * 50;
  const out = new Uint8Array(stlSize + 4 + triCount * 4);
  const view = new DataView(out.buffer);
  const header = new TextEncoder().encode(MESH_HEADER);
  out.set(header.subarray(0, 80), 0);
  view.setUint32(80, triCount, true);
  let o = 84;
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3] * 3;
    const b = tris[t * 3 + 1] * 3;
    const c = tris[t * 3 + 2] * 3;
    const ux = vertices[b] - vertices[a];
    const uy = vertices[b + 1] - vertices[a + 1];
    const uz = vertices[b + 2] - vertices[a + 2];
    const vx = vertices[c] - vertices[a];
    const vy = vertices[c + 1] - vertices[a + 1];
    const vz = vertices[c + 2] - vertices[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(o, vertices[v], true);
      view.setFloat32(o + 4, vertices[v + 1], true);
      view.setFloat32(o + 8, vertices[v + 2], true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  out.set(new TextEncoder().encode(COLOR_TRAILER_MAGIC), stlSize);
  out.set(colors.subarray(0, triCount * 4), stlSize + 4);
  return out;
}
