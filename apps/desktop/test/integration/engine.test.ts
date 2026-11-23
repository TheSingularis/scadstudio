// Facts about the bundled openscad-wasm engine that the app's design relies
// on (PLAN.md "M0 spike results" and "Known engine bug"). Not app code: if a
// dependency bump changes one of these, this is where it shows up first.
import { describe, expect, it } from 'vitest';
import { createOpenSCAD } from 'openscad-wasm';

async function run(files: Record<string, string>, args: string[] = []) {
  const log: string[] = [];
  const instance = (await createOpenSCAD({ print: (t) => log.push(t), printErr: (t) => log.push(t) })).getInstance();
  for (const [path, text] of Object.entries(files)) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) {
      try {
        instance.FS.mkdir(dir);
      } catch {
        // already exists
      }
    }
    instance.FS.writeFile(path, text);
  }
  const t0 = performance.now();
  const code = instance.callMain(['/input.scad', '-o', '/output.stl', ...args]);
  const ms = performance.now() - t0;
  const stl = code === 0 ? (instance.FS.readFile('/output.stl', { encoding: 'utf8' }) as string) : '';
  return { code, stl, log: log.join('\n'), ms };
}

describe('openscad-wasm engine (M0)', () => {
  it('supports --backend=Manifold', async () => {
    const r = await run({ '/input.scad': 'difference() { cube(10); sphere(6); }' }, ['--backend=Manifold']);
    expect(r.code).toBe(0);
    expect(r.log).toMatch(/\(manifold\)/i);
  });

  it('defaults to CGAL when no backend is passed (why H1 needs the flag)', async () => {
    const r = await run({ '/input.scad': 'difference() { cube(10); sphere(6); }' });
    expect(r.log).toMatch(/Nef polyhedron/);
  });

  it('resolves use <lib.scad> when the library is in its virtual FS (the H4 fix relies on this)', async () => {
    const r = await run(
      { '/lib.scad': 'module peg(h) { cylinder(h=h, r=1, $fn=8); }', '/input.scad': 'use <lib.scad>\npeg(5);' },
      ['--backend=Manifold'],
    );
    expect(r.code).toBe(0);
    expect(r.stl).toContain('facet');
  });

  it('include <> works from a subfolder too', async () => {
    const instanceFiles = { '/libs/shapes.scad': 'w = 4;\nmodule plate() { cube([w, w, 1]); }', '/input.scad': 'include <libs/shapes.scad>\nplate();' };
    const r = await run(instanceFiles, ['--backend=Manifold']);
    expect(r.code).toBe(0);
  });

  it('linear_extrude with twist and low $fn renders (PLAN "known engine bug" recheck)', async () => {
    const r = await run({ '/input.scad': 'linear_extrude(height=10, twist=90, slices=10) circle(r=5, $fn=6);' }, ['--backend=Manifold']);
    expect(r.code).toBe(0);
  });

  it.fails('text() renders (no fonts bundled in openscad-wasm 0.0.4, tracked by M15)', async () => {
    const r = await run({ '/input.scad': 'linear_extrude(1) text("Hi");' }, ['--backend=Manifold']);
    expect(r.code).toBe(0);
    expect(r.stl).toContain('facet');
  });
});
