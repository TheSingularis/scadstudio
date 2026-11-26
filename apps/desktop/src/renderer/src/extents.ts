import type { Node, Tree } from 'web-tree-sitter';
import { Box3, Matrix4, Vector3, type BufferGeometry } from 'three';
import type { SceneNode } from './sceneGraph';
import { decomposeNode, readModifier, transformToQuaternion, type DecomposedNode } from './targetedPatch';
import { evaluateNumber, scopeAt, tryEvaluate } from './scadExpr';
import { add, constant, fromTerm, scale, term, type Lin } from './linExpr';

// M11: where a part's faces are along an axis, as expressions of the
// source, for the Distance/Align tools (relate.ts) and the pattern's gap
// spacing (pattern.ts).
//
// OpenSCAD can't measure geometry while it runs, so a face position is
// only an expression when the app can derive it from the call itself:
// cube, sphere, cylinder, square and circle, from their own arguments
// (nominal sizes: a $fn=6 cylinder's flats are inside r, as in any CAD
// tool's dimensions), under a translate and an axis-aligned rotate
// (multiples of 90°) and scale. For anything else (a custom module, a
// boolean, text, an extrusion) the part's own size is the measured number
// from its rendered mesh, and the UI says that it won't follow (PLAN.md M11
// decision 3). Its translate is still an expression either way, so a
// related part follows it when it moves.

export type Edge = 'min' | 'center' | 'max';

export interface AxisExtent {
  min: Lin;
  max: Lin;
  // The node's own size along this axis is a measured number.
  measured: boolean;
  // Where the translate component came from, for naming it as a variable.
  translate: { node: Node | null; value: number };
}

export interface SizeSource {
  // The literal argument (or vector component) a face depends on, which
  // the relate tool can name as a variable so the dependent part follows
  // when it changes.
  node: Node;
  suggestedName: string;
}

export interface PartExtents {
  axes: [AxisExtent, AxisExtent, AxisExtent];
  // Literal sizes behind each axis's faces (empty when measured or already
  // expressions).
  sizeSources: [SizeSource[], SizeSource[], SizeSource[]];
  callName: string | null;
  decomposed: DecomposedNode;
}

/** The interval of a primitive's own geometry along local axis j. */
interface LocalInterval {
  lo: Lin;
  hi: Lin;
  sources: SizeSource[];
}

function lin(node: Node): { l: Lin; literal: boolean } {
  if (node.type === 'number') return { l: constant(Number(node.text)), literal: true };
  if (node.type === 'unary_expression' && node.childForFieldName('operand')?.type === 'number') {
    const v = Number(node.childForFieldName('operand')!.text);
    return { l: constant(node.childForFieldName('operator')?.type === 'unary_minus_operator' ? -v : v), literal: true };
  }
  return { l: fromTerm(term(node.text, evaluateNumber(node) ?? NaN)), literal: false };
}

interface Args {
  positional: Node[];
  named: Map<string, Node>;
}

function callArgs(call: Node): Args {
  const list = call.childForFieldName('arguments')?.namedChildren.find((c) => c?.type === 'arguments');
  const positional: Node[] = [];
  const named = new Map<string, Node>();
  for (const arg of list?.namedChildren ?? []) {
    if (!arg || arg.type !== 'argument') continue;
    const name = arg.childForFieldName('name');
    const value = arg.childForFieldName('value') ?? arg.namedChild(0);
    if (!value) continue;
    if (name) named.set(name.text, value);
    else positional.push(value);
  }
  return { positional, named };
}

function arg(a: Args, name: string, position: number): Node | null {
  return a.named.get(name) ?? a.positional[position] ?? null;
}

// center=true/false, or null when it can't be known.
function centerFlag(node: Node | null): boolean | null {
  if (!node) return false;
  const r = tryEvaluate(node, scopeAt(node));
  return r.ok && typeof r.value === 'boolean' ? r.value : null;
}

// Set for the duration of one partExtents call that names literal sizes.
let promoteLiteral: ((node: Node, suggestedName: string) => string) | null = null;

function sized(node: Node, name: string): { l: Lin; sources: SizeSource[] } {
  const { l, literal } = lin(node);
  if (literal && promoteLiteral) return { l: fromTerm(term(promoteLiteral(node, name), l.k)), sources: [{ node, suggestedName: name }] };
  return { l, sources: literal ? [{ node, suggestedName: name }] : [] };
}

function fromSize(size: { l: Lin; sources: SizeSource[] }, center: boolean): LocalInterval {
  return center
    ? { lo: scale(size.l, -0.5), hi: scale(size.l, 0.5), sources: size.sources }
    : { lo: constant(0), hi: size.l, sources: size.sources };
}

