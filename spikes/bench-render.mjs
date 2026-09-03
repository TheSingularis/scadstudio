import { createOpenSCAD } from 'openscad-wasm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./fixtures/basics.scad', import.meta.url), 'utf8');

async function once() {
  const t0 = performance.now();
  const openscad = await createOpenSCAD({ print: () => {}, printErr: () => {} });
  const t1 = performance.now();
  const stl = await openscad.renderToStl(source);
  const t2 = performance.now();
  return { instantiate: t1 - t0, render: t2 - t1, total: t2 - t0, bytes: stl.length };
}

const results = [];
for (let i = 0; i < 20; i++) results.push(await once());
for (const r of results) console.log(`instantiate=${r.instantiate.toFixed(0)}ms render=${r.render.toFixed(0)}ms total=${r.total.toFixed(0)}ms`);
const totals = results.slice(3).map((r) => r.total); // drop warmup
console.log(`\nsteady-state avg=${(totals.reduce((a,b)=>a+b,0)/totals.length).toFixed(0)}ms min=${Math.min(...totals).toFixed(0)}ms max=${Math.max(...totals).toFixed(0)}ms (n=${totals.length}, heavier fixture: booleans+extrusions+modules)`);
