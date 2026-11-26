// M11 Distance/Align (relate.ts): the written expressions put the parts
// where they should be, checked against the engine's own render, and keep
// doing so after a variable they read changes.
import { describe, expect, it } from 'vitest';
import { renderScadToStl } from '../../src/main/scadRender';
import { bbox, parseStl } from '../helpers/stl';
import { expectCleanParse, parse } from '../helpers/parse';
import { buildSceneGraph } from '../../src/renderer/src/sceneGraph';
import { planRelate, currentOffset, type RelateRequest } from '../../src/renderer/src/relate';
import { decomposeNode } from '../../src/renderer/src/targetedPatch';
import { readVariables, setVariableValue } from '../../src/renderer/src/variables';

async function boxOf(source: string) {
  return bbox(parseStl(await renderScadToStl(source)));
}

async function relate(source: string, req: Partial<RelateRequest> & Pick<RelateRequest, 'axis' | 'moveEdge' | 'referenceEdge'>, moveIndex = 1, refIndex = 0) {
  const tree = await parse(source);
  const nodes = buildSceneGraph(tree, source).nodes;
  const r = planRelate(source, tree, {
    move: nodes[moveIndex],
    reference: nodes[refIndex],
    offsetText: '0',
    offsetName: null,
    follow: true,
    measureMove: () => null,
    measureReference: () => null,
    ...req,
  });
  if (!r.ok) throw new Error(r.reason);
  await expectCleanParse(r.plan.source);
  return r.plan;
}

async function translateOf(source: string, index: number) {
  const tree = await parse(source);
  return decomposeNode(tree.rootNode, buildSceneGraph(tree, source).nodes[index])!.transform.translate;
}

describe('M11 relate tools (engine-checked)', () => {
  const base = 'cube([30, 20, 10]);\n\ntranslate([60, 5, 0]) sphere(r = 8);\n';

  it('Distance: sphere 5 mm right of the cube, following both parts', async () => {
    const plan = await relate(base, { axis: 0, moveEdge: 'min', referenceEdge: 'max', offsetText: '5', offsetName: 'gap' });
    expect(plan.newVariables).toEqual([
      { name: 'cube_x', valueText: '0' },
      { name: 'cube_width', valueText: '30' },
      { name: 'sphere_r', valueText: '8' },
      { name: 'gap', valueText: '5' },
    ]);
    expect(plan.expression).toBe('cube_x + cube_width + gap + sphere_r');
    expect(plan.source).toBe(
      'cube_x = 0;\ncube_width = 30;\nsphere_r = 8;\ngap = 5;\n\ntranslate([cube_x, 0, 0])\n    cube([cube_width, 20, 10]);\n\ntranslate([cube_x + cube_width + gap + sphere_r, 5, 0])\n    sphere(r = sphere_r);\n',
    );
    expect(await translateOf(plan.source, 1)).toEqual([43, 5, 0]);
    expect((await boxOf(plan.source)).max[0]).toBeCloseTo(51, 1);

    // The cube grows: the sphere keeps its 5 mm gap.
    const tree = await parse(plan.source);
    const width = readVariables(tree.rootNode).find((v) => v.name === 'cube_width')!;
    const grown = setVariableValue(plan.source, width, '50');
    expect(await translateOf(grown, 1)).toEqual([63, 5, 0]);
    expect((await boxOf(grown)).max[0]).toBeCloseTo(71, 1);
  });

  it('Distance attaches the other axes: the sphere follows the cube in every direction', async () => {
    const plan = await relate(base, { axis: 0, moveEdge: 'min', referenceEdge: 'max', offsetText: '5', offsetName: 'gap', attach: true });
    expect(plan.newVariables.map((v) => v.name)).toEqual(['cube_x', 'cube_y', 'cube_z', 'cube_width', 'sphere_r', 'gap']);
    expect(plan.source).toContain('translate([cube_x, cube_y, cube_z])\n    cube([cube_width, 20, 10]);');
    expect(plan.source).toContain('translate([cube_x + cube_width + gap + sphere_r, cube_y + 5, cube_z])');
    // Moving the cube's position variables moves the sphere the same way.
    let moved = plan.source;
    for (const [name, value] of [['cube_x', '10'], ['cube_y', '-4'], ['cube_z', '3']]) {
      const v = readVariables((await parse(moved)).rootNode).find((x) => x.name === name)!;
      moved = setVariableValue(moved, v, value);
    }
    expect(await translateOf(moved, 0)).toEqual([10, -4, 3]);
    expect(await translateOf(moved, 1)).toEqual([53, 1, 3]);
    const box = await boxOf(moved);
    expect(box.min[2]).toBeCloseTo(-5, 0);
    expect(box.max[0]).toBeCloseTo(61, 1);
  });

  it('without follow, the numbers are copied', async () => {
    const plan = await relate(base, { axis: 0, moveEdge: 'min', referenceEdge: 'max', offsetText: '5', follow: false });
    expect(plan.newVariables).toEqual([]);
    expect(plan.source).toContain('translate([43, 5, 0])');
  });

  it('Align: centers on Y, onto a reference that already uses variables', async () => {
    const src = 'w = 30;\nd = 20;\n\ntranslate([0, 10, 0]) cube([w, d, 10], center = true);\n\ntranslate([60, 0, 0]) cylinder(h = 5, r = 4);\n';
    const plan = await relate(src, { axis: 1, moveEdge: 'center', referenceEdge: 'center' });
    // The cube's translate is named; its centered depth cancels out; the
    // cylinder's radius cancels out too, so nothing else is added.
    expect(plan.newVariables).toEqual([{ name: 'cube_y', valueText: '10' }]);
    expect(plan.expression).toBe('cube_y');
    expect(await translateOf(plan.source, 1)).toEqual([60, 10, 0]);
  });

  it('uses the measured size of a part it cannot size, and says so', async () => {
    const src = 'module bracket() { cube([12, 4, 4]); }\n\nbracket();\n\ntranslate([40, 0, 0]) cube(5);\n';
    const plan = await relate(src, { axis: 0, moveEdge: 'min', referenceEdge: 'max', measureReference: () => ({ min: [0, 0, 0], max: [12, 4, 4] }) });
    expect(plan.measured).toEqual({ move: false, reference: true });
    expect(plan.expression).toBe('bracket_x + 12');
    expect(await translateOf(plan.source, 1)).toEqual([12, 0, 0]);
    expect((await boxOf(plan.source)).max[0]).toBeCloseTo(17, 2);
  });

  it('a reference turned 90 degrees uses its rotated faces', async () => {
    const src = 'translate([10, 0, 0]) rotate([0, 0, 90]) cube([30, 20, 10]);\n\ntranslate([60, 0, 0]) cube(5);\n';
    // Rotated 90° about Z, the cube spans x in [10 - 20, 10].
    const plan = await relate(src, { axis: 0, moveEdge: 'max', referenceEdge: 'min', follow: false });
    expect(await translateOf(plan.source, 1)).toEqual([-15, 0, 0]);
    expect((await boxOf(plan.source)).min[0]).toBeCloseTo(-15, 2);
  });

  it('reports the current offset for the default', async () => {
    const tree = await parse(base);
    const nodes = buildSceneGraph(tree, base).nodes;
    expect(currentOffset(tree, { move: nodes[1], reference: nodes[0], axis: 0, moveEdge: 'min', referenceEdge: 'max', measureMove: () => null, measureReference: () => null })).toBe(22);
  });
});
