// M13: the edges of a BOSL2 shape, read from its call, and the argument
// edits that round or chamfer some of them.
//
// BOSL2 has no "fillet this edge of any solid" operation. What it has is
// rounding/chamfer parameters on its own shapes, and those are what the
// Fillet and Chamfer tools edit:
// - cuboid(size, rounding= | chamfer=, edges=, except=): any of the 12
//   edges, but one treatment and one size for all of them (BOSL2 asserts
//   that rounding and chamfer aren't both given);
// - cyl(h, r, ...): the bottom and top rims, each on its own
//   (rounding1/rounding2, chamfer1/chamfer2, or rounding/chamfer for both);
// - prismoid(size1, size2, h, ...): the four vertical-ish edges, as a
//   scalar or a 4-list in BOSL2's corner order [X+Y+, X-Y+, X-Y-, X+Y-].
// Everything is read from the call's own arguments with the M11 expression
// evaluator, with BOSL2's direction constants (TOP, FRONT, ...) in scope,
// so `cuboid([w, d, h], rounding=r, edges=TOP)` works with variables.
//
// Edge positions (for drawing pickable edges in the viewport) are in the
// call's own coordinates: after its anchor= and spin=, before any outer
// transform (the viewport applies the node's frame, as for every part).
// When the app can't work them out (an orient= other than UP, an anchor
// it doesn't model, a size that isn't evaluable) the edges are still
// listed, with `points: null`, so the tool can offer checkboxes instead.

import type { Node } from 'web-tree-sitter';
import { BOSL2_DIRECTIONS, BOSL2_EDGE_ARRAYS, edgeBit, edgeName, edgeOffset, resolveEdges, selectorText, type EdgeSet, type Vec3 } from './bosl2Edges';
import { Scope, scopeAt, tryEvaluate, type Value } from './scadExpr';

export type Bosl2Shape = 'cuboid' | 'cyl' | 'prismoid';
export type TreatmentKind = 'rounding' | 'chamfer';

export interface Treatment {
  kind: TreatmentKind;
  /** The size as written (an expression is kept as text). */
  sizeText: string;
}

export interface PartEdge {
  /** Stable within the shape: "TOP+FRONT", "FRONT+LEFT" (cuboid, prismoid), "bottom"/"top" (cyl). */
  id: string;
  label: string;
  /** A polyline along the edge in the call's coordinates, or null when it can't be worked out. */
  points: Vec3[] | null;
  treatment: Treatment | null;
}

export interface Bosl2Part {
  shape: Bosl2Shape;
  call: Node;
  edges: PartEdge[];
  /**
   * cuboid: every rounded edge shares one kind and size, so changing the
   * size or kind applies to all of them (the tool says so).
   */
  sharedTreatment: boolean;
  /** Why edge positions are unknown, when they are. */
  noGeometry: string | null;
}

// ---------------------------------------------------------------- arguments

export interface CallArgument {
  name: string | null;
  /** The argument node (name = value, or the bare value). */
  node: Node;
  value: Node;
}

/** The arguments of a module_instantiation, in order. */
export function callArguments(call: Node): CallArgument[] {
  const list = call.childForFieldName('arguments');
  const argsNode = list?.namedChild(0);
  if (!argsNode || argsNode.type !== 'arguments') return [];
  const out: CallArgument[] = [];
  for (const argument of argsNode.namedChildren) {
    if (!argument) continue;
    const value = argument.childForFieldName('value') ?? argument.child(0);
    if (!value) continue;
    out.push({ name: argument.childForFieldName('name')?.text ?? null, node: argument, value });
  }
  return out;
}

// Positional parameter order, from each module's definition (v2.0.788).
export const BOSL2_SIGNATURES: Record<Bosl2Shape, string[]> = {
  cuboid: ['size', 'p1', 'p2', 'chamfer', 'rounding', 'edges', 'except', 'except_edges', 'trimcorners', 'teardrop', 'clip_angle', 'anchor', 'spin', 'orient'],
  cyl: ['h', 'r', 'r2', 'center', 'l', 'r1', 'd', 'd1', 'd2', 'length', 'height', 'chamfer', 'chamfer1', 'chamfer2', 'chamfang', 'chamfang1', 'chamfang2', 'rounding', 'rounding1', 'rounding2'],
  prismoid: ['size1', 'size2', 'h', 'shift', 'xang', 'yang', 'rounding', 'rounding1', 'rounding2', 'chamfer', 'chamfer1', 'chamfer2', 'l', 'height', 'length', 'center', 'anchor', 'spin', 'orient'],
};

