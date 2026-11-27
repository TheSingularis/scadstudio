// M18: the quick preview through the real `scad:renderMesh` handler and the
// real engine: curve detail capped in OpenSCAD's CSG dump, then rendered.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMainProcess, type MainProcessHarness } from '../helpers/mainProcess';
import { FIXTURES_DIR } from '../helpers/paths';
import { bbox, parseStl, triangleCount } from '../helpers/stl';
import { readFaceColors } from '../../src/renderer/src/meshColors';

interface MeshResult {
  bytes: Uint8Array;
  reduced: boolean;
  engineMs: number;
}

let main: MainProcessHarness;
const renderMesh = (source: string, segments: number | null) => main.invoke('scad:renderMesh', source, segments) as Promise<MeshResult>;
const size = (bytes: Uint8Array) => {
  const { min, max } = bbox(parseStl(bytes));
  return max.map((v, i) => v - min[i]);
};

beforeAll(async () => {
  main = await loadMainProcess();
});

describe('quick preview (M18)', () => {
  it('caps a per-call $fn, which -D alone would not reach', async () => {
    const source = 'sphere(r=10, $fn=96);';
    const full = await renderMesh(source, null);
    const preview = await renderMesh(source, 24);
    expect(full.reduced).toBe(false);
    expect(preview.reduced).toBe(true);
    expect(triangleCount(parseStl(preview.bytes))).toBeLessThan(triangleCount(parseStl(full.bytes)) / 8);
    // Same part, slightly smaller (a polygon inside the circle).
    for (const [p, f] of size(preview.bytes).map((v, i) => [v, size(full.bytes)[i]])) {
      expect(p).toBeLessThanOrEqual(f + 1e-6);
      expect(p).toBeGreaterThan(f * 0.97);
    }
  });

  it('is the full render when nothing is finer than the cap', async () => {
    const source = 'difference() { cube(10); translate([5, 5, -1]) cylinder(h=12, r=3, $fn=16); }';
    const full = await renderMesh(source, null);
    const preview = await renderMesh(source, 24);
    expect(preview.reduced).toBe(false);
    expect(triangleCount(parseStl(preview.bytes))).toBe(triangleCount(parseStl(full.bytes)));
  });

  it('caps the top level too, for geometry SCAD code builds from $fn (BOSL2-style)', async () => {
    const source = '$fn = 120;\nfunction ring() = [for (i = [0 : $fn - 1]) [10 * cos(360 * i / $fn), 10 * sin(360 * i / $fn)]];\nlinear_extrude(2) polygon(ring());';
    const full = await renderMesh(source, null);
    const preview = await renderMesh(source, 24);
    expect(preview.reduced).toBe(true);
    // A 120-gon prism vs a 24-gon prism.
    expect(triangleCount(parseStl(preview.bytes))).toBeLessThan(triangleCount(parseStl(full.bytes)) / 3);
  });

  it('keeps $preview false, like every render the app makes', async () => {
    const preview = await renderMesh('if ($preview) cube(1); else sphere(r=5, $fn=64);', 24);
    expect(size(preview.bytes)[0]).toBeGreaterThan(9);
  });

  it('keeps model colors', async () => {
    const preview = await renderMesh('color([1, 0, 0]) sphere(r=5, $fn=64);', 24);
    expect(preview.reduced).toBe(true);
    const colors = readFaceColors(preview.bytes);
    expect(colors).not.toBeNull();
    expect([...colors!.slice(0, 3)]).toEqual([255, 0, 0]);
  });

  it('reports errors as a full render does, with the source\'s own warnings', async () => {
    await expect(renderMesh('cube(;', 24)).rejects.toThrow();
    await expect(renderMesh('not_a_module(3);', 24)).rejects.toThrow(/not_a_module|unknown module/i);
  });

  it('renders the gag trophy (top-level $fn = 120) as a preview with the trophy\'s size', async () => {
    const source = readFileSync(join(FIXTURES_DIR, 'gag_trophy1.scad'), 'utf8');
    const preview = await renderMesh(source, 24);
    expect(preview.reduced).toBe(true);
    const [w, d, h] = size(preview.bytes);
    // Base is 140 x 70 (rounded rectangles, so a coarser corner keeps the size).
    expect(w).toBeCloseTo(140, 0);
    expect(d).toBeCloseTo(70, 0);
    expect(h).toBeGreaterThan(250);
    // 437,510 triangles at full detail (measured 2026-11-27).
    expect(triangleCount(parseStl(preview.bytes))).toBeLessThan(150_000);
  }, 120_000);

  it('the full render handler is unchanged', async () => {
    const bytes = (await main.invoke('scad:render', 'sphere(r=10, $fn=96);')) as Uint8Array;
    const full = await renderMesh('sphere(r=10, $fn=96);', null);
    expect(bytes.byteLength).toBe(full.bytes.byteLength);
  });
});
