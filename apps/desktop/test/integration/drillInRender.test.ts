// M9: an isolated render of a nested (drilled-into) node, placed by its
// working set's frame and its own decomposed transform the way Viewport.tsx
// places it, must land exactly where real OpenSCAD puts that node in the
// full design. Checked against openscad-wasm by bounding box, with
// asymmetric shapes so a wrong rotation or mirror shows.
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/main/engine';
import { Matrix4 } from 'three';
import { applyNodeTransform, bbox, parseStl } from '../helpers/stl';
import { docOf, resolverFor } from '../helpers/drill';
import { buildSceneGraph } from '../../src/renderer/src/sceneGraph';
import { isolatedRender, resolveFocus, type FocusEntry } from '../../src/renderer/src/drillIn';

async function renderDirect(source: string): Promise<Uint8Array | null> {
  const instance = await createEngine({ print: () => {}, printErr: () => {} });
  instance.FS.writeFile('/input.scad', source);
  const code = instance.callMain(['/input.scad', '-o', '/output.stl', '--backend=Manifold']);
  if (code !== 0) return null;
  return instance.FS.readFile('/output.stl') as Uint8Array;
}

async function expectNestedMatches(document: string, path: number[], child: number, truth: string) {
  const doc = await docOf(document);
  const resolve = resolverFor(doc);
  let focus: FocusEntry[] = [];
  for (const index of path) {
    const current = resolveFocus(doc, focus, resolve);
    focus = [...current.focus, { index, siblings: current.sets[current.sets.length - 1].fingerprints }];
  }
  const resolved = resolveFocus(doc, focus, resolve);
  expect(resolved.focus.length, 'focus path resolves').toBe(path.length);
  const set = resolved.sets[resolved.sets.length - 1];
  const node = set.nodes[child];
  const render = isolatedRender(set, node, buildSceneGraph(doc.tree, document).context);
  const bytes = (await renderDirect(render.source)) ?? (await renderDirect(render.flatSource));
  expect(bytes, `isolated render of:\n${render.source}`).not.toBeNull();
  const shown = parseStl(bytes!);
  const placed = applyNodeTransform(shown, render.transform).applyMatrix4(new Matrix4().fromArray(set.frame));
  const truthBytes = (await renderDirect(truth)) ?? (await renderDirect(`linear_extrude(height=0.01) { ${truth} }`));
  const a = bbox(placed);
  const b = bbox(parseStl(truthBytes!));
  for (let i = 0; i < 3; i++) {
    expect(a.min[i], `min[${i}]`).toBeCloseTo(b.min[i], 2);
    expect(a.max[i], `max[${i}]`).toBeCloseTo(b.max[i], 2);
  }
  return render;
}

