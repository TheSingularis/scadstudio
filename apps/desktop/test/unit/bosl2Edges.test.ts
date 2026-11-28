// M13: BOSL2 edge selectors, read and written. The ordering and the
// face/edge/corner rules are BOSL2's own (_edge_set in attachments.scad);
// test/integration/bosl2.test.ts checks what the engine does with them.
import { describe, expect, it } from 'vitest';
import {
  BOSL2_DIRECTIONS as D,
  EDGES_ALL,
  edgeBit,
  edgeCount,
  edgeName,
  edgeOffset,
  resolveEdges,
  selectorSet,
  selectorText,
  type Vec3,
} from '../../src/renderer/src/bosl2Edges';

const add = (...vs: Vec3[]): Vec3 => vs.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0] as Vec3);
const names = (set: number) => {
  const out: string[] = [];
  for (let axis = 0; axis < 3; axis++) for (let i = 0; i < 4; i++) if (set & edgeBit(axis, i)) out.push(edgeName(axis, i));
  return out.sort();
};

describe('BOSL2 edge order', () => {
  it('matches EDGE_OFFSETS', () => {
    expect([0, 1, 2, 3].map((i) => edgeOffset(0, i))).toEqual([
      [0, -1, -1],
      [0, 1, -1],
      [0, -1, 1],
      [0, 1, 1],
    ]);
    expect([0, 1, 2, 3].map((i) => edgeOffset(2, i))).toEqual([
      [-1, -1, 0],
      [1, -1, 0],
      [-1, 1, 0],
      [1, 1, 0],
    ]);
    expect(edgeName(0, 2)).toBe('TOP+FRONT');
    expect(edgeName(2, 0)).toBe('FRONT+LEFT');
  });
});

describe('selectorSet', () => {
  it('reads strings, faces, edges and corners', () => {
    expect(selectorSet('Z')).toBe(0xf00);
    expect(selectorSet('ALL')).toBe(EDGES_ALL);
    expect(selectorSet('NONE')).toBe(0);
    expect(names(selectorSet(D.TOP!)!)).toEqual(['TOP+BACK', 'TOP+FRONT', 'TOP+LEFT', 'TOP+RIGHT']);
    expect(names(selectorSet(add(D.TOP!, D.FRONT!))!)).toEqual(['TOP+FRONT']);
    expect(names(selectorSet(add(D.TOP!, D.FRONT!, D.LEFT!))!)).toEqual(['FRONT+LEFT', 'TOP+FRONT', 'TOP+LEFT']);
  });

  it('unions a list, and takes an edge array as it is', () => {
    expect(edgeCount(selectorSet([D.TOP!, 'Z'])!)).toBe(8);
    expect(selectorSet([])).toBe(0);
    expect(selectorSet([[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]])).toBe(edgeBit(0, 0) | edgeBit(2, 3));
  });

  it('rejects what BOSL2 asserts on', () => {
    expect(selectorSet('Q')).toBeNull();
    expect(selectorSet([0, 0, 0])).toBeNull();
    expect(selectorSet([0, 0, 2])).toBeNull();
    expect(selectorSet(5)).toBeNull();
  });

  it('applies except after edges, with cuboid defaults', () => {
    expect(resolveEdges(undefined, undefined)).toBe(EDGES_ALL);
    expect(edgeCount(resolveEdges(undefined, D.BOT)!)).toBe(8);
    expect(names(resolveEdges([D.TOP!, 'Z'], [D.BACK!])!)).toEqual(['FRONT+LEFT', 'FRONT+RIGHT', 'TOP+FRONT', 'TOP+LEFT', 'TOP+RIGHT']);
  });
});

describe('selectorText', () => {
  const roundTrip = (set: number) => {
    const t = selectorText(set);
    if (!t) return null;
    // Re-read the text the way the engine would, with the constants.
    const evalText = (s: string | null): unknown => {
      if (s === null) return undefined;
      const js = s.replace(/[A-Z]+(\+[A-Z]+)*/g, (m) => (m === 'X' || m === 'Y' || m === 'Z' ? m : JSON.stringify(add(...m.split('+').map((n) => D[n]!)))));
      return JSON.parse(js);
    };
    return resolveEdges(evalText(t.edges) as never, evalText(t.except) as never);
  };

  it('writes the shortest selector', () => {
    expect(selectorText(EDGES_ALL)).toEqual({ edges: null, except: null });
    expect(selectorText(0)).toBeNull();
    expect(selectorText(selectorSet(D.TOP!)!)).toEqual({ edges: 'TOP', except: null });
    expect(selectorText(0xf00)).toEqual({ edges: '"Z"', except: null });
    expect(selectorText(edgeBit(0, 2))).toEqual({ edges: 'TOP+FRONT', except: null });
    expect(selectorText(edgeBit(0, 2) | edgeBit(0, 3))).toEqual({ edges: '[TOP+FRONT, TOP+BACK]', except: null });
    // TOP and "Z" together are every edge but the bottom four.
    expect(selectorText(selectorSet([D.TOP!, 'Z'])!)).toEqual({ edges: null, except: 'BOT' });
    expect(selectorText(selectorSet([D.TOP!, add(D.FRONT!, D.LEFT!)])!)).toEqual({ edges: '[TOP, FRONT+LEFT]', except: null });
    expect(selectorText(EDGES_ALL & ~edgeBit(0, 0))).toEqual({ edges: null, except: 'BOT+FRONT' });
  });

  it('round-trips every one of the 4096 edge sets', () => {
    for (let set = 1; set <= EDGES_ALL; set++) expect(roundTrip(set)).toBe(set);
  });
});
