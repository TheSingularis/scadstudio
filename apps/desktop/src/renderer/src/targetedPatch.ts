import type { Node, Tree } from 'web-tree-sitter';
import { Euler, Quaternion } from 'three';
import type { SceneNode } from './sceneGraph';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Verified empirically (see PLAN.md M5 rotation-composition build notes) by
// comparing rendered STL vertices: OpenSCAD's `rotate([x,y,z])` is exactly
// equivalent to `rotate([0,0,z]) rotate([0,y,0]) rotate([x,0,0])` — i.e. the
// rotation matrix is Rz·Ry·Rx applied to points (X rotates first). Three.js's
// Euler order string that matches this is `'ZYX'`, *not* the `'XYZ'` default
// used by Object3D.rotation.
const OPENSCAD_EULER_ORDER = 'ZYX' as const;

export interface NodeTransform {
  translate: [number, number, number];
  rotateDeg: [number, number, number];
  // Axis-aligned mirroring is folded into scale rather than kept as its own
  // field: mirror([1,0,0]) and scale([-1,1,1]) are mathematically identical
  // (both are the diagonal matrix diag(-1,1,1)) for a plane through the
  // local origin, which is the only kind of mirror the toolbar generates.
  // Negative components here round-trip through mirror() calls in source
  // (see formatTransformPrefix/decomposeNode) rather than a literal
  // negative scale(), since `mirror([1,0,0])` is what reads as intentional
  // in real OpenSCAD source — `scale([-1,1,1])` would look like a stretch.
  scale: [number, number, number];
  // null means "no color() wrap" — distinct from an explicit black [0,0,0].
  color: [number, number, number] | null;
}

export const IDENTITY_TRANSFORM: NodeTransform = {
  translate: [0, 0, 0],
  rotateDeg: [0, 0, 0],
  scale: [1, 1, 1],
  color: null,
};

export function transformToQuaternion(rotateDeg: [number, number, number]): Quaternion {
  return new Quaternion().setFromEuler(
    new Euler(rotateDeg[0] * DEG2RAD, rotateDeg[1] * DEG2RAD, rotateDeg[2] * DEG2RAD, OPENSCAD_EULER_ORDER),
  );
}

export function quaternionToRotateDeg(q: Quaternion): [number, number, number] {
  const e = new Euler().setFromQuaternion(q, OPENSCAD_EULER_ORDER);
  return [e.x * RAD2DEG, e.y * RAD2DEG, e.z * RAD2DEG];
}

