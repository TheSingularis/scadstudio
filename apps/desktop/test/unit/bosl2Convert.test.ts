// M13: the text of cube()/cylinder() conversions and of the include they
// add. That the converted call renders the same solid is checked against
// the engine in test/integration/bosl2.test.ts.
import { describe, expect, it } from 'vitest';
import type { Node } from 'web-tree-sitter';
import { expectCleanParse, parse } from '../helpers/parse';
import { addBosl2Include, convertToBosl2, hasBosl2Include } from '../../src/renderer/src/bosl2Convert';

async function convert(source: string, name = source.includes('cylinder(') ? 'cylinder' : 'cube') {
  const tree = await parse(source);
  const call = tree.rootNode.descendantsOfType('module_instantiation').find((n) => n?.childForFieldName('name')?.text === name) as Node;
  return convertToBosl2(source, call);
}

describe('convertToBosl2', () => {
  it('cube: anchors an uncentered cube at its corner', async () => {
    const r = await convert('cube([30, 20, 10]);');
    expect(r.ok && r.source).toBe('include <BOSL2/std.scad>\n\ncuboid([30, 20, 10], anchor = BOT+FRONT+LEFT);');
  });

  it('cube: a centered one needs no anchor; named size stays named', async () => {
    const r = await convert('cube(size = 5, center = true);');
    expect(r.ok && r.source).toBe('include <BOSL2/std.scad>\n\ncuboid(size = 5);');
  });

  it('keeps the rest of the statement, modifiers and transforms as they are', async () => {
    const src = '// part\nuse <x.scad>\n\ntranslate([1, 2, 3]) #cube(4, $fn = 8); // note\n';
    const r = await convert(src);
    expect(r.ok && r.source).toBe('// part\nuse <x.scad>\ninclude <BOSL2/std.scad>\n\ntranslate([1, 2, 3]) #cuboid(4, anchor = BOT+FRONT+LEFT, $fn = 8); // note\n');
    if (r.ok) await expectCleanParse(r.source);
  });

  it('cylinder: positional becomes named, and the base stays on z=0', async () => {
    const r = await convert('cylinder(10, 3, 1, $fn = 24);');
    expect(r.ok && r.source).toBe('include <BOSL2/std.scad>\n\ncyl(h = 10, r1 = 3, r2 = 1, anchor = BOT, $fn = 24);');
  });

  it('cylinder: center is passed through (cyl takes it with the same meaning)', async () => {
    const r = await convert('cylinder(h = 4, d = 2, center = c);');
    expect(r.ok && r.source).toBe('include <BOSL2/std.scad>\n\ncyl(h = 4, d = 2, center = c);');
  });

  it('refuses a cube whose center is an expression', async () => {
    const r = await convert('cube(5, center = flag);');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/center is an expression/);
  });

  it('does not add a second include', async () => {
    const r = await convert('include <BOSL2/std.scad>\ncube(1);');
    expect(r.ok && r.source).toBe('include <BOSL2/std.scad>\ncuboid(1, anchor = BOT+FRONT+LEFT);');
  });
});

describe('addBosl2Include', () => {
  it('turns a use of BOSL2 (which can’t work) into an include', () => {
    expect(addBosl2Include('use <BOSL2/std.scad>\ncube(1);')).toBe('include <BOSL2/std.scad>\ncube(1);');
  });
  it('recognises an existing include written with backslashes or spaces', () => {
    expect(hasBosl2Include('include < BOSL2\\std.scad >')).toBe(true);
  });
});
