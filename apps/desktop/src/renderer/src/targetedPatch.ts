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
// used by Object3D.rotation — reading a live gizmo's `.rotation.{x,y,z}`
// directly and treating it as an OpenSCAD `[x,y,z]` triple is only valid for
// single-axis rotation; anything multi-axis needs to go through this order
// explicitly via quaternions, not raw Euler component arithmetic.
const OPENSCAD_EULER_ORDER = 'ZYX' as const;

export interface TranslateVector {
  startIndex: number;
  endIndex: number;
  xyz: [number, number, number];
}

// Locates `translate([x, y, z]) <body>;` when it is the *outermost* call of a
// scene node, and returns the byte range of just the vector literal plus its
// current values. Returns null for anything else (bare geometry with no wrap,
// or an outermost call that isn't `translate`) — M4 scope is proving the
// gizmo-edits-AST-via-targeted-patch loop, not handling every wrap shape.
//
// Deliberately outermost-only, unlike rotate/scale below: translate is a
// world-space move, so it must never land *inside* an existing rotate/scale —
// patching a translate nested in a rotated frame would apply the world-space
// drag delta in the rotated local frame instead, silently moving the shape in
// the wrong direction after re-render.
export function findTranslateVector(root: Node, node: SceneNode): TranslateVector | null {
  const concrete = topConcreteNode(root, node);
  if (!concrete || concrete.type !== 'module_instantiation') return null;
  if (concrete.childForFieldName('name')?.text !== 'translate') return null;
  const vc = readVectorCall(concrete);
  return vc && { startIndex: vc.vectorStart, endIndex: vc.vectorEnd, xyz: vc.xyz };
}