function radiusOf(a: Args, rName: string, dName: string, position: number | null, base: string): { l: Lin; sources: SizeSource[] } | null {
  const r = a.named.get(rName) ?? (position !== null ? a.positional[position] : undefined);
  if (r) return sized(r, `${base}_${rName}`);
  const d = a.named.get(dName);
  if (d) {
    const s = sized(d, `${base}_${dName}`);
    return { l: scale(s.l, 0.5), sources: s.sources };
  }
  return null;
}

// Per local axis, or null when the call isn't one the app can size.
function localIntervals(call: Node, base: string): [LocalInterval, LocalInterval, LocalInterval] | null {
  const name = call.childForFieldName('name')?.text;
  if (call.type !== 'module_instantiation' || !name) return null;
  const a = callArgs(call);
  const flat: LocalInterval = { lo: constant(0), hi: constant(0), sources: [] };
  switch (name) {
    case 'cube':
    case 'square': {
      const center = centerFlag(arg(a, 'center', 1));
      if (center === null) return null;
      const sizeNode = arg(a, 'size', 0);
      const dims = name === 'cube' ? 3 : 2;
      const labels = ['width', 'depth', 'height'];
      const per: { l: Lin; sources: SizeSource[] }[] = [];
      if (!sizeNode) {
        for (let j = 0; j < dims; j++) per.push({ l: constant(1), sources: [] });
      } else if (sizeNode.type === 'vector_expression') {
        if (sizeNode.namedChildCount < dims) return null;
        for (let j = 0; j < dims; j++) per.push(sized(sizeNode.namedChild(j)!, `${base}_${labels[j]}`));
      } else {
        const r = tryEvaluate(sizeNode, scopeAt(sizeNode));
        if (r.ok && typeof r.value === 'number') {
          const s = sized(sizeNode, `${base}_size`);
          for (let j = 0; j < dims; j++) per.push(s);
        } else if (r.ok && Array.isArray(r.value) && r.value.length >= dims && sizeNode.type === 'identifier') {
          for (let j = 0; j < dims; j++) {
            const v = r.value[j];
            per.push({ l: fromTerm(term(`${sizeNode.text}[${j}]`, typeof v === 'number' ? v : NaN)), sources: [] });
          }
        } else {
          return null;
        }
      }
      const out = per.map((s) => fromSize(s, center)) as LocalInterval[];
      if (dims === 2) out.push(flat);
      return out as [LocalInterval, LocalInterval, LocalInterval];
    }
    case 'sphere':
    case 'circle': {
      const r = radiusOf(a, 'r', 'd', 0, base) ?? { l: constant(1), sources: [] };
      const around: LocalInterval = { lo: scale(r.l, -1), hi: r.l, sources: r.sources };
      return name === 'sphere' ? [around, around, around] : [around, around, flat];
    }
    case 'cylinder': {
      const center = centerFlag(arg(a, 'center', 3));
      if (center === null) return null;
      const hNode = arg(a, 'h', 0);
      const h = hNode ? sized(hNode, `${base}_h`) : { l: constant(1), sources: [] };
      let r = radiusOf(a, 'r', 'd', null, base);
      if (!r) {
        // r1/r2 (or d1/d2): the wider end decides the footprint.
        const r1 = radiusOf(a, 'r1', 'd1', 1, base);
        const r2 = radiusOf(a, 'r2', 'd2', 2, base);
        if (r1 && r2) {
          const v1 = r1.l.terms.length === 0 ? r1.l.k : NaN;
          const v2 = r2.l.terms.length === 0 ? r2.l.k : NaN;
          if (Number.isNaN(v1) || Number.isNaN(v2)) {
            r = { l: fromTerm(term(`max(${a.named.get('r1')?.text ?? a.positional[1]?.text ?? '1'}, ${a.named.get('r2')?.text ?? a.positional[2]?.text ?? '1'})`, NaN)), sources: [] };
          } else {
            r = v1 >= v2 ? r1 : r2;
          }
        } else {
          r = r1 ?? r2 ?? { l: constant(1), sources: [] };
        }
      }
      const around: LocalInterval = { lo: scale(r.l, -1), hi: r.l, sources: r.sources };
      return [around, around, fromSize(h, center)];
    }
    default:
      return null;
  }
}