/** Each argument bound to its parameter name (positional ones by the signature). */
export function bindArguments(args: CallArgument[], signature: string[]): Map<string, CallArgument> {
  const bound = new Map<string, CallArgument>();
  let position = 0;
  for (const a of args) {
    if (a.name !== null) bound.set(a.name, a);
    else {
      const name = signature[position++];
      if (name) bound.set(name, a);
    }
  }
  return bound;
}

/** The scope an argument of `call` is evaluated in, with BOSL2's constants where the file doesn't define them. */
export function bosl2Scope(call: Node): Scope {
  const base = scopeAt(call);
  const scope = new Scope(base);
  const constants: Record<string, Value> = { ...BOSL2_DIRECTIONS, ...BOSL2_EDGE_ARRAYS };
  for (const [name, value] of Object.entries(constants)) {
    try {
      base.lookup(name, 0);
    } catch {
      scope.setValue(name, value);
    }
  }
  return scope;
}

function valueOf(arg: CallArgument | undefined, scope: Scope): { ok: true; value: Value } | { ok: false } {
  if (!arg) return { ok: true, value: undefined };
  const r = tryEvaluate(arg.value, scope);
  return r.ok ? r : { ok: false };
}

const isNum = (v: Value): v is number => typeof v === 'number' && Number.isFinite(v);

function vec3Of(v: Value): Vec3 | null {
  if (isNum(v)) return [v, v, v];
  if (Array.isArray(v) && v.length === 3 && v.every(isNum)) return v as Vec3;
  return null;
}

function vec2Of(v: Value): [number, number] | null {
  if (isNum(v)) return [v, v];
  if (Array.isArray(v) && v.length === 2 && v.every(isNum)) return v as [number, number];
  return null;
}

function rotateZ(p: Vec3, deg: number): Vec3 {
  if (deg === 0) return p;
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const r = (n: number) => Math.round(n * 1e9) / 1e9 + 0;
  return [r(p[0] * c - p[1] * s), r(p[0] * s + p[1] * c), p[2]];
}

/** spin= and orient= as the app models them: any spin, orient UP only. */
function placement(bound: Map<string, CallArgument>, scope: Scope): { spin: number } | { why: string } {
  const spin = valueOf(bound.get('spin'), scope);
  const orient = valueOf(bound.get('orient'), scope);
  if (!spin.ok || !orient.ok) return { why: 'its spin or orient is an expression the app can’t work out' };
  if (spin.value !== undefined && !isNum(spin.value)) return { why: 'its spin isn’t a single angle' };
  if (orient.value !== undefined) {
    const o = vec3Of(orient.value);
    if (!o || o[0] !== 0 || o[1] !== 0 || o[2] <= 0) return { why: 'it is reoriented (orient=)' };
  }
  return { spin: (spin.value as number | undefined) ?? 0 };
}

function treatmentFrom(bound: Map<string, CallArgument>, name: string, kind: TreatmentKind): Treatment | null {
  const arg = bound.get(name);
  if (!arg) return null;
  const text = arg.value.text.trim();
  if (text === 'undef' || text === '0') return null;
  return { kind, sizeText: text };
}

// -------------------------------------------------------------------- read

/** The call name if `call` is one of the BOSL2 shapes the tools edit. */
export function bosl2ShapeOf(call: Node): Bosl2Shape | null {
  if (call.type !== 'module_instantiation') return null;
  const name = call.childForFieldName('name')?.text;
  return name === 'cuboid' || name === 'cyl' || name === 'prismoid' ? name : null;
}

export function readBosl2Part(call: Node): Bosl2Part | null {
  const shape = bosl2ShapeOf(call);
  if (!shape) return null;
  const bound = bindArguments(callArguments(call), BOSL2_SIGNATURES[shape]);
  const scope = bosl2Scope(call);
  if (shape === 'cuboid') return readCuboid(call, bound, scope);
  if (shape === 'cyl') return readCyl(call, bound, scope);
  return readPrismoid(call, bound, scope);
}

