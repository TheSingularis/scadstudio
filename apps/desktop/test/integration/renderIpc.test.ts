// The real main-process render path (`scad:render` in src/main/index.ts),
// driven with Electron faked out: M1/M2 render results, the M0 "fresh
// instance per render" requirement, backend selection and render timing
// (audit H1), and error reporting (audit M4).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../helpers/audit';
import { loadMainProcess, type MainProcessHarness } from '../helpers/mainProcess';
import { SPIKE_FIXTURES_DIR } from '../helpers/paths';
import { bbox, parseStl, triangleCount } from '../helpers/stl';

let main: MainProcessHarness;
const render = (source: string) => main.invoke('scad:render', source) as Promise<Uint8Array>;

beforeAll(async () => {
  main = await loadMainProcess();
  await render('cube(1);'); // warm up the WASM compile so timings below are fair
});

// lib.scad is a library with no geometry; main-with-use.scad needs lib.scad
// next to it (covered by the e2e "open a file with use <>" test, audit H4).
const fixtures = readdirSync(SPIKE_FIXTURES_DIR).filter((f) => f.endsWith('.scad') && f !== 'lib.scad' && f !== 'main-with-use.scad');

describe('scad:render IPC handler (M1/M2)', () => {
  it('registers the render and open-file channels', () => {
    expect([...main.handlers.keys()]).toEqual(expect.arrayContaining(['scad:render', 'scad:openFile']));
  });

  it.each(fixtures)('renders spikes/fixtures/%s to a non-degenerate STL', async (file) => {
    const bytes = await render(readFileSync(join(SPIKE_FIXTURES_DIR, file), 'utf8'));
    expect(bytes).toBeInstanceOf(Uint8Array);
    const geom = parseStl(bytes);
    expect(triangleCount(geom)).toBeGreaterThan(0);
    const { min, max } = bbox(geom);
    expect(max.some((v, i) => v - min[i] > 0)).toBe(true);
  });

  it('renders the exact geometry asked for', async () => {
    const { min, max } = bbox(parseStl(await render('cube([2, 3, 4]);')));
    expect(min).toEqual([0, 0, 0]);
    expect(max).toEqual([2, 3, 4]);
  });

  it('survives many sequential renders (fresh engine instance each time, M0 finding)', async () => {
    for (let i = 1; i <= 5; i++) {
      const { max } = bbox(parseStl(await render(`cube(${i});`)));
      expect(max).toEqual([i, i, i]);
    }
  });

  it('rejects for a source with a syntax error', async () => {
    await expect(render('cube(;')).rejects.toBeDefined();
  });

  it('rejects for pure 2D geometry (the renderer retries with a thin extrude, M7)', async () => {
    await expect(render('circle(r=5);')).rejects.toBeDefined();
  });

  it.fails(audit('M4', 'render errors are real Errors with a readable message, not [object Object]'), async () => {
    const err = await render('cube(;').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toMatch(/^\[object Object\]$|^$/);
  });
});

describe('render backend and timing (audit H1)', () => {
  const twelveBooleanParts = Array.from(
    { length: 12 },
    (_, i) =>
      `translate([${(i % 4) * 15}, ${Math.floor(i / 4) * 15}, 0]) difference() { cube(10); translate([5, 5, -1]) cylinder(h=12, r=3, $fn=32); }`,
  ).join('\n');

  it.fails(audit('H1', 'renders with the Manifold backend'), async () => {
    await render('difference() { cube(10); sphere(6); }');
    const log = main.engineLog[main.engineLog.length - 1].join('\n');
    expect(log).toMatch(/\(manifold\)/i);
    expect(log).not.toMatch(/Nef polyhedron/);
  });

  // Manifold renders this in ~20-50 ms and CGAL in ~2.3 s on a dev machine,
  // so a 750 ms budget separates them with a wide margin either way.
  it.fails(audit('H1', 'a 12-part boolean file renders inside the latency budget (750 ms)'), async () => {
    const t0 = performance.now();
    await render(twelveBooleanParts);
    expect(performance.now() - t0).toBeLessThan(750);
  });
});
