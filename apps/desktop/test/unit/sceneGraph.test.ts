// M3: top-level statements become selectable scene nodes; definitions,
// assignments and use/include become shared render context.
import { describe, expect, it } from 'vitest';
import { parseWithGraph } from '../helpers/parse';

describe('buildSceneGraph (M3)', () => {
  it('splits geometry from context', async () => {
    const source = [
      '// leading comment',
      'use <lib.scad>',
      'include <other.scad>',
      'size = 10;',
      'module m(s) { cube(s); }',
      'function f(x) = x * 2;',
      'm(size);',
      'translate([20,0,0]) sphere(f(2));',
      'for (i = [0:2]) translate([i*5,0,0]) cube(1);',
      'if (size > 5) cylinder(h=1, r=1);',
      '',
    ].join('\n');
    const { graph } = await parseWithGraph(source);
    expect(graph.nodes.map((n) => source.slice(n.startIndex, n.endIndex))).toEqual([
      'm(size);',
      'translate([20,0,0]) sphere(f(2));',
      'for (i = [0:2]) translate([i*5,0,0]) cube(1);',
      'if (size > 5) cylinder(h=1, r=1);',
    ]);
    expect(graph.nodes.map((n) => n.index)).toEqual([0, 1, 2, 3]);
    for (const part of ['use <lib.scad>', 'include <other.scad>', 'size = 10;', 'module m(s)', 'function f(x)']) {
      expect(graph.context).toContain(part);
    }
    expect(graph.context).not.toContain('leading comment');
    expect(graph.context).not.toContain('sphere');
  });

  it('labels are the first 40 source chars, whitespace collapsed', async () => {
    const source = 'translate([0, 0, 10])\n    cylinder(h=20, r=5, $fn=32);';
    const { graph } = await parseWithGraph(source);
    expect(graph.nodes[0].label).toBe('translate([0, 0, 10]) cylinder(h=20,');
  });

  it('byte ranges map back to the exact statement text (selection ↔ text)', async () => {
    const source = 'cube(1);\n\n  sphere(2);  \n/* c */ cylinder(h=1,r=1);\n';
    const { graph } = await parseWithGraph(source);
    expect(graph.nodes.map((n) => source.slice(n.startIndex, n.endIndex))).toEqual(['cube(1);', 'sphere(2);', 'cylinder(h=1,r=1);']);
  });

  it('an empty document has no nodes', async () => {
    const { graph } = await parseWithGraph('');
    expect(graph).toEqual({ nodes: [], context: '' });
  });
});