function readCuboid(call: Node, bound: Map<string, CallArgument>, scope: Scope): Bosl2Part | null {
  const rounding = treatmentFrom(bound, 'rounding', 'rounding');
  const chamfer = treatmentFrom(bound, 'chamfer', 'chamfer');
  const treatment = rounding ?? chamfer;
  // Which edges the treatment is on. An edges= the app can't read means it
  // can't say which are rounded, so the part isn't offered at all rather
  // than shown wrong.
  let treated: EdgeSet = 0;
  if (treatment) {
    const edges = valueOf(bound.get('edges'), scope);
    const except = valueOf(bound.get('except'), scope);
    const legacy = valueOf(bound.get('except_edges'), scope);
    if (!edges.ok || !except.ok || !legacy.ok) return null;
    const exceptValue = except.value ?? legacy.value;
    const set = resolveEdges(edges.value, exceptValue);
    if (set === null) return null;
    treated = set;
  }

  let noGeometry: string | null = null;
  let size: Vec3 | null = null;
  let center: Vec3 = [0, 0, 0];
  let spin = 0;
  if (bound.has('p1') || bound.has('p2')) noGeometry = 'it is given by corners (p1, p2)';
  else {
    const s = valueOf(bound.get('size'), scope);
    size = s.ok ? vec3Of(s.value ?? 1) : null;
    if (!size) noGeometry = 'its size is an expression the app can’t work out';
  }
  const anchor = valueOf(bound.get('anchor'), scope);
  const a = anchor.ok ? vec3Of(anchor.value ?? [0, 0, 0]) : null;
  if (!noGeometry && !a) noGeometry = 'its anchor is an expression the app can’t work out';
  const place = placement(bound, scope);
  if (!noGeometry && 'why' in place) noGeometry = place.why;
  if (!noGeometry && size && a && 'spin' in place) {
    center = [(-a[0] * size[0]) / 2, (-a[1] * size[1]) / 2, (-a[2] * size[2]) / 2];
    spin = place.spin;
  }

  const edges: PartEdge[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < 4; i++) {
      const name = edgeName(axis, i);
      let points: Vec3[] | null = null;
      if (!noGeometry && size) {
        const o = edgeOffset(axis, i);
        const mid: Vec3 = [center[0] + (o[0] * size[0]) / 2, center[1] + (o[1] * size[1]) / 2, center[2] + (o[2] * size[2]) / 2];
        const lo: Vec3 = [...mid];
        const hi: Vec3 = [...mid];
        lo[axis] -= size[axis] / 2;
        hi[axis] += size[axis] / 2;
        points = [rotateZ(lo, spin), rotateZ(hi, spin)];
      }
      edges.push({ id: name, label: name, points, treatment: treated & edgeBit(axis, i) ? treatment : null });
    }
  }
  return { shape: 'cuboid', call, edges, sharedTreatment: true, noGeometry };
}

const RIM_SEGMENTS = 48;

function circle(r: number, z: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let k = 0; k <= RIM_SEGMENTS; k++) {
    const t = (2 * Math.PI * k) / RIM_SEGMENTS;
    pts.push([Math.round(r * Math.cos(t) * 1e6) / 1e6 + 0, Math.round(r * Math.sin(t) * 1e6) / 1e6 + 0, z]);
  }
  return pts;
}

/** BOSL2's get_radius(r1, r, d1, d, dflt=1) for one end of a cyl. */
function radius(r1: Value, r: Value, d1: Value, d: Value): number | null {
  for (const [v, half] of [
    [r1, false],
    [d1, true],
    [r, false],
    [d, true],
  ] as const) {
    if (v === undefined) continue;
    return isNum(v) ? (half ? v / 2 : v) : null;
  }
  return 1;
}

