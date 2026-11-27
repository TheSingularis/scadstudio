// M13: BOSL2's edge selectors, as a set of a box's 12 edges.
//
// BOSL2 rounds or chamfers the edges of its own shapes through an `edges=`
// argument (and `except=`), e.g. `cuboid([30,20,10], rounding=2,
// edges=[TOP+FRONT, "Z"])`. This file reads such a selector into a set of
// edges, and writes a set back as the shortest selector that means exactly
// that set, so a Fillet/Chamfer tool can show which edges are rounded and
// change them without the user knowing BOSL2's syntax.
//
// The semantics are copied from BOSL2's own `_edge_set()` and `_edges()`
// (attachments.scad, v2.0.788), not from its docs:
// - edges are grouped by the axis they run along (X, Y, Z), four per axis,
//   ordered as `for (b=[-1,1], a=[-1,1])` with the edge's off-axis offset
//   `[[0,a,b],[a,0,b],[a,b,0]][axis]` (BOSL2's EDGE_OFFSETS);
// - a string selects by axis ("X", "Y", "Z") or "ALL"/"NONE";
// - a vector with one nonzero component is a face (its four edges), two is
//   one edge, three is a corner (the three edges that meet there);
// - a 3x4 edge array is used as it is;
// - a list is the union of its items, and `except` is removed after.
// test/unit/bosl2Edges.test.ts pins the ordering, and the integration test
// renders selectors through the engine.

import type { Value } from './scadExpr';

export type Vec3 = [number, number, number];

/** Bit `axis * 4 + i` is the i-th edge along `axis`, in BOSL2's order. */
export type EdgeSet = number;

export const EDGES_ALL: EdgeSet = 0xfff;
export const EDGES_NONE: EdgeSet = 0;

export function edgeBit(axis: number, i: number): EdgeSet {
  return 1 << (axis * 4 + i);
}

/** The off-axis offset of edge i along `axis`, as in BOSL2's EDGE_OFFSETS. */
export function edgeOffset(axis: number, i: number): Vec3 {
  const a = i % 2 === 1 ? 1 : -1;
  const b = i >= 2 ? 1 : -1;
  return ([[0, a, b], [a, 0, b], [a, b, 0]] as Vec3[])[axis]!;
}

export function edgeCount(set: EdgeSet): number {
  let n = 0;
  for (let s = set; s; s &= s - 1) n++;
  return n;
}

export function edgesOf(set: EdgeSet): { axis: number; i: number }[] {
  const out: { axis: number; i: number }[] = [];
  for (let axis = 0; axis < 3; axis++) for (let i = 0; i < 4; i++) if (set & edgeBit(axis, i)) out.push({ axis, i });
  return out;
}

// BOSL2's direction constants (constants.scad). A document that includes
// BOSL2 can use any of these names in a selector.
export const BOSL2_DIRECTIONS: Record<string, Vec3> = {
  LEFT: [-1, 0, 0],
  RIGHT: [1, 0, 0],
  FRONT: [0, -1, 0],
  FWD: [0, -1, 0],
  FORWARD: [0, -1, 0],
  BACK: [0, 1, 0],
  BOTTOM: [0, 0, -1],
  BOT: [0, 0, -1],
  DOWN: [0, 0, -1],
  TOP: [0, 0, 1],
  UP: [0, 0, 1],
  CENTER: [0, 0, 0],
  CTR: [0, 0, 0],
  CENTRE: [0, 0, 0],
};

export const BOSL2_EDGE_ARRAYS: Record<string, Value> = {
  EDGES_ALL: [
    [1, 1, 1, 1],
    [1, 1, 1, 1],
    [1, 1, 1, 1],
  ],
  EDGES_NONE: [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
};

const isNum = (v: Value): v is number => typeof v === 'number';
const isVector3 = (v: Value): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isEdgeArray = (v: Value): v is number[][] =>
  Array.isArray(v) && v.length === 3 && v.every((row) => Array.isArray(row) && row.length === 4 && row.every(isNum));

/** One selector item (not a list of them), or null when BOSL2 would reject it. */
function selectorItem(v: Value): EdgeSet | null {
  if (typeof v === 'string') {
    switch (v) {
      case 'X':
        return 0x00f;
      case 'Y':
        return 0x0f0;
      case 'Z':
        return 0xf00;
      case 'ALL':
        return EDGES_ALL;
      case 'NONE':
        return EDGES_NONE;
      default:
        return null;
    }
  }
  if (isEdgeArray(v)) {
    let set = 0;
    v.forEach((row, axis) => row.forEach((x, i) => (x > 0 ? (set |= edgeBit(axis, i)) : undefined)));
    return set;
  }
  if (isVector3(v)) {
    if (!v.every((x) => x === -1 || x === 0 || x === 1)) return null;
    const nonzero = v.filter((x) => x !== 0).length;
    if (nonzero === 0) return null;
    let set = 0;
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < 4; i++) {
        const o = edgeOffset(axis, i);
        const matches = [0, 1, 2].filter((k) => v[k] !== 0 && v[k] === o[k]).length;
        const hit = nonzero === 2 ? v.every((x, k) => x === o[k]) : nonzero === 1 ? matches === 1 : matches === 2;
        if (hit) set |= edgeBit(axis, i);
      }
    }
    return set;
  }
  return null;
}