describe('drilled-in isolated renders land where OpenSCAD puts the node (M9)', () => {
  const boolean = 'translate([10, 0, 0]) rotate([0, 0, 20]) difference() {\n    cube([4, 5, 6]);\n    translate([1, 1, -1]) rotate([0, 0, 30]) cube([1, 2, 8]);\n}\n';

  it('children of a placed boolean', async () => {
    await expectNestedMatches(boolean, [0], 0, 'translate([10, 0, 0]) rotate([0, 0, 20]) cube([4, 5, 6]);');
    const r = await expectNestedMatches(
      boolean,
      [0],
      1,
      'translate([10, 0, 0]) rotate([0, 0, 20]) translate([1, 1, -1]) rotate([0, 0, 30]) cube([1, 2, 8]);',
    );
    expect(r.transformEditable).toBe(true);
    expect(r.transform.translate).toEqual([1, 1, -1]);
  });

  const bracket = [
    'module bracket(w=20, h=10, t=3) {',
    '    difference() {',
    '        cube([w, h, t]);',
    '        translate([t, t, -1]) cube([w - 2 * t, h - 2 * t, t + 2]);',
    '    }',
    '}',
    'translate([0, 5, 0]) rotate([0, 0, 90]) bracket(30, h=15);',
    '',
  ].join('\n');

  it("a module body sees the instance's positional, named and default arguments", async () => {
    await expectNestedMatches(bracket, [0, 0], 0, 'translate([0, 5, 0]) rotate([0, 0, 90]) cube([30, 15, 3]);');
    await expectNestedMatches(bracket, [0, 0], 1, 'translate([0, 5, 0]) rotate([0, 0, 90]) translate([3, 3, -1]) cube([24, 9, 5]);');
  });

  it('an ancestor transform it cannot evaluate is baked into the render (gizmo off)', async () => {
    // A module parameter: its value depends on the call.
    const r = await expectNestedMatches(
      'module m(w = 3) {\n    translate([w, 0, 0]) {\n        cube(1);\n        translate([0, 2, 0]) cube([1, 2, 3]);\n    }\n}\nm(4);\n',
      [0, 0],
      1,
      'translate([4, 0, 0]) translate([0, 2, 0]) cube([1, 2, 3]);',
    );
    expect(r.transformEditable).toBe(false);
  });

  it('M11: an ancestor transform written with top-level variables is evaluated (gizmo on)', async () => {
    const r = await expectNestedMatches(
      'w = 3;\ngap = 1.5;\ntranslate([w + gap, 0, 0]) rotate([0, 0, w * 10]) {\n    cube(1);\n    translate([0, gap * 2, 0]) cube([1, 2, 3]);\n}\n',
      [0],
      1,
      'translate([4.5, 0, 0]) rotate([0, 0, 30]) translate([0, 3, 0]) cube([1, 2, 3]);',
    );
    expect(r.transformEditable).toBe(true);
    expect(r.transform.exprs?.translate).toEqual([null, 'gap * 2', null]);
  });

  it("a block's own assignments stay in scope", async () => {
    await expectNestedMatches('translate([2, 0, 0]) {\n    s = 4;\n    cube([s, 1, 2]);\n}\n', [0], 0, 'translate([2, 0, 0]) cube([4, 1, 2]);');
  });

  it('the 2D child of an extrusion renders flat, in the extrusion frame', async () => {
    await expectNestedMatches(
      'translate([0, 0, 5]) linear_extrude(height=3) translate([2, 0]) square([1, 2]);\n',
      [0],
      0,
      'translate([0, 0, 5]) linear_extrude(height=0.01) translate([2, 0]) square([1, 2]);',
    );
  });

  it('children() inside a drilled module body still gets the instance children', async () => {
    await expectNestedMatches('module wrap() { translate([5, 0, 0]) children(); }\nwrap() cube([2, 1, 1]);\n', [0], 0, 'translate([5, 0, 0]) cube([2, 1, 1]);');
  });

  it('two levels deep inside a module, under a mirrored boolean', async () => {
    const doc = [
      'module part(s=2) {',
      '    union() {',
      '        cube([s, 1, 1]);',
      '        translate([0, s, 0]) cube([1, 1, s]);',
      '    }',
      '}',
      'mirror([1, 0, 0]) part(s=3);',
      '',
    ].join('\n');
    await expectNestedMatches(doc, [0, 0], 1, 'mirror([1, 0, 0]) translate([0, 3, 0]) cube([1, 1, 3]);');
  });

  it('inside an if: a branch statement renders with the branch assignments, under its condition', async () => {
    const doc = 'x = 3;\nif (x > 2) {\n    w = 2;\n    translate([5, 0, 0]) cube([w, 1, 1]);\n} else {\n    sphere(1);\n}\n';
    await expectNestedMatches(doc, [0], 0, 'translate([5, 0, 0]) cube([2, 1, 1]);');
  });

  it('a statement in the branch the model does not take renders empty', async () => {
    const doc = await docOf('x = 3;\nif (x > 2) cube(1); else translate([9, 0, 0]) sphere(1);\n');
    const resolve = resolverFor(doc);
    const r = resolveFocus(doc, [{ index: 0, siblings: resolveFocus(doc, [], resolve).sets[0].fingerprints }], resolve);
    const set = r.sets[1];
    const render = isolatedRender(set, set.nodes[1], buildSceneGraph(doc.tree, doc.text).context);
    expect(await renderDirect(render.source)).toBeNull();
    expect(await renderDirect(render.flatSource)).toBeNull();
  });

  it('children() inside an if inside a module body still gets the instance children', async () => {
    await expectNestedMatches(
      'module m(on) {\n    if (on) {\n        translate([0, 4, 0]) children();\n    } else {\n        cube(1);\n    }\n}\nm(true) translate([3, 0, 0]) cube([1, 2, 3]);\n',
      [0, 0],
      0,
      'translate([0, 4, 0]) translate([3, 0, 0]) cube([1, 2, 3]);',
    );
  });

  it('a module nested in a module body, drilled into through an if (module definitions stay out of the if)', async () => {
    const doc = [
      'module outer(s) {',
      '    k = s * 2;',
      '    module inner(t) { translate([t, 0, 0]) cube([1, k, 1]); }',
      '    if (s > 1) {',
      '        inner(s);',
      '    }',
      '}',
      'if ($preview) { rotate([90, 0, 0]) outer(3); } else { outer(3); }',
      '',
    ].join('\n');
    await expectNestedMatches(doc, [0, 1, 0, 0], 0, 'translate([3, 0, 0]) cube([1, 6, 1]);');
  });
});
