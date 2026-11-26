// M11 patterns (pattern.ts): the generated loops render the copies where
// they belong (engine-checked), read back for the pattern panel, and stay
// movable with the gizmo (linear).
import { describe, expect, it } from 'vitest';
import { renderScadToStl } from '../../src/main/scadRender';
import { bbox, parseStl } from '../helpers/stl';
import { expectCleanParse, parse } from '../helpers/parse';
import { buildSceneGraph } from '../../src/renderer/src/sceneGraph';
import { patternCountEdits, patternSpacingEdits, readPattern, wrapInPattern, type PatternOptions } from '../../src/renderer/src/pattern';
import { decomposeNode } from '../../src/renderer/src/targetedPatch';
import { applyEdits } from '../../src/renderer/src/variables';

async function wrap(source: string, opts: PatternOptions, index = 0) {
  const tree = await parse(source);
  const next = wrapInPattern(source, tree, buildSceneGraph(tree, source).nodes[index], opts);
  expect(next).not.toBeNull();
  await expectCleanParse(next!);
  return next!;
}

async function info(source: string, index = 0) {
  const tree = await parse(source);
  return { tree, node: buildSceneGraph(tree, source).nodes[index], pattern: readPattern(tree, buildSceneGraph(tree, source).nodes[index]) };
}

const box = async (s: string) => bbox(parseStl(await renderScadToStl(s)));

describe('M11 patterns (engine-checked)', () => {
  it('linear: 4 copies at 15 mm pitch along X, outside the part rotation', async () => {
    const src = 'translate([5, 0, 0]) rotate([0, 0, 90]) cube([10, 2, 3]);\n';
    const next = await wrap(src, { kind: 'linear', axis: 0, count: '4', spacing: '15' });
    expect(next).toBe('translate([5, 0, 0])\n    for (i = [0 : 3])\n    translate([i * 15, 0, 0])\n    rotate([0, 0, 90])\n    cube([10, 2, 3]);\n');
    // Rotated 90°, each copy spans x in [5 - 2, 5] + i * 15.
    const b = await box(next);
    expect(b.min[0]).toBeCloseTo(3, 2);
    expect(b.max[0]).toBeCloseTo(50, 2);
    expect(b.max[1]).toBeCloseTo(10, 2);
    const { tree, node, pattern } = await info(next);
    expect(pattern).toMatchObject({ kind: 'linear', axis: 0, countText: '4', spacingText: '15' });
    // The pattern keeps its own translate, so the gizmo moves it as one.
    expect(decomposeNode(tree.rootNode, node)!.transform.translate).toEqual([5, 0, 0]);
  });

  it('linear with a variable count and an expression pitch, then edited', async () => {
    const src = 'n = 3;\nw = 10;\ncube([w, 2, 2]);\n';
    const next = await wrap(src, { kind: 'linear', axis: 1, count: 'n', spacing: 'w + 2' });
    expect(next).toContain('for (i = [0 : n - 1])');
    expect(next).toContain('translate([0, i * (w + 2), 0])');
    const { pattern } = await info(next);
    expect(pattern).toMatchObject({ countText: 'n', spacingText: 'w + 2', axis: 1 });
    const edited = applyEdits(next, [...patternCountEdits(pattern!, '5'), ...patternSpacingEdits(pattern!, '4')]);
    await expectCleanParse(edited);
    expect(edited).toContain('for (i = [0 : 4])');
    expect((await box(edited)).max[1]).toBeCloseTo(18, 2);
  });

  it('circular: 6 copies around Z over the full circle, count edits keep it full', async () => {
    const src = 'translate([20, 0, 0]) cylinder(h = 2, r = 1);\n';
    const next = await wrap(src, { kind: 'circular', axis: 2, count: '6', step: null });
    expect(next).toBe('for (i = [0 : 5])\n    rotate([0, 0, i * 360 / 6])\n    translate([20, 0, 0]) cylinder(h = 2, r = 1);\n');
    const b = await box(next);
    expect(b.min[0]).toBeCloseTo(-21, 1);
    expect(b.max[0]).toBeCloseTo(21, 1);
    const { pattern } = await info(next);
    expect(pattern).toMatchObject({ kind: 'circular', axis: 2, countText: '6', spacingText: null });
    const four = applyEdits(next, patternCountEdits(pattern!, '4'));
    expect(four).toContain('for (i = [0 : 3])');
    expect(four).toContain('i * 360 / 4');
    // Four copies at 90°: the far side along Y now has a copy.
    expect((await box(four)).min[1]).toBeCloseTo(-21, 1);
  });

  it('circular with a fixed step angle', async () => {
    const next = await wrap('translate([10, 0, 0]) cube(1);\n', { kind: 'circular', axis: 2, count: '3', step: '30' });
    expect(next).toContain('rotate([0, 0, i * 30])');
    const { pattern } = await info(next);
    expect(pattern).toMatchObject({ kind: 'circular', spacingText: '30', countText: '3' });
  });

  it('picks a loop variable the part does not already use', async () => {
    const next = await wrap('i = 2;\ncube(i);\n', { kind: 'linear', axis: 0, count: '2', spacing: '5' });
    expect(next).toContain('for (i_2 = [0 : 1])');
    expect((await box(next)).max[0]).toBeCloseTo(7, 2);
  });
});
