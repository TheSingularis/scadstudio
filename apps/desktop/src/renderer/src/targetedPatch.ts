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

// Exported for reuse by primitives.ts's sketch-polygon codegen (M7.5) — same
// float-noise rounding is just as relevant to drawn sketch points as it is
// to repeated gizmo drags.
export function formatNumber(n: number): string {
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
  // A leading modifier character (`# % ! *`, see readModifier/patchModifier
  // below) is `top`'s own first child, not part of the transform/primitive
  // content — wrapStart must start *after* it, or patchTransform's rewrite
  // would silently delete the modifier on the next gizmo drag. Only matters
  // when there's no translate/rotate/etc. wrap to skip past anyway (see
  // primitiveStart below for the other half of this).
  const modifierNode = top.child(0)?.type === 'modifier' ? top.child(0) : null;
  const wrapStart = modifierNode ? modifierNode.endIndex : top.startIndex;
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
  // If the loop above never advanced past `top` (no translate/rotate/etc.
  // wrap to walk through — e.g. a bare `%cube(10);`), `current` is still
  // `top` itself, whose startIndex is the modifier's position, not the
  // primitive's — the max() picks wrapStart (past the modifier) in that
  // case, and current.startIndex (already correctly past both the modifier
  // and any consumed wraps) in every other case.
  const primitiveStart = Math.max(current.startIndex, wrapStart);
  return { transform, primitiveStart, wrapStart, primitiveNode: current };
}

// M6's four OpenSCAD modifier characters — highlight (#), background/ghost
// (%), root/show-only (!), disable (*). Grammar-level, these prefix a
// statement's *outermost* call (`modifier: ($) => choice('#', '!', '%', '*')`
// as an unlabeled optional child of `module_instantiation`) — the same node
// decomposeNode's wrap-walk starts from (`top`/`topConcreteNode`), not the
// inner primitive `primitiveNode` descends to. Real OpenSCAD applies a
// modifier recursively to a statement's children too, but since this app
// only models top-level statements (nested-child modeling is M9's job), a
// modifier here only ever affects the one top-level statement it's written
// on.
export type Modifier = '#' | '!' | '%' | '*';

export function readModifier(root: Node, node: SceneNode): Modifier | null {
  const top = topConcreteNode(root, node);
  if (!top || top.type !== 'module_instantiation') return null;
  const first = top.child(0);
  return first && first.type === 'modifier' ? (first.text as Modifier) : null;
}

// Toggles a modifier: re-applying the one that's already active clears it
// (real OpenSCAD only ever has zero or one modifier per statement, so
// there's no "stack" to manage), applying a different one replaces it.
export function patchModifier(source: string, tree: Tree, node: SceneNode, modifier: Modifier): string {
  const top = topConcreteNode(tree.rootNode, node);
  if (!top || top.type !== 'module_instantiation') return source;
  const first = top.child(0);
  const existing = first && first.type === 'modifier' ? first : null;
  if (existing) {
    const withoutExisting = source.slice(0, existing.startIndex) + source.slice(existing.endIndex);
    if (existing.text === modifier) return withoutExisting; // toggle off
    // existing.startIndex is still valid against `withoutExisting` — nothing before it moved.
    return withoutExisting.slice(0, existing.startIndex) + modifier + withoutExisting.slice(existing.startIndex);
  }
  return source.slice(0, top.startIndex) + modifier + source.slice(top.startIndex);
}

// Isolated-render source for a node: just the base primitive's own verbatim
// text, with translate/rotate/scale stripped — placement is applied as a
// real three.js transform on the pivot group instead (see Viewport.tsx),
// not baked into the rendered geometry. Context (module/function defs,
// assignments, use/include) is deliberately NOT included here — App.tsx
// prepends it separately, and wrapAsThinExtrude below needs the primitive
// and context kept apart rather than pre-joined (see its own comment for
// the real bug that came from joining them too early).
export function primitiveOnlySlice(root: Node, node: SceneNode, fullSource: string): string {
  const decomposed = decomposeNode(root, node);
  const start = decomposed ? decomposed.primitiveStart : node.startIndex;
  return fullSource.slice(start, node.endIndex);
}

