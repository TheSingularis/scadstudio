// M13: reading a BOSL2 shape's edges from its call, and the minimal
// argument edits that round or chamfer some of them. Every edit is
// re-parsed (clean parse, then read back to the edges that were asked for).
import { describe, expect, it } from 'vitest';
import type { Node } from 'web-tree-sitter';
import { expectCleanParse, parse } from '../helpers/parse';
import { edgesWith, readBosl2Part, writeTreatment, type Bosl2Part, type TreatmentKind } from '../../src/renderer/src/bosl2Shapes';

const INC = 'include <BOSL2/std.scad>\n';

function firstCall(root: Node, name: string): Node {
  const found = root.descendantsOfType('module_instantiation').find((n) => n?.childForFieldName('name')?.text === name);
  if (!found) throw new Error(`no ${name}() call`);
  return found;
}

async function part(source: string, name = source.match(/(cuboid|cyl|prismoid)\(/)![1]!): Promise<Bosl2Part> {
  const tree = await parse(source);
  const p = readBosl2Part(firstCall(tree.rootNode, name));
  if (!p) throw new Error('not a readable BOSL2 part');
  return p;
}

const treated = (p: Bosl2Part) => Object.fromEntries(p.edges.filter((e) => e.treatment).map((e) => [e.id, `${e.treatment!.kind} ${e.treatment!.sizeText}`]));

async function apply(source: string, ids: string[], kind: TreatmentKind, size: string) {
  const p = await part(source);
  const out = writeTreatment(source, p, new Set(ids), kind, size);
  await expectCleanParse(out);
  return { out, after: await part(out) };
}

describe('cuboid', () => {
  it('reads edges= and except= with BOSL2 constants and the file’s variables', async () => {
    const p = await part(`${INC}r = 2;\ncuboid([30, 20, 10], rounding = r, edges = [TOP, "Z"], except = BACK);`);
    expect(Object.keys(treated(p)).sort()).toEqual(['FRONT+LEFT', 'FRONT+RIGHT', 'TOP+FRONT', 'TOP+LEFT', 'TOP+RIGHT']);
    expect(treated(p)['TOP+FRONT']).toBe('rounding r');
    expect(p.sharedTreatment).toBe(true);
  });

  it('defaults to all edges, and to none without a rounding', async () => {
    expect(Object.keys(treated(await part(`${INC}cuboid(10, chamfer = 1);`)))).toHaveLength(12);
    expect(Object.keys(treated(await part(`${INC}cuboid(10);`)))).toHaveLength(0);
  });

  it('places edges by size and anchor, then spin', async () => {
    const centered = await part(`${INC}cuboid([30, 20, 10]);`);
    expect(centered.edges.find((e) => e.id === 'TOP+FRONT')!.points).toEqual([
      [-15, -10, 5],
      [15, -10, 5],
    ]);
    const anchored = await part(`${INC}cuboid([30, 20, 10], anchor = BOT + FRONT + LEFT);`);
    expect(anchored.edges.find((e) => e.id === 'FRONT+LEFT')!.points).toEqual([
      [0, 0, 0],
      [0, 0, 10],
    ]);
    const spun = await part(`${INC}cuboid([30, 20, 10], spin = 90);`);
    expect(spun.edges.find((e) => e.id === 'TOP+FRONT')!.points).toEqual([
      [10, -15, 5],
      [10, 15, 5],
    ]);
  });

  it('lists edges without positions when it can’t place them', async () => {
    const p = await part(`${INC}cuboid([30, 20, 10], orient = RIGHT);`);
    expect(p.noGeometry).toMatch(/reoriented/);
    expect(p.edges).toHaveLength(12);
    expect(p.edges.every((e) => e.points === null)).toBe(true);
  });

  it('writes the selection as the shortest edges=', async () => {
    const { out, after } = await apply(`${INC}cuboid([30, 20, 10]);`, ['TOP+FRONT', 'TOP+BACK', 'TOP+LEFT', 'TOP+RIGHT'], 'rounding', '2');
    expect(out).toBe(`${INC}cuboid([30, 20, 10], rounding = 2, edges = TOP);`);
    expect(edgesWith(after, 'rounding').size).toBe(4);
  });

  it('edits in place and removes what no longer applies', async () => {
    const src = `${INC}cuboid([30, 20, 10], rounding=2, edges=TOP, anchor=BOT);`;
    const { out } = await apply(src, ['TOP+FRONT'], 'rounding', '3');
    expect(out).toBe(`${INC}cuboid([30, 20, 10], rounding=3, edges=TOP+FRONT, anchor=BOT);`);
    // All edges: edges= goes away (BOSL2's default).
    const all = await part(src);
    const everything = writeTreatment(src, all, new Set(all.edges.map((e) => e.id)), 'rounding', '2');
    expect(everything).toBe(`${INC}cuboid([30, 20, 10], rounding=2, anchor=BOT);`);
    // Nothing selected: the rounding goes away too.
    expect(writeTreatment(src, all, new Set(), 'rounding', '2')).toBe(`${INC}cuboid([30, 20, 10], anchor=BOT);`);
  });

  it('switching kind replaces the other one (BOSL2 allows only one)', async () => {
    const { out } = await apply(`${INC}cuboid(10, chamfer = 1, edges = "Z");`, ['TOP+FRONT'], 'rounding', '1');
    expect(out).toBe(`${INC}cuboid(10, edges = TOP+FRONT, rounding = 1);`);
  });

  it('keeps positional arguments in place', async () => {
    const { out } = await apply(`${INC}cuboid([10, 10, 10], undef, undef, 1);`, ['TOP+FRONT'], 'chamfer', '2');
    expect(out).toBe(`${INC}cuboid([10, 10, 10], undef, undef, 2, edges = TOP+FRONT);`);
  });

  it('does not offer a part whose edges= it can’t read', async () => {
    const tree = await parse(`${INC}cuboid(10, rounding = 1, edges = pick_edges());`);
    expect(readBosl2Part(firstCall(tree.rootNode, 'cuboid'))).toBeNull();
  });
});

describe('cyl', () => {
  it('reads each rim, with rounding= meaning both', async () => {
    expect(treated(await part(`${INC}cyl(h = 20, d = 15, rounding2 = 3);`))).toEqual({ top: 'rounding 3' });
    expect(treated(await part(`${INC}cyl(h = 20, d = 15, rounding = 1, chamfer1 = 2);`))).toEqual({ bottom: 'chamfer 2', top: 'rounding 1' });
  });

  it('places the rims from l/h, r/d and center/anchor', async () => {
    const p = await part(`${INC}cyl(h = 20, d1 = 10, d2 = 6);`);
    expect(p.edges[0]!.points![0]).toEqual([5, 0, -10]);
    expect(p.edges[1]!.points![0]).toEqual([3, 0, 10]);
    const bot = await part(`${INC}cyl(20, 4, center = false);`);
    expect(bot.edges[0]!.points![0]).toEqual([4, 0, 0]);
    expect(bot.edges[1]!.points![0]).toEqual([4, 0, 20]);
    const anchored = await part(`${INC}cyl(l = 10, r = 2, anchor = TOP);`);
    expect(anchored.edges[1]!.points![0]).toEqual([2, 0, 0]);
  });

  it('writes one rim as rounding1/2 and both alike as rounding', async () => {
    const one = await apply(`${INC}cyl(h = 20, d = 15);`, ['top'], 'rounding', '3');
    expect(one.out).toBe(`${INC}cyl(h = 20, d = 15, rounding2 = 3);`);
    const both = await apply(one.out, ['top', 'bottom'], 'rounding', '3');
    expect(both.out).toBe(`${INC}cyl(h = 20, d = 15, rounding = 3);`);
    // A chamfer on the other rim stays.
    const mixed = await apply(`${INC}cyl(h = 20, d = 15, chamfer1 = 1);`, ['top'], 'rounding', '2');
    expect(treated(mixed.after)).toEqual({ bottom: 'chamfer 1', top: 'rounding 2' });
  });
});

describe('prismoid', () => {
  it('reads the four vertical edges, scalar or per corner', async () => {
    expect(Object.keys(treated(await part(`${INC}prismoid([40, 30], [20, 10], h = 15, rounding = 2);`)))).toHaveLength(4);
    expect(treated(await part(`${INC}prismoid([40, 30], [20, 10], h = 15, chamfer = [1, 0, 0, 0]);`))).toEqual({ 'BACK+RIGHT': 'chamfer 1' });
  });

  it('places edges from bottom to the shifted top', async () => {
    const p = await part(`${INC}prismoid([40, 30], [20, 10], h = 15, shift = [5, 0]);`);
    expect(p.edges.find((e) => e.id === 'FRONT+LEFT')!.points).toEqual([
      [-20, -15, 0],
      [-5, -5, 15],
    ]);
  });

  it('writes a per-corner list, or a scalar when all four match', async () => {
    const one = await apply(`${INC}prismoid([40, 30], [20, 10], h = 15);`, ['FRONT+LEFT'], 'rounding', '2');
    expect(one.out).toBe(`${INC}prismoid([40, 30], [20, 10], h = 15, rounding = [0, 0, 2, 0]);`);
    const all = await apply(one.out, ['FRONT+LEFT', 'FRONT+RIGHT', 'BACK+LEFT', 'BACK+RIGHT'], 'rounding', '2');
    expect(all.out).toBe(`${INC}prismoid([40, 30], [20, 10], h = 15, rounding = 2);`);
  });
});