function readCyl(call: Node, bound: Map<string, CallArgument>, scope: Scope): Bosl2Part {
  const rim = (end: 1 | 2): Treatment | null =>
    treatmentFrom(bound, `rounding${end}`, 'rounding') ??
    treatmentFrom(bound, `chamfer${end}`, 'chamfer') ??
    treatmentFrom(bound, 'rounding', 'rounding') ??
    treatmentFrom(bound, 'chamfer', 'chamfer');

  let noGeometry: string | null = null;
  const get = (name: string) => valueOf(bound.get(name), scope);
  const vals = Object.fromEntries(['h', 'l', 'length', 'height', 'r', 'r1', 'r2', 'd', 'd1', 'd2', 'center', 'anchor', 'shift'].map((n) => [n, get(n)]));
  if (Object.values(vals).some((v) => !v.ok)) noGeometry = 'its size is an expression the app can’t work out';
  const v = (n: string) => (vals[n]!.ok ? (vals[n] as { value: Value }).value : undefined);
  const length = v('l') ?? v('h') ?? v('length') ?? v('height') ?? 1;
  // A legacy cyl(h, r, center) passes the boolean as r2.
  const legacyCenter = typeof v('r2') === 'boolean';
  const r1 = radius(v('r1'), v('r'), v('d1'), v('d'));
  const r2 = radius(legacyCenter ? undefined : v('r2'), v('r'), v('d2'), v('d'));
  const centerFlag = legacyCenter ? v('r2') : v('center');
  if (!noGeometry && (!isNum(length) || r1 === null || r2 === null)) noGeometry = 'its size is an expression the app can’t work out';
  const shift = v('shift');
  if (!noGeometry && shift !== undefined && !(vec2Of(shift)?.every((x) => x === 0) ?? false)) noGeometry = 'it is sheared (shift=)';
  // get_anchor(anchor, center, BOT, CENTER)
  let anchorZ = 0;
  if (centerFlag === true) anchorZ = 0;
  else if (centerFlag === false) anchorZ = -1;
  else {
    const a = vec3Of(v('anchor') ?? [0, 0, 0]);
    if (!a) noGeometry ??= 'its anchor is an expression the app can’t work out';
    else if (a[0] !== 0 || a[1] !== 0) noGeometry ??= 'its anchor is off the axis';
    else anchorZ = a[2];
  }
  const place = placement(bound, scope);
  if ('why' in place) noGeometry ??= place.why;

  let bottom: Vec3[] | null = null;
  let top: Vec3[] | null = null;
  if (!noGeometry && isNum(length) && r1 !== null && r2 !== null) {
    const c = (-anchorZ * length) / 2;
    bottom = circle(r1, c - length / 2);
    top = circle(r2, c + length / 2);
  }
  return {
    shape: 'cyl',
    call,
    edges: [
      { id: 'bottom', label: 'Bottom rim', points: bottom, treatment: rim(1) },
      { id: 'top', label: 'Top rim', points: top, treatment: rim(2) },
    ],
    sharedTreatment: false,
    noGeometry,
  };
}

// BOSL2's corner order for prismoid's per-edge lists: [X+Y+, X-Y+, X-Y-, X+Y-].
const PRISMOID_CORNERS: [number, number][] = [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
];

function prismoidEdgeId([x, y]: [number, number]): string {
  return `${y > 0 ? 'BACK' : 'FRONT'}+${x > 0 ? 'RIGHT' : 'LEFT'}`;
}

/** One corner's entry of a scalar-or-4-list argument, as text. */
function cornerTexts(arg: CallArgument | undefined): (string | null)[] | null {
  if (!arg) return [null, null, null, null];
  const node = arg.value;
  if (node.type === 'list' || node.type === 'vector_expression' || node.text.trim().startsWith('[')) {
    const items = node.namedChildren.filter((c): c is Node => c !== null && c.type !== 'comment');
    if (items.length !== 4) return null;
    return items.map((c) => (c.text.trim() === '0' || c.text.trim() === 'undef' ? null : c.text.trim()));
  }
  const text = node.text.trim();
  const t = text === '0' || text === 'undef' ? null : text;
  return [t, t, t, t];
}