// M7: real OpenSCAD can't export pure-2D geometry (square/circle/polygon,
// or anything else that evaluates to 2D, e.g. a 2D boolean) to STL — a bare
// `circle();` at the top level fails the isolated render entirely (App.tsx
// catches this and retries with this wrapper). Wrapping in a hairline
// linear_extrude reuses the exact same WASM/STL pipeline as every 3D node
// instead of a separate client-side 2D geometry path, so every real
// OpenSCAD 2D semantic ($fn, center, d vs r, 2D booleans, text()'s font
// caveat aside) is handled by actually running OpenSCAD, not reimplemented.
//
// Real bug found 2026-09-21: this used to take one already-joined
// `${context}\n${primitive}` string and wrap all of it in the block, on the
// theory that non-geometry statements inside a block are harmless. They're
// not always — a file with a module/function definition ahead of a bare 2D
// node (the M6 demo scene's `module bracket(...)`, or any real-world file
// with helper modules) made *every* bare-2D node in that file fail both the
// normal attempt *and* this retry, since the definition ended up nested
// inside a linear_extrude block it was never written inside — "Rendered
// N-1/N nodes" with no indication which node or why. Takes context and the
// primitive as separate parameters now and keeps context *outside* the
// synthetic block, exactly like every other isolated render in this app —
// the wrapper's only job is giving the primitive itself real 3D geometry to
// export, not restructuring what surrounds it.
export function wrapAsThinExtrude(context: string, primitive: string): string {
  return `${context}\nlinear_extrude(height=0.01) {\n${primitive}\n}`;
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
    // The grammar only tags a `value` field for the *named* branch of
    // `argument` (`name = value`) — a bare positional argument is just the
    // expression itself with no field name at all, so `value` comes back
    // null for e.g. cube's `[20,20,20]` in `cube([20,20,20], center=true)`
    // and has to be read positionally instead (this is exactly why
    // readVectorCall above reads translate's vector via `.child(0)`, not a
    // field name).
    const value = argument?.childForFieldName('value') ?? argument?.child(0);
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

export type BooleanOp = 'union' | 'difference' | 'intersection';

function indent(text: string, spaces: string): string {
  return text
    .split('\n')
    .map((line) => spaces + line)
    .join('\n');
}

// Wraps two or more top-level nodes' verbatim source into a single new
// `union()`/`difference()`/`intersection() { ... }` block, removing them
// from their original positions.
//
// `nodesInSelectionOrder` is deliberately click order, not document order:
// difference()'s first child is the base and every child after it is
// subtracted, so which shape the user selected *first* is semantically
// load-bearing, the same way it would be in any other CAD tool's boolean
// tool. Document order only matters for one thing — *where* the new
// combined statement goes — and that's always the position of whichever
// selected node comes first in the file, regardless of click order, so nodes
// before it that were never selected don't need to move at all.
//
// Implementation is a single left-to-right pass over the selected nodes in
// document order: the earliest one's byte range is replaced with the new
// block, every other selected node's byte range (plus one trailing newline,
// so deleting a shape doesn't leave a blank line behind) is deleted
// entirely, and everything else is untouched — same minimal-diff philosophy
// as patchTransform/patchArgument, just applied to multiple disjoint ranges
// in one edit instead of one.
export function wrapInBoolean(source: string, nodesInSelectionOrder: SceneNode[], op: BooleanOp): string {
  if (nodesInSelectionOrder.length < 2) return source;
  const byDocOrder = [...nodesInSelectionOrder].sort((a, b) => a.startIndex - b.startIndex);
  const first = byDocOrder[0];

  const body = nodesInSelectionOrder
    .map((n) => indent(source.slice(n.startIndex, n.endIndex).trim(), '    '))
    .join('\n');
  const block = `${op}() {\n${body}\n}`;

  let result = '';
  let cursor = 0;
  for (const node of byDocOrder) {
    result += source.slice(cursor, node.startIndex);
    result += node === first ? block : '';
    cursor = node.endIndex;
    if (node !== first && source[cursor] === '\n') cursor++;
  }
  result += source.slice(cursor);
  return result;
}

export type ExtrudeOp = 'linear_extrude' | 'rotate_extrude';

const EXTRUDE_DEFAULT_ARGS: Record<ExtrudeOp, string> = {
  linear_extrude: 'height=10',
  rotate_extrude: '$fn=48',
};

// M7.5: wraps a single existing node's verbatim source in a new
// linear_extrude()/rotate_extrude() block, in place — the extrude
// equivalent of wrapInBoolean above, just single-node instead of
// multi-node. This is what actually lets a drawn sketch (or any other
// existing 2D shape) get extruded, as opposed to the toolbar's Insert-style
// buttons which always append an unrelated new default shape.
//
// The node's own translate/rotate/scale wrap (if any) must stay *outside*
// the new linear_extrude/rotate_extrude, not get carried inside it: a
// linear_extrude only accepts a 2D child living in the XY plane, and a
// face-picked sketch plane's rotate() is exactly what tilts the polygon out
// of that plane. Nesting it inside the extrude rotates the 2D profile
// before extrusion instead of the finished 3D solid after, which OpenSCAD
// can't represent (2026-09-22 bug: silently empty geometry — "Scaling a 2D
// object with 0 - removing object" — reachable via pick-face sketch →
// Finish Sketch → Extrude, since that's the one path that produces a
// non-Z-axis rotate() wrap ahead of a 2D primitive). So this decomposes the
// node the same way patchTransform does, and re-emits the wrap prefix
// ahead of the extrude block instead of inside it.
export function wrapInExtrude(source: string, root: Node, node: SceneNode, op: ExtrudeOp): string {
  const decomposed = decomposeNode(root, node);
  const wrapStart = decomposed ? decomposed.wrapStart : node.startIndex;
  const primitiveStart = decomposed ? decomposed.primitiveStart : node.startIndex;
  const prefix = decomposed ? formatTransformPrefix(decomposed.transform) : '';
  const body = indent(source.slice(primitiveStart, node.endIndex).trim(), '    ');
  const block = `${prefix}${op}(${EXTRUDE_DEFAULT_ARGS[op]}) {\n${body}\n}`;
  return source.slice(0, wrapStart) + block + source.slice(node.endIndex);
}

// M7.5 on-plane editing: everything needed to re-open an already-committed
// sketch for editing — the plane it was drawn on (its translate()/rotate()
// wrap, which is exactly what appendSketchPolygon emitted from the original
// ActiveSketchPlane) plus its polygon's points and the byte range of the
// points vector, so saving the edit rewrites just that one vector in place.
export interface SketchProfile {
  origin: [number, number, number];
  rotationDeg: [number, number, number];
  points: [number, number][];
  pointsStart: number;
  pointsEnd: number;
}

function polygonPointsArg(call: Node): Node | null {
  const argsNode = call.childForFieldName('arguments')?.namedChild(0);
  for (let i = 0; i < (argsNode?.namedChildCount ?? 0); i++) {
    const argument = argsNode!.namedChild(i);
    const name = argument?.childForFieldName('name')?.text ?? null;
    // `points` is polygon()'s first parameter, so a positional first
    // argument is the points vector too (`polygon([[0,0], ...])`).
    if (name === 'points' || (name === null && i === 0)) {
      return argument?.childForFieldName('value') ?? argument?.child(0) ?? null;
    }
  }
  return null;
}

// The single 2D child of a `linear_extrude(...) { child; }` or
// `linear_extrude(...) child;` — null for zero or several children, since
// "edit the extruded sketch" only has one honest meaning when there's
// exactly one profile underneath.
function soleChildCall(call: Node): Node | null {
  const last = call.child(call.childCount - 1);
  if (!last) return null;
  let stmt: Node | null = last;
  if (last.type === 'block') {
    const stmts = last.namedChildren.filter((c): c is Node => c !== null && c.type === 'statement');
    if (stmts.length !== 1) return null;
    stmt = stmts[0];
  }
  if (stmt?.type !== 'statement') return null;
  const child = stmt.child(0);
  return child?.type === 'module_instantiation' ? child : null;
}

// Recognizes the two shapes sketch mode itself produces: a bare
// `[translate(...)] [rotate(...)] polygon(points=[...]);` (Finish Sketch) and
// the same with a linear_extrude between the wrap and the polygon (Finish
// Sketch → Linear Extrude, see wrapInExtrude). Deliberately strict —
// anything this can't round-trip exactly returns null, and the toolbar
// simply doesn't offer "Edit Sketch" for that node:
// - points must be literal numbers (a vector built from variables or
//   expressions has no single position to drag; rewriting it as literals
//   would silently destroy the parametric intent),
// - no scale()/mirror() wrap (handles live in the plane's unscaled frame;
//   a scaled sketch would need the scale folded into every dragged point),
// - rotate_extrude isn't accepted: its profile's XY plane gets revolved
//   into XZ, so the on-plane handles wouldn't line up with the solid.
export function readSketchProfile(root: Node, node: SceneNode): SketchProfile | null {
  const decomposed = decomposeNode(root, node);
  if (!decomposed) return null;
  const { transform } = decomposed;
  if (transform.scale.some((v) => v !== 1)) return null;
  let call: Node | null = decomposed.primitiveNode;
  if (call.childForFieldName('name')?.text === 'linear_extrude') call = soleChildCall(call);
  if (!call || call.childForFieldName('name')?.text !== 'polygon') return null;
  const vec = polygonPointsArg(call);
  if (!vec || vec.type !== 'vector_expression') return null;
  const points: [number, number][] = [];
  for (const pointNode of vec.namedChildren) {
    if (!pointNode || pointNode.type !== 'vector_expression' || pointNode.namedChildCount !== 2) return null;
    const u = readNumber(pointNode.namedChild(0));
    const v = readNumber(pointNode.namedChild(1));
    if (u === null || v === null) return null;
    points.push([u, v]);
  }
  if (points.length < 3) return null;
  return {
    origin: transform.translate,
    rotationDeg: transform.rotateDeg,
    points,
    pointsStart: vec.startIndex,
    pointsEnd: vec.endIndex,
  };
}

export function formatSketchPoints(points: [number, number][]): string {
  return `[${points.map(([u, v]) => `[${formatNumber(u)}, ${formatNumber(v)}]`).join(', ')}]`;
}

// Saving an edited sketch: only the points vector's own bytes change — the
// plane wrap, any extrude around it, paths=, modifiers, color, comments and
// formatting all stay exactly as they were (same minimal-diff rule as
// patchArgument).
export function patchSketchPoints(source: string, profile: SketchProfile, points: [number, number][]): string {
  return source.slice(0, profile.pointsStart) + formatSketchPoints(points) + source.slice(profile.pointsEnd);
}
