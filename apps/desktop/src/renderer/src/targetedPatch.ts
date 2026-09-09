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
  scale: [number, number, number];
}

export const IDENTITY_TRANSFORM: NodeTransform = {
  translate: [0, 0, 0],
  rotateDeg: [0, 0, 0],
  scale: [1, 1, 1],
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
}

// Walks a node's translate/rotate/scale wrap chain — in whatever order it's
// actually written — and decomposes it into independent translate/rotate/
// scale values plus the base primitive's own byte range.
//
// Known, deliberate scope limitation: this treats translate/rotate/scale as
// three independent slots regardless of their original nesting order, and
// `patchTransform` below always rewrites them back in canonical
// translate→rotate→scale order (matching three.js's own TRS composition,
// and OpenSCAD's own idiomatic convention). A hand-written file using a
// *different* order (e.g. `rotate(...) translate(...)`, which orbits the
// shape around the world origin rather than translating then rotating in
// place) will render differently once decomposed this way — this is a
// correctness tradeoff for gizmo-editable files, not a bug in the common
// (and gizmo-generated) canonical-order case.
export function decomposeNode(root: Node, node: SceneNode): DecomposedNode | null {
  const top = topConcreteNode(root, node);
  if (!top || top.type !== 'module_instantiation') return null;

  const transform: NodeTransform = { translate: [0, 0, 0], rotateDeg: [0, 0, 0], scale: [1, 1, 1] };
  const wrapStart = top.startIndex;
  let current: Node = top;

  while (current.type === 'module_instantiation') {
    const name = current.childForFieldName('name')?.text;
    if (name !== 'translate' && name !== 'rotate' && name !== 'scale') break;
    const vc = readVectorCall(current);
    if (!vc) break;
    if (name === 'translate') transform.translate = vc.xyz;
    else if (name === 'rotate') transform.rotateDeg = vc.xyz;
    else transform.scale = vc.xyz;

    const last = current.child(current.childCount - 1);
    if (last?.type !== 'statement' || !last.child(0)) break;
    current = last.child(0)!;
  }

  return { transform, primitiveStart: current.startIndex, wrapStart };
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

function formatTransformPrefix(t: NodeTransform): string {
  let prefix = '';
  if (t.translate.some((v) => v !== 0)) prefix += `translate(${formatVector(t.translate)})\n    `;
  if (t.rotateDeg.some((v) => v !== 0)) prefix += `rotate(${formatVector(t.rotateDeg)})\n    `;
  if (t.scale.some((v) => v !== 1)) prefix += `scale(${formatVector(t.scale)})\n    `;
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
