import type { Node, Tree } from 'web-tree-sitter';
import type { SceneNode } from './sceneGraph';

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
// `translate(...)` wrap (if any) rather than only at the outermost call, and
// a fresh wrap is inserted at the *innermost* position, immediately before
// the base primitive. That keeps `translate([40,0,0]) rotate([..]) sphere();`
// spinning the sphere in place rather than orbiting it around the world
// origin. Known limitation: only one leading translate is skipped, and only
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

function localInsertPoint(root: Node, node: SceneNode): number {
  const chain = getLocalChain(root, node);
  return chain.length > 0 ? chain[chain.length - 1].startIndex : node.startIndex;
}

// Rotate gizmo commit: degrees, additive (matches OpenSCAD's rotate([x,y,z])
// taking degrees). Known limitation, not yet verified: three.js's Euler
// composition order for combined multi-axis rotation may not exactly match
// OpenSCAD's own rotate([x,y,z]) composition order — single-axis drags are
// unambiguous and are what M5's verification actually exercises; combined
// multi-axis rotates should be treated as unverified until checked directly
// against real OpenSCAD output.
export function patchRotate(source: string, tree: Tree, node: SceneNode, deltaDegrees: [number, number, number]): string {
  const existing = findLocalTransform(tree.rootNode, node, 'rotate');
  if (existing) {
    const [x, y, z] = existing.xyz;
    const newVec = formatVector([x + deltaDegrees[0], y + deltaDegrees[1], z + deltaDegrees[2]]);
    return source.slice(0, existing.vectorStart) + newVec + source.slice(existing.vectorEnd);
  }
  const insertAt = localInsertPoint(tree.rootNode, node);
  const newVec = formatVector(deltaDegrees);
  return `${source.slice(0, insertAt)}rotate(${newVec})\n    ${source.slice(insertAt)}`;
}

// Scale gizmo commit: multiplicative (three.js scale starts at 1 each time
// the gizmo re-attaches to a freshly-rendered mesh, so `ratio` is `end/start`
// from the drag, and composes onto any existing scale([...]) by multiplying
// componentwise rather than adding).
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