// The world-space point OpenSCAD's own rotate/scale would pivot around for
// this node — i.e. wherever an enclosing translate() has moved the local
// origin to, or the world origin itself if there's none. This is *not* the
// same as the rendered mesh's bounding-box center (e.g. a default,
// non-`center=true` cylinder's bbox center sits at half its height, but
// OpenSCAD still rotates/scales it around its base) — using the bbox center
// as the gizmo's pivot silently displaces asymmetric shapes on every
// rotate/scale commit, since three.js pivots around a different point than
// OpenSCAD actually does.
export function getPivotOrigin(root: Node, node: SceneNode): [number, number, number] {
  const existing = findTranslateVector(root, node);
  return existing ? existing.xyz : [0, 0, 0];
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

// The M4 "targeted patch" loop: given a gizmo drag delta on a scene node,
// compute the minimal text edit needed to persist it as real OpenSCAD source.
// If the node is already `translate(...)`-wrapped, only the vector literal's
// byte range is replaced (comments/formatting elsewhere untouched). Otherwise
// a new `translate([...])` wrap is inserted immediately before the node —
// still a pure insertion, not a full-file regen.
export function patchTranslate(
  source: string,
  tree: Tree,
  node: SceneNode,
  delta: [number, number, number],
): string {
  const existing = findTranslateVector(tree.rootNode, node);
  if (existing) {
    const [x, y, z] = existing.xyz;
    const newVec = formatVector([x + delta[0], y + delta[1], z + delta[2]]);
    return source.slice(0, existing.startIndex) + newVec + source.slice(existing.endIndex);
  }
  const newVec = formatVector(delta);
  return `${source.slice(0, node.startIndex)}translate(${newVec})\n    ${source.slice(node.startIndex)}`;
}

interface VectorCall {
  name: string;
  vectorStart: number;
  vectorEnd: number;
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
// silently unreadable, making findLocalTransform/findTranslateVector report
// "no existing wrap" and insert a duplicate instead of patching in place.
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
  return {
    name,
    vectorStart: vec.startIndex,
    vectorEnd: vec.endIndex,
    xyz: nums as [number, number, number],
  };
}

// Walks a chain of `<call>(...) <body>;` module_instantiations starting at
// `startConcrete`, following each one's trailing `statement` body child until
// hitting a call with no further nested statement (the base primitive) or a
// body that isn't a plain call (a block, if/for, ...) — see PLAN.md M5 build
// notes for the parse shape this assumes.
function walkChainFrom(startConcrete: Node | null): Node[] {
  const chain: Node[] = [];
  let concrete = startConcrete;
  while (concrete && concrete.type === 'module_instantiation') {
    chain.push(concrete);
    const last = concrete.child(concrete.childCount - 1);
    if (last?.type !== 'statement') break;
    concrete = last.child(0);
  }
  return chain;
}

// rotate/scale are "in place" edits (spin or resize the shape around its own
// local origin), unlike translate's world-space move — so unlike
// findTranslateVector, they intentionally look *past* a single leading
// `translate(...)` wrap (if any) rather than only at the outermost call.
// Known limitation: only one leading translate is skipped, and only
// vector-form rotate (`rotate([x,y,z])`, not the `rotate(a, v=[...])` or bare
// scalar forms) is recognized — see M4's findTranslateVector for the same
// vector-only scoping precedent.
function getLocalChain(root: Node, node: SceneNode): Node[] {
  const top = topConcreteNode(root, node);
  if (!top || top.type !== 'module_instantiation') return [];
  if (top.childForFieldName('name')?.text === 'translate') {
    const last = top.child(top.childCount - 1);
    return last?.type === 'statement' ? walkChainFrom(last.child(0)) : [];
  }
  return walkChainFrom(top);
}

export type LocalTransformKind = 'rotate' | 'scale';

function findLocalTransform(root: Node, node: SceneNode, kind: LocalTransformKind): VectorCall | null {
  for (const call of getLocalChain(root, node)) {
    if (call.childForFieldName('name')?.text !== kind) continue;
    const vc = readVectorCall(call);
    if (vc) return vc;
  }
  return null;
}

// Where a brand-new (not-yet-existing) local wrap goes: *outermost* in the
// local chain — immediately after any enclosing translate, wrapping any
// rotate/scale that's already there — not innermost next to the base
// primitive. This matters whenever a shape already has one local transform
// and the user drags a *different* one for the first time (e.g. rotate
// already exists, now dragging scale): the gizmo's own pivot group is never
// itself rotated (M4/M5's earlier fix bakes rotation into geometry, not the
// group's transform), so every live drag actually happens in the
// translate-only, axis-aligned frame — inserting the new wrap innermost would
// put it *inside* the existing rotate, silently reinterpreting the drag in
// the shape's pre-rotation local axes instead of the frame it was dragged in.
function localInsertPoint(root: Node, node: SceneNode): number {
  const chain = getLocalChain(root, node);
  return chain.length > 0 ? chain[0].startIndex : node.startIndex;
}

// Rotate gizmo commit: `deltaQuat` is the rotation applied during the drag,
// read directly off the gizmo's live quaternion (world-frame-equivalent,
// since the pivot group itself is never rotated between commits — see
// localInsertPoint's comment). Composing this correctly with any existing
// rotate([x,y,z]) requires going through quaternions, not raw Euler
// arithmetic: naively adding Euler components (the M5-launch approach) is
// only valid when every drag stays on one axis — combining rotations around
// *different* axes that way doesn't represent real 3D rotation composition
// and drifts into garbage values after a few drags. OpenSCAD's own
// `rotate([x,y,z])` was verified (by comparing rendered STL vertices against
// nested single-axis rotate calls) to be equivalent to applying X, then Y,
// then Z — three.js's Euler order `'ZYX'` matches that construction exactly.
export function patchRotate(
  source: string,
  tree: Tree,
  node: SceneNode,
  deltaQuat: [number, number, number, number],
): string {
  const delta = new Quaternion(...deltaQuat);
  const existing = findLocalTransform(tree.rootNode, node, 'rotate');
  const existingQuat = existing
    ? new Quaternion().setFromEuler(
        new Euler(existing.xyz[0] * DEG2RAD, existing.xyz[1] * DEG2RAD, existing.xyz[2] * DEG2RAD, OPENSCAD_EULER_ORDER),
      )
    : new Quaternion();
  // Delta was dragged in the outer (translate-only) frame, so it composes on
  // the outside of whatever rotation already exists.
  const total = delta.multiply(existingQuat);
  const totalEuler = new Euler().setFromQuaternion(total, OPENSCAD_EULER_ORDER);
  const newVec = formatVector([totalEuler.x * RAD2DEG, totalEuler.y * RAD2DEG, totalEuler.z * RAD2DEG]);

  if (existing) {
    return source.slice(0, existing.vectorStart) + newVec + source.slice(existing.vectorEnd);
  }
  const insertAt = localInsertPoint(tree.rootNode, node);
  return `${source.slice(0, insertAt)}rotate(${newVec})\n    ${source.slice(insertAt)}`;
}

// Scale gizmo commit: multiplicative (three.js scale starts at 1 each time
// the gizmo re-attaches to a freshly-rendered mesh, so `ratio` is `end/start`
// from the drag, and composes onto any existing scale([...]) by multiplying
// componentwise rather than adding). No Euler-order concerns here — scale
// isn't a rotation, so plain componentwise multiplication is exact.
export function patchScale(source: string, tree: Tree, node: SceneNode, ratio: [number, number, number]): string {
  const existing = findLocalTransform(tree.rootNode, node, 'scale');
  if (existing) {
    const [x, y, z] = existing.xyz;
    const newVec = formatVector([x * ratio[0], y * ratio[1], z * ratio[2]]);
    return source.slice(0, existing.vectorStart) + newVec + source.slice(existing.vectorEnd);
  }
  const insertAt = localInsertPoint(tree.rootNode, node);
  const newVec = formatVector(ratio);
  return `${source.slice(0, insertAt)}scale(${newVec})\n    ${source.slice(insertAt)}`;
}