/** A whole `edges=`/`except=` value: one item, or a list of items. */
export function selectorSet(v: Value): EdgeSet | null {
  if (Array.isArray(v) && v.length === 0) return EDGES_NONE;
  const single = typeof v === 'string' || isVector3(v) || isEdgeArray(v);
  const items = single ? [v] : Array.isArray(v) ? v : null;
  if (!items) return null;
  let set = 0;
  for (const item of items) {
    const s = selectorItem(item);
    if (s === null) return null;
    set |= s;
  }
  return set;
}

/** BOSL2's `_edges(edges, except)`. Defaults as in cuboid(): all edges, no exceptions. */
export function resolveEdges(edges: Value | undefined, except: Value | undefined): EdgeSet | null {
  const on = edges === undefined ? EDGES_ALL : selectorSet(edges);
  const off = except === undefined ? EDGES_NONE : selectorSet(except);
  if (on === null || off === null) return null;
  return on & ~off & EDGES_ALL;
}

// Writing a set back. Selector items the tool can write, each named the way
// BOSL2's docs write them (Z part first, then Y, then X: TOP+FRONT+LEFT).

interface Candidate {
  text: string;
  set: EdgeSet;
}

function directionName(v: Vec3): string {
  const parts: string[] = [];
  if (v[2]) parts.push(v[2] > 0 ? 'TOP' : 'BOT');
  if (v[1]) parts.push(v[1] > 0 ? 'BACK' : 'FRONT');
  if (v[0]) parts.push(v[0] > 0 ? 'RIGHT' : 'LEFT');
  return parts.join('+');
}

/** How an edge reads in the UI and in source: "TOP+FRONT", "FRONT+LEFT". */
export function edgeName(axis: number, i: number): string {
  return directionName(edgeOffset(axis, i));
}

const CANDIDATES: Candidate[] = (() => {
  const out: Candidate[] = [
    { text: '"X"', set: 0x00f },
    { text: '"Y"', set: 0x0f0 },
    { text: '"Z"', set: 0xf00 },
  ];
  const faces: Vec3[] = [
    [0, 0, 1],
    [0, 0, -1],
    [0, -1, 0],
    [0, 1, 0],
    [-1, 0, 0],
    [1, 0, 0],
  ];
  for (const f of faces) out.push({ text: directionName(f), set: selectorItem(f)! });
  for (let axis = 0; axis < 3; axis++) for (let i = 0; i < 4; i++) out.push({ text: edgeName(axis, i), set: edgeBit(axis, i) });
  for (const z of [1, -1]) for (const y of [-1, 1]) for (const x of [-1, 1]) {
    const v: Vec3 = [x, y, z];
    out.push({ text: directionName(v), set: selectorItem(v)! });
  }
  return out;
})();

/** The fewest selector items whose union is exactly `target` (shortest text on a tie). */
function smallestCover(target: EdgeSet): Candidate[] {
  if (target === 0) return [];
  const usable = CANDIDATES.filter((c) => (c.set & ~target) === 0);
  let best: Candidate[] | null = null;
  const textLength = (cs: Candidate[]) => cs.reduce((n, c) => n + c.text.length, 0);
  const search = (start: number, chosen: Candidate[], union: EdgeSet, limit: number) => {
    if (union === target) {
      if (!best || chosen.length < best.length || (chosen.length === best.length && textLength(chosen) < textLength(best))) best = [...chosen];
      return;
    }
    if (chosen.length >= limit) return;
    for (let k = start; k < usable.length; k++) {
      const c = usable[k]!;
      if ((c.set & ~union) === 0) continue; // adds nothing new
      chosen.push(c);
      search(k + 1, chosen, union | c.set, limit);
      chosen.pop();
    }
  };
  // Covers of up to 4 items are searched exactly (a few thousand
  // combinations); past that, a list of single edges is as short as any.
  for (let limit = 1; limit <= 4 && !best; limit++) search(0, [], 0, limit);
  if (best) return best;
  return edgesOf(target).map(({ axis, i }) => ({ text: edgeName(axis, i), set: edgeBit(axis, i) }));
}

function listText(items: Candidate[]): string {
  return items.length === 1 ? items[0]!.text : `[${items.map((c) => c.text).join(', ')}]`;
}

export interface SelectorText {
  /** The `edges=` text, or null to leave the argument out (all edges). */
  edges: string | null;
  /** The `except=` text, or null for none. */
  except: string | null;
}

/**
 * The shortest `edges=`/`except=` pair for `set`. All edges leaves both
 * out (cuboid's default). An empty set has no selector: the caller removes
 * the rounding instead, so this returns null.
 */
export function selectorText(set: EdgeSet): SelectorText | null {
  set &= EDGES_ALL;
  if (set === EDGES_NONE) return null;
  if (set === EDGES_ALL) return { edges: null, except: null };
  const direct = smallestCover(set);
  const complement = smallestCover(EDGES_ALL & ~set);
  // "All but these" reads well only when it is clearly shorter.
  if (complement.length < direct.length) return { edges: null, except: listText(complement) };
  return { edges: listText(direct), except: null };
}
