// M13 engine checks, rendering through the real engine with the bundled
// BOSL2 (resources/libraries/BOSL2, v2.0.788):
// - the edges= text the tools write selects what BOSL2 itself selects;
// - edge positions read from a call match where the engine puts the solid;
// - cube()/cylinder() converted to cuboid()/cyl() render the same solid;
// - a part that doesn't use BOSL2 renders the same without the include,
//   for every built-in BOSL2 redefines, and for each part of a real file.
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import type { Node } from 'web-tree-sitter';
import { renderScadToMesh } from '../../src/main/scadRender';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bbox, parseStl, triangleCount } from '../helpers/stl';
import { BOSL2_DIR, LIBRARIES_DIR } from '../helpers/paths';
import { parse, parseWithGraph } from '../helpers/parse';
import { EDGES_ALL, edgeName, edgesOf, selectorText } from '../../src/renderer/src/bosl2Edges';
import { readBosl2Part } from '../../src/renderer/src/bosl2Shapes';
import { convertToBosl2 } from '../../src/renderer/src/bosl2Convert';
import { bosl2NamesFromSources, usesBosl2, withoutUnusedBosl2 } from '../../src/renderer/src/bosl2Usage';

const INC = 'include <BOSL2/std.scad>\n';
const render = (source: string) => renderScadToMesh(source, { libraryDirs: [LIBRARIES_DIR] }).then(parseStl);

function volume(g: BufferGeometry): number {
  const p = g.getAttribute('position');
  let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    const [ax, ay, az] = [p.getX(i), p.getY(i), p.getZ(i)];
    const [bx, by, bz] = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
    const [cx, cy, cz] = [p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}

const round = (xs: number[]) => xs.map((x) => Math.round(x * 1000) / 1000 + 0);
async function solid(source: string) {
  const g = await render(source);
  const b = bbox(g);
  return { min: round(b.min), max: round(b.max), volume: Math.round(volume(g) * 100) / 100, triangles: triangleCount(g) };
}

function firstCall(root: Node, name: string): Node {
  return root.descendantsOfType('module_instantiation').find((n) => n?.childForFieldName('name')?.text === name)!;
}

describe('edge selectors the tools write (engine-checked)', () => {
  // A spread of sets: faces, axes, single edges, corners, "all but", odd mixes.
  const sets = [0x00f, 0xf00, 0x00c, 0x0f0 | 0x001, 0xfff & ~0x001, 0x111, 0x248, 0x5a5, 0xc30];
  for (const set of sets) {
    const text = selectorText(set)!;
    const args = [text.edges ? `edges = ${text.edges}` : null, text.except ? `except = ${text.except}` : null].filter(Boolean).join(', ');
    it(`${args || '(all edges)'} rounds the same edges as listing them one by one`, async () => {
      const explicit = `[${edgesOf(set).map(({ axis, i }) => edgeName(axis, i)).join(', ')}]`;
      const ours = await solid(`${INC}$fn = 16; cuboid([30, 20, 10], rounding = 2${args ? `, ${args}` : ''});`);
      const listed = await solid(`${INC}$fn = 16; cuboid([30, 20, 10], rounding = 2, edges = ${explicit});`);
      expect(ours).toEqual(listed);
      // and it is not the unrounded box
      expect(ours.volume).toBeLessThan(6000);
    });
  }
  it('selectorText(EDGES_ALL) is the default', () => {
    expect(selectorText(EDGES_ALL)).toEqual({ edges: null, except: null });
  });
});

describe('edge positions match the rendered solid', () => {
  const cases = [
    'cuboid([30, 20, 10]);',
    'cuboid([30, 20, 10], anchor = BOT + FRONT + LEFT);',
    'cuboid([30, 20, 10], anchor = TOP, spin = 90);',
    'cyl(h = 20, d1 = 10, d2 = 6, $fn = 48);',
    'cyl(l = 12, r = 4, anchor = TOP, $fn = 48);',
    'cyl(12, 4, center = false, $fn = 48);',
    'prismoid([40, 30], [20, 10], h = 15, shift = [5, 0]);',
  ];
  for (const body of cases) {
    it(body, async () => {
      const source = INC + body;
      const tree = await parse(source);
      const name = body.match(/^(\w+)\(/)![1]!;
      const part = readBosl2Part(firstCall(tree.rootNode, name))!;
      expect(part.noGeometry).toBeNull();
      const pts = part.edges.flatMap((e) => e.points!);
      const min = round([0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]!))));
      const max = round([0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]!))));
      const s = await solid(source);
      expect({ min: s.min, max: s.max }).toEqual({ min, max });
    });
  }
});

