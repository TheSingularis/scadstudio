// The per-node render strategy (M3-M5): the app sends only the bare
// primitive to OpenSCAD and re-applies translate/rotate/mirror/scale as a
// three.js transform. That is only correct if
//     transform(render(primitiveOnlySlice(node)))  ==  render(node)
// for every statement shape the app decomposes. This checks it against real
// openscad-wasm output by comparing bounding boxes of asymmetric shapes.
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/main/engine';
import { audit } from '../helpers/audit';
import { nodeAt } from '../helpers/parse';
import { applyNodeTransform, bbox, parseStl } from '../helpers/stl';
import { IDENTITY_TRANSFORM, decomposeNode, primitiveOnlySlice, wrapAsThinExtrude } from '../../src/renderer/src/targetedPatch';

// Engine-direct (Manifold) so this checks decomposition maths only and stays
// fast regardless of which backend the app itself picks (that is audit H1,
// tested in renderIpc.test.ts).
async function renderDirect(source: string): Promise<Uint8Array> {
  const instance = await createEngine({ print: () => {}, printErr: () => {} });
  instance.FS.writeFile('/input.scad', source);
  const code = instance.callMain(['/input.scad', '-o', '/output.stl', '--backend=Manifold']);
  if (code !== 0) throw new Error(`openscad exited ${code} for:\n${source}`);
  return instance.FS.readFile('/output.stl') as Uint8Array;
}

async function expectDecompositionMatches(statement: string, context = '') {
  const source = context ? `${context}\n${statement}` : statement;
  const { tree, node, graph } = await nodeAt(source, 0);
  const transform = decomposeNode(tree.rootNode, node)?.transform ?? IDENTITY_TRANSFORM;
  const isolated = `${graph.context}\n${primitiveOnlySlice(tree.rootNode, node, source)}`;
  const shown = bbox(applyNodeTransform(parseStl(await renderDirect(isolated)), transform));
  const truth = bbox(parseStl(await renderDirect(source)));
  for (let i = 0; i < 3; i++) {
    expect(shown.min[i], `min[${i}] of ${statement}`).toBeCloseTo(truth.min[i], 3);
    expect(shown.max[i], `max[${i}] of ${statement}`).toBeCloseTo(truth.max[i], 3);
  }
}

describe('decomposed render + transform matches the full OpenSCAD render (M3-M5)', () => {
  it.each([
    'cube([1, 2, 3]);',
    'translate([30, -4, 2]) cube([1, 2, 3]);',
    'rotate([0, 0, 30]) cube([1, 2, 3]);',
    'rotate([10, 20, 30]) cube([1, 2, 3]);',
    'scale([2, 0.5, 3]) cube([1, 2, 3]);',
    'mirror([1, 0, 0]) cube([1, 2, 3]);',
    'mirror([0, 0, 1]) translate([0, 0, 0]) cube([1, 2, 3]);',
    'translate([5, 6, 7]) rotate([0, 45, 0]) mirror([0, 1, 0]) scale([1, 2, 1]) cube([1, 2, 3]);',
    'color([1, 0, 0]) translate([3, 0, 0]) cube([1, 2, 3]);',
    '#translate([1, 1, 1]) cube([1, 2, 3]);',
    'translate([0, 0, 10]) cylinder(h=20, r=5, $fn=32);',
    'translate([10, 0, 0]) linear_extrude(height=4) square([2, 3]);',
  ])('%s', async (statement) => {
    await expectDecompositionMatches(statement);
  });

  it.each([
    'translate([w + gap, -w / 2, 0]) cube([1, 2, 3]);',
    'translate([w, 0, 0]) rotate([0, 0, angle]) scale([k, 1, k / 2]) cube([1, 2, 3]);',
    'translate([gap * 2, 0, 0]) mirror([1, 0, 0]) scale([k, 1, 1]) cube([1, 2, 3]);',
    'rotate([angle, 0, -angle]) translate([twice(gap), 0, 0]) cube([1, 2, 3]);',
  ])('M11 expression components: %s', async (statement) => {
    await expectDecompositionMatches(statement, 'w = 12;\ngap = 2.5;\nangle = 30;\nk = 1.5;\nfunction twice(x) = 2 * x;');
  });

  it('custom modules render through the shared context', async () => {
    await expectDecompositionMatches('translate([10, 0, 0]) part(2);', 'module part(s) { cube([s, 2 * s, 3 * s]); }');
  });

  it('bare 2D shapes render via the thin-extrude retry (M7)', async () => {
    const source = 'translate([4, 0, 0]) square([2, 3]);';
    const { tree, node } = await nodeAt(source);
    const bytes = await renderDirect(wrapAsThinExtrude('', primitiveOnlySlice(tree.rootNode, node, source)));
    const b = bbox(applyNodeTransform(parseStl(bytes), decomposeNode(tree.rootNode, node)!.transform));
    expect(b.min.slice(0, 2)).toEqual([4, 0]);
    expect(b.max.slice(0, 2)).toEqual([6, 3]);
  });

  it(audit('H2', 'translate(v) { ... } (block body) matches real OpenSCAD'), async () => {
    await expectDecompositionMatches('translate([30, 0, 0]) { cube([1, 2, 3]); }');
  });

  it(audit('H2', 'rotate(v) { ... } (block body) matches real OpenSCAD'), async () => {
    await expectDecompositionMatches('rotate([0, 0, 90]) { cube([1, 2, 3]); }');
  });

  it(audit('M1', 'stacked translate() translate() matches real OpenSCAD'), async () => {
    await expectDecompositionMatches('translate([1, 0, 0]) translate([2, 0, 0]) cube([1, 2, 3]);');
  });

  it(audit('M1', 'non-canonical rotate() translate() order matches real OpenSCAD'), async () => {
    await expectDecompositionMatches('rotate([0, 0, 90]) translate([10, 0, 0]) cube([1, 2, 3]);');
  });
});