function readPrismoid(call: Node, bound: Map<string, CallArgument>, scope: Scope): Bosl2Part | null {
  const rounding = cornerTexts(bound.get('rounding'));
  const chamfer = cornerTexts(bound.get('chamfer'));
  // Separate top/bottom radii on the vertical edges aren't something the
  // tool can show as one edge's treatment, so such a part isn't offered.
  if (!rounding || !chamfer || ['rounding1', 'rounding2', 'chamfer1', 'chamfer2'].some((n) => bound.has(n))) return null;

  let noGeometry: string | null = null;
  const get = (name: string) => valueOf(bound.get(name), scope);
  const s1 = get('size1');
  const s2 = get('size2');
  const hv = [get('h'), get('l'), get('height'), get('length')];
  const sh = get('shift');
  const size1 = s1.ok ? vec2Of(s1.value ?? 1) : null;
  const size2 = s2.ok ? (s2.value === undefined ? size1 : vec2Of(s2.value)) : null;
  const hFirst = hv.find((x) => !x.ok || x.value !== undefined);
  const h = hFirst === undefined ? 1 : hFirst.ok && isNum(hFirst.value) ? hFirst.value : null;
  const shiftValue = sh.ok ? (sh.value ?? [0, 0]) : null;
  const shift = Array.isArray(shiftValue) && shiftValue.length === 2 ? (shiftValue.map((x) => (x === undefined ? 0 : x)) as Value[]) : null;
  if (!size1 || !size2 || h === null || !shift || !shift.every(isNum)) noGeometry = 'its size is an expression the app can’t work out';
  if (bound.has('xang') || bound.has('yang')) noGeometry ??= 'its top is given by angles (xang/yang)';
  const anchor = get('anchor');
  const center = get('center');
  const a = anchor.ok ? vec3Of(anchor.value ?? [0, 0, -1]) : null;
  if (!a || !(a[0] === 0 && a[1] === 0 && a[2] === -1) || (center.ok && center.value === true) || !center.ok) noGeometry ??= 'its anchor isn’t the default (bottom)';
  const place = placement(bound, scope);
  if ('why' in place) noGeometry ??= place.why;

  const edges: PartEdge[] = PRISMOID_CORNERS.map((corner, k) => {
    const id = prismoidEdgeId(corner);
    let points: Vec3[] | null = null;
    if (!noGeometry && size1 && size2 && h !== null && shift && 'spin' in place) {
      const [sx, sy] = shift as [number, number];
      const lo: Vec3 = [(corner[0] * size1[0]) / 2, (corner[1] * size1[1]) / 2, 0];
      const hi: Vec3 = [sx + (corner[0] * size2[0]) / 2, sy + (corner[1] * size2[1]) / 2, h];
      points = [rotateZ(lo, place.spin), rotateZ(hi, place.spin)];
    }
    const r = rounding[k];
    const c = chamfer[k];
    const treatment: Treatment | null = r ? { kind: 'rounding', sizeText: r } : c ? { kind: 'chamfer', sizeText: c } : null;
    return { id, label: id, points, treatment };
  });
  return { shape: 'prismoid', call, edges, sharedTreatment: false, noGeometry };
}

// ------------------------------------------------------------------- write

/** null removes the argument. */
export type ArgChange = { name: string; value: string | null };

/**
 * Round or chamfer exactly the `selected` edges with `kind`/`sizeText`:
 * selected edges get it; an unselected edge that has this kind loses it;
 * an unselected edge with the other kind keeps it, except on a cuboid,
 * where one treatment covers every edge (choosing Fillet on a chamfered
 * cuboid turns it into a rounded one). An empty selection removes this
 * kind from the part.
 */
export function treatmentChanges(part: Bosl2Part, selected: ReadonlySet<string>, kind: TreatmentKind, sizeText: string): ArgChange[] {
  const final = part.edges.map((e): Treatment | null => {
    if (selected.has(e.id)) return { kind, sizeText };
    if (e.treatment?.kind === kind) return null;
    return part.shape === 'cuboid' ? null : e.treatment;
  });
  if (part.shape === 'cuboid') return cuboidChanges(final, kind, sizeText);
  if (part.shape === 'cyl') return cylChanges(final);
  return prismoidChanges(final);
}

function cuboidChanges(final: (Treatment | null)[], kind: TreatmentKind, sizeText: string): ArgChange[] {
  const other: TreatmentKind = kind === 'rounding' ? 'chamfer' : 'rounding';
  let set: EdgeSet = 0;
  final.forEach((t, k) => {
    if (t) set |= 1 << k;
  });
  const sel = selectorText(set);
  if (!sel) return [kind, other, 'edges', 'except', 'except_edges'].map((name) => ({ name, value: null }));
  return [
    { name: kind, value: sizeText },
    { name: other, value: null },
    { name: 'edges', value: sel.edges },
    { name: 'except', value: sel.except },
    { name: 'except_edges', value: null },
  ];
}

function cylChanges([bottom, top]: (Treatment | null)[]): ArgChange[] {
  const value: Record<string, string | null> = { rounding: null, rounding1: null, rounding2: null, chamfer: null, chamfer1: null, chamfer2: null };
  if (bottom && top && bottom.kind === top.kind && bottom.sizeText === top.sizeText) value[bottom.kind] = bottom.sizeText;
  else {
    if (bottom) value[`${bottom.kind}1`] = bottom.sizeText;
    if (top) value[`${top.kind}2`] = top.sizeText;
  }
  return Object.entries(value).map(([name, v]) => ({ name, value: v }));
}

