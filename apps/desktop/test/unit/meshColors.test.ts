// M10a: the render process turns the engine's OFF export (which keeps a
// color per face) into binary STL plus a color trailer (src/main/offMesh.ts),
// and the viewport reads the colors back (src/renderer/src/meshColors.ts).
// This writes with one and reads with the other, so the two stay in step.
import { describe, expect, it } from 'vitest';
import { offToColoredStl, OffParseError } from '../../src/main/offMesh';
import { ENGINE_DEFAULT_RGB, readFaceColors, summarizeFaceColors, vertexColorAttribute } from '../../src/renderer/src/meshColors';
import { bbox, parseStl, triangleCount } from '../helpers/stl';

const enc = (s: string) => new TextEncoder().encode(s);

// A unit square in z=0 as two triangles, the way OpenSCAD writes OFF.
const TWO_TRIANGLES = `OFF
4 2 0
0 0 0
1 0 0
1 1 0
0 1 0
3 0 1 2 218 165 32
3 0 2 3 255 0 0 127
`;

describe('offToColoredStl', () => {
  it('writes binary STL any STL reader can read, plus one RGBA per triangle', () => {
    const bytes = offToColoredStl(enc(TWO_TRIANGLES));
    const geom = parseStl(bytes);
    expect(triangleCount(geom)).toBe(2);
    expect(bbox(geom)).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
    expect([...readFaceColors(bytes)!]).toEqual([218, 165, 32, 255, 255, 0, 0, 127]);
    // A normal per face, pointing up for this counter-clockwise square.
    expect([...geom.getAttribute('normal').array.slice(0, 3)]).toEqual([0, 0, 1]);
  });

  it('fans polygons into triangles, each with the polygon\'s color', () => {
    const quad = 'OFF\n4 1 0\n0 0 0\n2 0 0\n2 2 0\n0 2 0\n4 0 1 2 3 10 20 30\n';
    const bytes = offToColoredStl(enc(quad));
    expect(triangleCount(parseStl(bytes))).toBe(2);
    expect([...readFaceColors(bytes)!]).toEqual([10, 20, 30, 255, 10, 20, 30, 255]);
  });

  it('reads 0-1 float colors and faces without a color (the engine default)', () => {
    const off = 'OFF\n3 2 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2 1 0.5 0\n3 0 2 1\n';
    expect([...readFaceColors(offToColoredStl(enc(off)))!]).toEqual([255, 128, 0, 255, ...ENGINE_DEFAULT_RGB, 255]);
  });

  it('handles comments and Windows line ends', () => {
    const off = '# made by hand\r\nOFF\r\n3 1 0\r\n0 0 0\r\n1 0 0\r\n0 1 0 # last vertex\r\n3 0 1 2 1 2 3\r\n';
    expect([...readFaceColors(offToColoredStl(enc(off)))!]).toEqual([1, 2, 3, 255]);
  });

  it('an empty mesh is a valid empty STL', () => {
    const bytes = offToColoredStl(enc('OFF\n0 0 0\n'));
    expect(triangleCount(parseStl(bytes))).toBe(0);
    expect(readFaceColors(bytes)!.length).toBe(0);
  });

  it('rejects what isn\'t OFF, and faces naming missing vertices', () => {
    expect(() => offToColoredStl(enc('solid x\nendsolid x\n'))).toThrow(OffParseError);
    expect(() => offToColoredStl(enc('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 7\n'))).toThrow(/vertex 7 of 3/);
    expect(() => offToColoredStl(enc('OFF\n3 1 0\n0 0 0\n1 0 0\n'))).toThrow(OffParseError);
  });
});

describe('meshColors', () => {
  it('plain binary STL (no trailer) has no face colors', () => {
    const bytes = offToColoredStl(enc(TWO_TRIANGLES));
    const plain = bytes.slice(0, 84 + 2 * 50);
    expect(readFaceColors(plain)).toBeNull();
    // A trailer with the wrong magic isn't one either.
    const wrong = bytes.slice();
    wrong[84 + 100] = 0;
    expect(readFaceColors(wrong)).toBeNull();
  });

  it('summarizes whether anything is colored or translucent', () => {
    const d = [...ENGINE_DEFAULT_RGB, 255];
    expect(summarizeFaceColors(new Uint8Array([...d, ...d]))).toEqual({ allDefault: true, translucent: false });
    expect(summarizeFaceColors(new Uint8Array([...d, 1, 2, 3, 255]))).toEqual({ allDefault: false, translucent: false });
    expect(summarizeFaceColors(new Uint8Array([...d, 1, 2, 3, 100]))).toEqual({ allDefault: false, translucent: true });
  });

  it('builds a linear vertex color per corner, with uncolored faces in the app default', () => {
    const faces = new Uint8Array([255, 0, 0, 255, ...ENGINE_DEFAULT_RGB, 255]);
    const attr = vertexColorAttribute(faces, [0, 255, 0]);
    expect(attr.itemSize).toBe(4);
    expect(attr.normalized).toBe(true);
    expect(attr.count).toBe(6);
    // First triangle red, three corners.
    for (let v = 0; v < 3; v++) expect([attr.getX(v), attr.getY(v), attr.getZ(v), attr.getW(v)]).toEqual([1, 0, 0, 1]);
    // Second triangle takes the fallback.
    expect([attr.getX(3), attr.getY(3), attr.getZ(3)]).toEqual([0, 1, 0]);
    // sRGB to linear: mid grey 128 is about 0.216, not 0.5.
    const grey = vertexColorAttribute(new Uint8Array([128, 128, 128, 255]), [0, 0, 0]);
    expect(grey.getX(0)).toBeCloseTo(0.2158, 3);
  });
});
