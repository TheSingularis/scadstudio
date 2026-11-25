// M9 / PLAN.md risk 5: a remembered node position (a selection, a drill-in
// level) follows its node through an edit of the working set.
import { describe, expect, it } from 'vitest';
import { remapIndex, remapIndices, similarity, type NodeFingerprint } from '../../src/renderer/src/nodeIdentity';

const fp = (text: string): NodeFingerprint => ({ text, kind: /^[%#!*]?(?:\w+\([^)]*\)\s*)*?(\w+)/.exec(text)?.[1] ?? 'unknown' });
const list = (...texts: string[]) => texts.map(fp);

describe('remapIndex (M9 node identity)', () => {
  const before = list('cube(1);', 'sphere(2);', 'cylinder(h=3, r=1);');

  it('an untouched set maps every node to itself', () => {
    for (let i = 0; i < 3; i++) expect(remapIndex(before, before, i)).toBe(i);
  });

  it('follows nodes past an insertion or a deletion before them', () => {
    const inserted = list('square(4);', 'cube(1);', 'sphere(2);', 'cylinder(h=3, r=1);');
    expect(remapIndex(before, inserted, 0)).toBe(1);
    expect(remapIndex(before, inserted, 2)).toBe(3);
    const deleted = list('sphere(2);', 'cylinder(h=3, r=1);');
    expect(remapIndex(before, deleted, 1)).toBe(0);
    expect(remapIndex(before, deleted, 0)).toBeNull();
  });

  it("follows a node whose own text changed (a gizmo or parameter edit)", () => {
    const edited = list('cube(1);', 'translate([5, 0, 0]) sphere(2);', 'cylinder(h=3, r=1);');
    expect(remapIndex(before, edited, 1)).toBe(1);
  });

  it('follows an edited node even when a statement was also inserted before it', () => {
    const after = list('cube(1);', 'square(4);', 'sphere(r=2.5);', 'cylinder(h=3, r=1);');
    expect(remapIndex(before, after, 1)).toBe(2);
  });

  it('an edit in place that changes the call keeps the position when the gap kept its size', () => {
    const after = list('cube(1);', 'circle(7);', 'cylinder(h=3, r=1);');
    expect(remapIndex(before, after, 1)).toBe(1);
  });

  it('half-typed text in front of a node: the more similar statement wins over the one at the same offset', () => {
    const big = 'difference() { cube([20, 20, 20], center=true); translate([0, 0, 8]) cylinder(h=10, r=4, $fn=24); }';
    const b = list(big, 'translate([40, 0, 0]) sphere(r=5);');
    // `cube(1);` typed above it, finished:
    expect(remapIndex(b, list('cube(1);', big, 'translate([40, 0, 0]) sphere(r=5);'), 0)).toBe(1);
    // halfway, `cube difference() {...}` parses as one statement that still contains it:
    expect(remapIndex(b, list(`cube ${big}`, 'translate([40, 0, 0]) sphere(r=5);'), 0)).toBe(0);
  });

  it('identical duplicates are matched in order (the documented ambiguity the confirm-flash covers)', () => {
    const dup = list('cube(1);', 'cube(1);');
    expect(remapIndex(dup, list('cube(1);', 'cube(1);', 'cube(1);'), 1)).toBe(1);
  });

  it('an index out of range maps to nothing', () => {
    expect(remapIndex(before, before, 7)).toBeNull();
    expect(remapIndex(before, [], 0)).toBeNull();
  });

  it('remapIndices keeps order and drops nodes that are gone', () => {
    expect(remapIndices(before, list('sphere(2);', 'cylinder(h=3, r=1);'), [2, 0, 1])).toEqual([1, 0]);
  });

  it('similarity is 1 for equal text and low for unrelated text', () => {
    expect(similarity('cube(1);', 'cube(1);')).toBe(1);
    expect(similarity('cube(1);', 'polygon(points=[[0,0],[1,0],[0,1]]);')).toBeLessThan(0.35);
  });
});
