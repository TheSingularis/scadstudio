// M5 toolbar insertion, M7 extrusion inserts, M7.5 sketch → polygon codegen.
import { describe, expect, it } from 'vitest';
import { appendPrimitive, appendSketchPolygon, type PrimitiveKind } from '../../src/renderer/src/primitives';
import { readSketchProfile } from '../../src/renderer/src/targetedPatch';
import { expectCleanParse } from '../helpers/parse';

const KINDS: PrimitiveKind[] = ['cube', 'sphere', 'cylinder', 'square', 'circle', 'linear_extrude', 'rotate_extrude'];

describe('appendPrimitive (M5/M7)', () => {
  it.each(KINDS)('appends a valid %s statement as a new last node', async (kind) => {
    const before = 'cube(1);\n';
    const out = appendPrimitive(before, kind);
    expect(out.startsWith(before)).toBe(true);
    const parsed = await expectCleanParse(out);
    expect(parsed.graph.nodes).toHaveLength(2);
    expect(out.slice(parsed.graph.nodes[1].startIndex)).toMatch(new RegExp(`^${kind}\\(`));
  });

  it('separates with exactly one blank line', () => {
    expect(appendPrimitive('a();', 'cube')).toBe('a();\n\ncube([10, 10, 10]);\n');
    expect(appendPrimitive('a();\n', 'cube')).toBe('a();\n\ncube([10, 10, 10]);\n');
    expect(appendPrimitive('a();\n\n', 'cube')).toBe('a();\n\ncube([10, 10, 10]);\n');
  });
});

describe('appendSketchPolygon (M7.5)', () => {
  const pts: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 5],
  ];

  it('XY plane at the origin emits a bare polygon', () => {
    expect(appendSketchPolygon('', [0, 0, 0], [0, 0, 0], [pts])).toBe('\n\npolygon(points=[[0, 0], [10, 0], [10, 5]]);\n');
  });

  it('a face plane emits translate then rotate, and reads back as the same sketch', async () => {
    const out = appendSketchPolygon('cube(10);\n', [0, 0, 10], [90, 0, 0], [pts]);
    expect(out).toContain('translate([0, 0, 10]) rotate([90, 0, 0]) polygon(');
    const parsed = await expectCleanParse(out);
    const profile = readSketchProfile(parsed.tree.rootNode, parsed.graph.nodes[1])!;
    expect(profile).toMatchObject({ origin: [0, 0, 10], rotationDeg: [90, 0, 0], loops: [pts] });
  });
});