function formatNumber(n: number): string {
  // Round away float noise from repeated drags (e.g. 4.999999999) without
  // mangling intentionally-precise values.
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

function formatVector([x, y, z]: [number, number, number]): string {
  return `[${formatNumber(x)}, ${formatNumber(y)}, ${formatNumber(z)}]`;
}

interface VectorCall {
  name: string;
  xyz: [number, number, number];
}

function topConcreteNode(root: Node, node: SceneNode): Node | null {
  for (let i = 0; i < root.childCount; i++) {
    const stmt = root.child(i);
    if (!stmt || stmt.startIndex !== node.startIndex || stmt.endIndex !== node.endIndex) continue;
    return stmt.type === 'statement' ? stmt.child(0) : stmt;
  }
  return null;
}

// A negative literal like `-95.406` doesn't parse as a plain `number` node —
// it's a `unary_expression` (operator `unary_minus_operator` + operand
// `number`). Any existing wrap with a negative component would otherwise be
// silently unreadable.
function readNumber(n: Node | null): number | null {
  if (!n) return null;
  if (n.type === 'number') return parseFloat(n.text);
  if (n.type === 'unary_expression') {
    const operand = n.childForFieldName('operand');
    const operator = n.childForFieldName('operator')?.type;
    if (operand?.type !== 'number') return null;
    if (operator === 'unary_minus_operator') return -parseFloat(operand.text);
    if (operator === 'unary_plus_operator') return parseFloat(operand.text);
  }
  return null;
}

function readVectorCall(call: Node): VectorCall | null {
  const name = call.childForFieldName('name')?.text;
  if (!name) return null;
  const args = call.childForFieldName('arguments')?.namedChild(0); // `arguments` node
  const firstArg = args?.namedChild(0); // `argument` node
  const vec = firstArg?.child(0);
  if (!vec || vec.type !== 'vector_expression' || vec.namedChildCount < 3) return null;
  const nums = [0, 1, 2].map((n) => readNumber(vec.namedChild(n)));
  if (nums.some((n) => n === null)) return null;
  return { name, xyz: nums as [number, number, number] };
}

export interface DecomposedNode {
  transform: NodeTransform;
  // Byte range of the base primitive call itself (e.g. `cylinder(...)`),
  // stripped of any enclosing translate/rotate/scale — this is what actually
  // gets sent to openscad-wasm for isolated rendering (see App.tsx), since
  // placement is now expressed as a real three.js transform instead of being
  // baked into geometry.
  primitiveStart: number;
  // Byte offset where the outermost wrap begins (or primitiveStart if there
  // is none) — replacing [wrapStart, primitiveStart) rewrites the whole
  // translate/rotate/scale prefix in one targeted edit.
  wrapStart: number;
  // The base primitive's own call node (e.g. the `sphere(...)` in
  // `translate(...) sphere(...)`) — used by primitiveArgs/patchArgument
  // below to read/edit the primitive's *own* arguments, as opposed to its
  // placement wraps.
  primitiveNode: Node;
}

// A mirror() vector is only representable as a sign flip on `scale` (see
// NodeTransform.scale) when it's axis-aligned through the origin — i.e.
// exactly one of its three components is nonzero. `mirror([1,1,0])` mirrors
// across a diagonal plane, which has no equivalent diagonal-scale
// representation; unrecognized on read-back (same graceful-degradation
// policy as any other unrecognized wrap — see decomposeNode below).
function axisAlignedMirrorAxis(xyz: [number, number, number]): 0 | 1 | 2 | null {
  const nonzero = xyz.map((v) => v !== 0);
  if (nonzero.filter(Boolean).length !== 1) return null;
  return nonzero.indexOf(true) as 0 | 1 | 2;
}

// Walks a node's color/translate/rotate/mirror/scale wrap chain — in
// whatever order it's actually written — and decomposes it into independent
// translate/rotate/scale/color values (mirror folds into scale's sign, see
// its field comment) plus the base primitive's own byte range.
//
// Known, deliberate scope limitation: this treats color/translate/rotate/
// scale as independent slots regardless of their original nesting order, and
// `patchTransform` below always rewrites them back in canonical
// color→translate→rotate→mirror→scale order (matching three.js's own TRS
// composition, and OpenSCAD's own idiomatic convention). A hand-written file
// using a *different* order (e.g. `rotate(...) translate(...)`, which orbits
// the shape around the world origin rather than translating then rotating in
// place) will render differently once decomposed this way — this is a
// correctness tradeoff for gizmo-editable files, not a bug in the common
// (and gizmo-generated) canonical-order case.
export function decomposeNode(root: Node, node: SceneNode): DecomposedNode | null {
  const top = topConcreteNode(root, node);
  if (!top || top.type !== 'module_instantiation') return null;

  const transform: NodeTransform = { translate: [0, 0, 0], rotateDeg: [0, 0, 0], scale: [1, 1, 1], color: null };
  const mirrorSign: [number, number, number] = [1, 1, 1];
  let sawColor = false;
  const wrapStart = top.startIndex;
  let current: Node = top;

  while (current.type === 'module_instantiation') {
    const name = current.childForFieldName('name')?.text;
    if (name === 'color') {
      if (sawColor) break; // a second color() wrap is unusual; stop rather than guess which wins
      const vc = readVectorCall(current);
      if (!vc) break;
      transform.color = vc.xyz;
      sawColor = true;
    } else if (name === 'translate') {
      const vc = readVectorCall(current);
      if (!vc) break;
      transform.translate = vc.xyz;
    } else if (name === 'rotate') {
      const vc = readVectorCall(current);
      if (!vc) break;
      transform.rotateDeg = vc.xyz;
    } else if (name === 'mirror') {
      const vc = readVectorCall(current);
      if (!vc) break;
      const axis = axisAlignedMirrorAxis(vc.xyz);
      if (axis === null) break;
      mirrorSign[axis] *= -1;
    } else if (name === 'scale') {
      const vc = readVectorCall(current);
      if (!vc) break;
      transform.scale = vc.xyz;
    } else {
      break;
    }

    const last = current.child(current.childCount - 1);
    if (last?.type !== 'statement' || !last.child(0)) break;
    current = last.child(0)!;
  }

  transform.scale = transform.scale.map((v, i) => v * mirrorSign[i]) as [number, number, number];
  return { transform, primitiveStart: current.startIndex, wrapStart, primitiveNode: current };
}

// Isolated-render source for a node: just the base primitive (context +
// verbatim primitive text), with translate/rotate/scale stripped — placement
// is applied as a real three.js transform on the pivot group instead (see
// Viewport.tsx), not baked into the rendered geometry.
export function primitiveSource(root: Node, node: SceneNode, fullSource: string, context: string): string {
  const decomposed = decomposeNode(root, node);
  const start = decomposed ? decomposed.primitiveStart : node.startIndex;
  return `${context}\n${fullSource.slice(start, node.endIndex)}`;
}

const MIRROR_AXIS_VECTORS: [number, number, number][] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function formatTransformPrefix(t: NodeTransform): string {
  let prefix = '';
  if (t.color) prefix += `color(${formatVector(t.color)})\n    `;
  if (t.translate.some((v) => v !== 0)) prefix += `translate(${formatVector(t.translate)})\n    `;
  if (t.rotateDeg.some((v) => v !== 0)) prefix += `rotate(${formatVector(t.rotateDeg)})\n    `;
  // Negative scale components are written back out as real mirror() calls
  // rather than a literal negative scale() — see NodeTransform.scale's
  // comment for why they're equivalent and why source should read as
  // "mirrored", not "stretched negative".
  const absScale: [number, number, number] = [...t.scale];
  for (let axis = 0; axis < 3; axis++) {
    if (t.scale[axis] < 0) {
      prefix += `mirror(${formatVector(MIRROR_AXIS_VECTORS[axis])})\n    `;
      absScale[axis] = -t.scale[axis];
    }
  }
  if (absScale.some((v) => v !== 1)) prefix += `scale(${formatVector(absScale)})\n    `;
  return prefix;
}

// The targeted-patch loop: given a gizmo drag's *final* absolute transform
// (not a delta — the pivot group's position/quaternion/scale directly reflect
// the true placement now, so there's nothing to compose with an "existing"
// value the way earlier additive/multiplicative/quaternion-delta approaches
// needed), rewrite the node's translate/rotate/scale prefix in one targeted
// edit. Identity components are omitted entirely (no `rotate([0,0,0])`
// clutter). Only the wrap prefix is replaced — the primitive's own text,
// comments, and formatting are always preserved untouched.
export function patchTransform(source: string, tree: Tree, node: SceneNode, transform: NodeTransform): string {
  const decomposed = decomposeNode(tree.rootNode, node);
  if (!decomposed) return source;
  const prefix = formatTransformPrefix(transform);
  return source.slice(0, decomposed.wrapStart) + prefix + source.slice(decomposed.primitiveStart);
}

export interface PrimitiveArg {
  // Argument name as written in source (e.g. `r` in `sphere(r=8)`), or null
  // for a positional argument (e.g. the `[10,10,10]` in `cube([10,10,10])`).
  // Deliberately not resolved against the primitive's real parameter names
  // for positional args (that needs a schema of every built-in's signature,
  // or — for custom modules — the module's own definition, which is M8's
  // module-introspection scope, not this one) — labeled by position instead.
  name: string | null;
  // Verbatim source text of the argument's value, whatever expression it is
  // (number, vector, string, or an arbitrary expression like `x * 2`) — the
  // panel edits this as opaque text, not a parsed/typed value, so any valid
  // OpenSCAD expression a user types is preserved as-is.
  valueText: string;
  valueStart: number;
  valueEnd: number;
}

// Reads a primitive call's own arguments (name if any, verbatim value text
// and byte range) — works for any module_instantiation, built-in or custom,
// since it only depends on the grammar's generic argument/argument_list
// shape, not per-primitive knowledge of what arguments a given call expects.
export function primitiveArgs(root: Node, node: SceneNode): { callName: string; args: PrimitiveArg[] } | null {
  const decomposed = decomposeNode(root, node);
  if (!decomposed) return null;
  const call = decomposed.primitiveNode;
  const callName = call.childForFieldName('name')?.text;
  if (!callName) return null;
  const argsNode = call.childForFieldName('arguments')?.namedChild(0); // `arguments` node, absent if call has zero args
  const args: PrimitiveArg[] = [];
  for (let i = 0; i < (argsNode?.namedChildCount ?? 0); i++) {
    const argument = argsNode!.namedChild(i);
    const value = argument?.childForFieldName('value');
    if (!value) continue;
    args.push({
      name: argument!.childForFieldName('name')?.text ?? null,
      valueText: value.text,
      valueStart: value.startIndex,
      valueEnd: value.endIndex,
    });
  }
  return { callName, args };
}

// Minimal-diff edit of a single argument's value, identified by its position
// in `primitiveArgs`'s own list (stable within one render — a full
// re-render, which any commit triggers, reassigns byte ranges anyway, so
// this only ever needs to be valid for one edit against one known source).
// Same one-derivation-path philosophy as patchTransform: only the targeted
// byte range changes, the rest of the file (including comments/formatting
// around this call) is untouched.
export function patchArgument(source: string, tree: Tree, node: SceneNode, argIndex: number, newValueText: string): string {
  const decomposed = primitiveArgs(tree.rootNode, node);
  const arg = decomposed?.args[argIndex];
  if (!arg) return source;
  return source.slice(0, arg.valueStart) + newValueText + source.slice(arg.valueEnd);
}