describe('cube()/cylinder() to cuboid()/cyl() (engine-checked)', () => {
  const cases = [
    'cube(10);',
    'cube([30, 20, 10]);',
    'cube([30, 20, 10], center = true);',
    'cube(size = [4, 5, 6], center = false);',
    'cylinder(h = 10, r = 3, $fn = 24);',
    'cylinder(10, 3, $fn = 24);',
    'cylinder(10, 3, 1, $fn = 24);',
    'cylinder(h = 10, d1 = 8, d2 = 2, center = true, $fn = 30);',
    'cylinder(r = 2, h = 6, center = false, $fn = 12);',
  ];
  for (const body of cases) {
    it(body, async () => {
      const tree = await parse(body);
      const name = body.startsWith('cube') ? 'cube' : 'cylinder';
      const r = convertToBosl2(body, firstCall(tree.rootNode, name));
      if (!r.ok) throw new Error(r.why);
      expect(r.source.startsWith(INC)).toBe(true);
      expect(await solid(r.source)).toEqual(await solid(body));
    });
  }
});

describe('rendering without BOSL2 when a part doesn’t use it (engine-checked)', () => {
  const names = bosl2NamesFromSources(
    readdirSync(BOSL2_DIR)
      .filter((f) => f.endsWith('.scad'))
      .map((f) => readFileSync(path.join(BOSL2_DIR, f), 'utf8')),
  );

  // Every built-in BOSL2 redefines, called with the built-in's own arguments.
  const builtins = [
    'cube([3, 4, 5], true);',
    'sphere(4, $fn = 16);',
    'sphere(d = 6, $fn = 16);',
    'cylinder(10, 3, 1, true, $fn = 16);',
    'polyhedron([[0, 0, 0], [5, 0, 0], [0, 5, 0], [0, 0, 5]], [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]);',
    'linear_extrude(2) square([3, 4], true);',
    'linear_extrude(height = 3, twist = 90, slices = 4, scale = 0.5) circle(2, $fn = 12);',
    'linear_extrude(1) polygon([[0, 0], [4, 0], [0, 3]]);',
    'linear_extrude(1) circle(d = 5, $fn = 10);',
    'linear_extrude(1) text("Hi", 8, "Liberation Sans");',
    'rotate_extrude(270, $fn = 16) translate([4, 0]) square(1);',
    'linear_extrude(1) projection(cut = true) translate([0, 0, -1]) cube(5);',
    'translate([1, 2, 3]) rotate([10, 20, 30]) scale([1, 2, 3]) cube(1);',
    'rotate(45, [0, 0, 1]) mirror([1, 0, 0]) cube([2, 1, 1]);',
    'multmatrix([[1, 0.5, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]) cube(2);',
  ];
  for (const body of builtins) {
    it(body, async () => {
      const source = INC + body;
      const tree = await parse(source);
      expect(usesBosl2(tree, names)).toBe(false);
      const stripped = withoutUnusedBosl2(source, tree, names);
      expect(stripped).not.toMatch(/BOSL2/);
      expect(await solid(stripped)).toEqual(await solid(source));
    });
  }

  it('each part of a mixed file renders the same, and only BOSL2 parts keep the include', async () => {
    const doc = `${INC}w = 20;\nmodule rounded_block(s) { cuboid(s, rounding = 1, $fn = 12); }\nmodule plate(s) { cube([s, s, 2]); }\n` +
      `rounded_block([w, 10, 6]);\ntranslate([30, 0, 0]) plate(w);\ncylinder(h = 5, r = 3, $fn = 20);\ntranslate(5 * UP) cube(2);\n`;
    const { graph } = await parseWithGraph(doc);
    const kept: boolean[] = [];
    for (const node of graph.nodes) {
      const source = `${graph.context}\n${doc.slice(node.startIndex, node.endIndex)}`;
      const tree = await parse(source);
      const stripped = withoutUnusedBosl2(source, tree, names);
      kept.push(stripped === source);
      expect(await solid(stripped)).toEqual(await solid(source));
    }
    expect(kept).toEqual([true, false, false, true]);
  });
});