function prismoidChanges(final: (Treatment | null)[]): ArgChange[] {
  const arg = (kind: TreatmentKind): string | null => {
    const texts = final.map((t) => (t?.kind === kind ? t.sizeText : '0'));
    if (texts.every((t) => t === '0')) return null;
    if (texts.every((t) => t === texts[0])) return texts[0]!;
    return `[${texts.join(', ')}]`;
  };
  return [
    { name: 'rounding', value: arg('rounding') },
    { name: 'chamfer', value: arg('chamfer') },
  ];
}

/**
 * Applies argument changes to `call` with minimal edits: an existing
 * argument's value is replaced in place (named or positional), a missing
 * one is appended as `name = value`, and a removed one is deleted with its
 * comma (a positional one that later positionals depend on becomes undef).
 * An unchanged value is left byte-for-byte as it was.
 */
export function applyArgChanges(source: string, call: Node, signature: string[], changes: ArgChange[]): string {
  const args = callArguments(call);
  const bound = bindArguments(args, signature);
  type Edit = { start: number; end: number; text: string };
  const edits: Edit[] = [];
  const removed = new Set<CallArgument>();
  const appended: string[] = [];
  for (const { name, value } of changes) {
    const arg = bound.get(name);
    if (arg) {
      if (value === null) {
        const positional = arg.name === null;
        const later = args.slice(args.indexOf(arg) + 1).some((a) => a.name === null);
        if (positional && later) {
          if (arg.value.text !== 'undef') edits.push({ start: arg.value.startIndex, end: arg.value.endIndex, text: 'undef' });
        } else removed.add(arg);
      } else if (arg.value.text !== value) {
        edits.push({ start: arg.value.startIndex, end: arg.value.endIndex, text: value });
      }
    } else if (value !== null) appended.push(`${name} = ${value}`);
  }
  // Deleting an argument takes the comma before it (or after it, for the
  // first argument), so the list stays well formed.
  const kept = args.filter((a) => !removed.has(a));
  for (const arg of removed) {
    const k = args.indexOf(arg);
    const prev = args[k - 1];
    const next = args[k + 1];
    if (prev && !removed.has(prev)) edits.push({ start: prev.node.endIndex, end: arg.node.endIndex, text: '' });
    else if (next) edits.push({ start: arg.node.startIndex, end: next.node.startIndex, text: '' });
    else if (prev) edits.push({ start: prev.node.endIndex, end: arg.node.endIndex, text: '' });
    else edits.push({ start: arg.node.startIndex, end: arg.node.endIndex, text: '' });
  }
  if (appended.length > 0) {
    const lastKept = kept[kept.length - 1];
    if (lastKept) edits.push({ start: lastKept.node.endIndex, end: lastKept.node.endIndex, text: `, ${appended.join(', ')}` });
    else {
      const list = call.childForFieldName('arguments')!;
      const close = list.child(list.childCount - 1);
      const at = close?.type === ')' && !close.isMissing ? close.startIndex : list.endIndex;
      edits.push({ start: at, end: at, text: appended.join(', ') });
    }
  }
  return applyEdits(source, edits);
}

function applyEdits(source: string, edits: { start: number; end: number; text: string }[]): string {
  // Overlapping deletions (two neighbours removed) are merged by taking
  // the union of their ranges.
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number; text: string }[] = [];
  for (const e of sorted) {
    const last = merged[merged.length - 1];
    if (last && e.start < last.end) {
      last.end = Math.max(last.end, e.end);
      last.text += e.text;
    } else merged.push({ ...e });
  }
  let out = source;
  for (let k = merged.length - 1; k >= 0; k--) {
    const e = merged[k]!;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** Convenience: read the part, change it, write it. */
export function writeTreatment(source: string, part: Bosl2Part, selected: ReadonlySet<string>, kind: TreatmentKind, sizeText: string): string {
  return applyArgChanges(source, part.call, BOSL2_SIGNATURES[part.shape], treatmentChanges(part, selected, kind, sizeText));
}

/** The edges (by id) that currently have `kind`, for preselecting them in the tool. */
export function edgesWith(part: Bosl2Part, kind: TreatmentKind): Set<string> {
  return new Set(part.edges.filter((e) => e.treatment?.kind === kind).map((e) => e.id));
}