/** The node's rotate+scale as a signed axis permutation, or null when not axis-aligned. */
function axisMap(d: DecomposedNode): { from: number; sign: number; scale: number }[] | null {
  const m = new Matrix4().compose(new Vector3(), transformToQuaternion(d.transform.rotateDeg), new Vector3(...d.transform.scale));
  const e = m.elements; // column-major
  const out: { from: number; sign: number; scale: number }[] = [];
  for (let k = 0; k < 3; k++) {
    // Row k: world axis k gets local axis j times e[j*4+k].
    let found: { from: number; sign: number; scale: number } | null = null;
    for (let j = 0; j < 3; j++) {
      const v = e[j * 4 + k];
      if (Math.abs(v) < 1e-9) continue;
      if (found) return null;
      found = { from: j, sign: Math.sign(v), scale: Math.abs(v) };
    }
    if (!found) return null;
    out.push(found);
  }
  return out;
}

function baseName(call: Node | null): string {
  return call?.childForFieldName('name')?.text ?? 'part';
}

/**
 * The node's faces along each axis of its working set. `measure` gives the
 * box of the node's rendered geometry with its rotate/scale applied but not
 * its translate (geometryBox below), used when the call can't be sized.
 */
export function partExtents(
  tree: Tree,
  node: SceneNode,
  measure: () => { min: number[]; max: number[] } | null,
  // Names a literal size as a variable (the relate tool's "follow"): the
  // size then appears in the faces as that name.
  promote: ((node: Node, suggestedName: string) => string) | null = null,
): PartExtents | null {
  promoteLiteral = promote;
  try {
    return partExtentsInner(tree, node, measure);
  } finally {
    promoteLiteral = null;
  }
}

function partExtentsInner(tree: Tree, node: SceneNode, measure: () => { min: number[]; max: number[] } | null): PartExtents | null {
  const d = decomposeNode(tree.rootNode, node);
  if (!d) return null;
  const call = d.primitiveNode;
  const base = baseName(call.type === 'module_instantiation' ? call : null);
  const local = readModifier(tree.rootNode, node) === '*' ? null : localIntervals(call, base);
  const map = local ? axisMap(d) : null;
  let measured: { min: number[]; max: number[] } | null = null;
  const translateNodes = translateComponents(d);
  const axes: AxisExtent[] = [];
  const sizeSources: SizeSource[][] = [];
  for (let k = 0; k < 3; k++) {
    const tNode = translateNodes[k];
    const t = tNode ? lin(tNode).l : constant(d.transform.translate[k]);
    let min: Lin;
    let max: Lin;
    let isMeasured = false;
    let sources: SizeSource[] = [];
    if (local && map) {
      const { from, sign, scale: s } = map[k];
      const iv = local[from];
      const lo = scale(iv.lo, s);
      const hi = scale(iv.hi, s);
      min = sign > 0 ? add(t, lo) : add(t, scale(hi, -1));
      max = sign > 0 ? add(t, hi) : add(t, scale(lo, -1));
      sources = iv.sources;
    } else {
      measured ??= measure();
      if (!measured) return null;
      min = add(t, constant(round(measured.min[k])));
      max = add(t, constant(round(measured.max[k])));
      isMeasured = true;
    }
    axes.push({ min, max, measured: isMeasured, translate: { node: tNode, value: d.transform.translate[k] } });
    sizeSources.push(sources);
  }
  return {
    axes: axes as [AxisExtent, AxisExtent, AxisExtent],
    sizeSources: sizeSources as [SizeSource[], SizeSource[], SizeSource[]],
    callName: call.type === 'module_instantiation' ? baseName(call) : null,
    decomposed: d,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** The translate() vector's component nodes, when the node has one. */
export function translateComponents(d: DecomposedNode): (Node | null)[] {
  // Walk the wrap chain from the statement to the primitive for translate().
  let n: Node | null = d.primitiveNode;
  while (n && n.startIndex > d.wrapStart) {
    n = n.parent;
    if (n?.type === 'module_instantiation' && n.childForFieldName('name')?.text === 'translate') {
      const vec = n.childForFieldName('arguments')?.namedChild(0)?.namedChild(0)?.child(0);
      if (vec?.type === 'vector_expression' && vec.namedChildCount === 3) return [vec.namedChild(0), vec.namedChild(1), vec.namedChild(2)];
    }
  }
  return [null, null, null];
}

export function edgeOf(axis: AxisExtent, edge: Edge): Lin {
  if (edge === 'min') return axis.min;
  if (edge === 'max') return axis.max;
  return scale(add(axis.min, axis.max), 0.5);
}

/** The node's own geometry box with its rotate and scale applied (no translate). */
export function geometryBox(geometry: BufferGeometry, rotateDeg: [number, number, number], scaleXYZ: [number, number, number]): { min: number[]; max: number[] } {
  const m = new Matrix4().compose(new Vector3(), transformToQuaternion(rotateDeg), new Vector3(...scaleXYZ));
  const box = new Box3().setFromBufferAttribute(geometry.getAttribute('position') as never).applyMatrix4(m);
  return { min: box.min.toArray(), max: box.max.toArray() };
}
