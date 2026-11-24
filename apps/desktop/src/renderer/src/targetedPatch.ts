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
  // A fourth component is color()'s alpha, kept so an edit never drops it
  // from the file (QC audit M2).
  color: ColorVector | null;
}

export type ColorVector = [number, number, number] | [number, number, number, number];

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

function formatVector(v: readonly number[]): string {
  return `[${v.map(formatNumber).join(', ')}]`;
}

interface VectorCall {
  name: string;
  xyz: [number, number, number];
  // Fourth component when the vector has exactly four (color's alpha).
  w: number | null;
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
  // Exactly three components, or four for color's alpha: anything else is
  // not a vector this module can round-trip, so the wrap is left alone.
  if (!vec || vec.type !== 'vector_expression') return null;
  const count = vec.namedChildCount;
  if (count !== 3 && !(count === 4 && name === 'color')) return null;
  const nums = Array.from({ length: count }, (_, n) => readNumber(vec.namedChild(n)));
  if (nums.some((n) => n === null)) return null;
  return { name, xyz: nums.slice(0, 3) as [number, number, number], w: count === 4 ? nums[3] : null };
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
  if (!top) return null;
  // A bare top-level block, `{ cube(5); }`, is valid OpenSCAD (and is what
  // a brace-form wrap like `translate(v) { ... }` leaves behind once a gizmo
  // drag returns it to identity). It has no wraps of its own; the block is
  // its own primitive, so it can still be moved and wrapped.
  if (top.type === 'block') {
    return {
      transform: { ...IDENTITY_TRANSFORM },
      primitiveStart: top.startIndex,
      wrapStart: top.startIndex,
      primitiveNode: top,
    };
  }
  if (top.type !== 'module_instantiation') return null;

  const transform: NodeTransform = { translate: [0, 0, 0], rotateDeg: [0, 0, 0], scale: [1, 1, 1], color: null };
  const mirrorSign: [number, number, number] = [1, 1, 1];
  let sawColor = false;
  let sawScale = false;
  // Canonical-order rank of the innermost wrap consumed so far (see
  // WRAP_RANK). Only a chain that is already in canonical order, with at most
  // one translate/rotate/scale, can be represented as independent slots and
  // written back unchanged. Anything else (a second translate stacked on the
  // first, or rotate() outside translate()) stops the walk *before* it is
  // recorded: the rest of the chain stays part of the primitive's own text,
  // which WASM renders with those transforms baked in. That keeps the
  // display identical to real OpenSCAD and means a gizmo edit only ever
  // rewrites the outer, canonical part (QC audit M1).
  let lastRank = -1;
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
    const rank = name ? WRAP_RANK.get(name) : undefined;
    if (rank === undefined) break;

    // The wrap's body decides whether there is anything to descend into.
    // `translate(v) child;` has a `statement` body; `translate(v) { ... }`
    // has a `block` body, which becomes the primitive itself (rendered as
    // `{ ... }`, valid OpenSCAD). Checked *before* the value is recorded: a
    // value recorded for a wrap that then stays in the primitive's text gets
    // applied twice, once baked in by WASM and once by three.js (QC audit H2).
    const last = current.child(current.childCount - 1);
    let next: Node | null = null;
    if (last?.type === 'statement' && last.child(0)) next = last.child(0);
    else if (last?.type === 'block') next = last;
    if (!next) break;

    const vc = readVectorCall(current);
    if (!vc) break;
    if (name === 'color') {
      if (sawColor) break; // a second color() wrap is unusual; stop rather than guess which wins
      transform.color = vc.w === null ? vc.xyz : [...vc.xyz, vc.w];
      sawColor = true;
    } else if (name === 'mirror') {
      const axis = axisAlignedMirrorAxis(vc.xyz);
      if (axis === null || rank < lastRank) break;
      mirrorSign[axis] *= -1;
      lastRank = rank;
    } else if (name === 'scale') {
      if (sawScale || rank < lastRank) break;
      transform.scale = vc.xyz;
      sawScale = true;
      lastRank = rank;
    } else {
      // translate / rotate: each at most once, and only in canonical order.
      if (rank <= lastRank) break;
      if (name === 'translate') transform.translate = vc.xyz;
      else transform.rotateDeg = vc.xyz;
      lastRank = rank;
    }

    current = next;
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

// Canonical outer-to-inner order that formatTransformPrefix writes and
// three.js composes (T·R·S). color() changes no geometry, so it may sit
// anywhere in the chain. mirror and scale share a rank: both are diagonal
// matrices, so their relative order doesn't change the result.
const WRAP_RANK = new Map<string, number>([
  ['color', -1],
  ['translate', 0],
  ['rotate', 1],
  ['mirror', 2],
  ['scale', 2],
]);

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

const WRAP_SEPARATOR = '\n    ';

function formatTransformPrefix(t: NodeTransform): string {
  let prefix = '';
  if (t.color) prefix += `color(${formatVector(t.color)})${WRAP_SEPARATOR}`;
  if (t.translate.some((v) => v !== 0)) prefix += `translate(${formatVector(t.translate)})${WRAP_SEPARATOR}`;
  if (t.rotateDeg.some((v) => v !== 0)) prefix += `rotate(${formatVector(t.rotateDeg)})${WRAP_SEPARATOR}`;
  // Negative scale components are written back out as real mirror() calls
  // rather than a literal negative scale() — see NodeTransform.scale's
  // comment for why they're equivalent and why source should read as
  // "mirrored", not "stretched negative".
  const absScale: [number, number, number] = [...t.scale];
  for (let axis = 0; axis < 3; axis++) {
    if (t.scale[axis] < 0) {
      prefix += `mirror(${formatVector(MIRROR_AXIS_VECTORS[axis])})${WRAP_SEPARATOR}`;
      absScale[axis] = -t.scale[axis];
    }
  }
  if (absScale.some((v) => v !== 1)) prefix += `scale(${formatVector(absScale)})${WRAP_SEPARATOR}`;
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
  let prefix = formatTransformPrefix(transform);
  // Brace form keeps its brace on the wrap's own line:
  // `translate([40, 0, 0]) { ... }`, not a `{` alone on the next line.
  if (decomposed.primitiveNode.type === 'block' && prefix.endsWith(WRAP_SEPARATOR)) {
    prefix = `${prefix.slice(0, -WRAP_SEPARATOR.length)} `;
  }
  // A modifier can only prefix a module call, not a bare `{ ... }`, so an
  // identity transform on a modified brace body keeps a no-op call to hang
  // the modifier on.
  if (decomposed.primitiveNode.type === 'block' && prefix === '' && readModifier(tree.rootNode, node)) {
    prefix = 'union() ';
  }
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
export interface CallArgs {
  callName: string;
  args: PrimitiveArg[];
  // Byte offset of the argument list's closing `)`, where addNamedArgument
  // appends.
  closeParen: number;
}

export function primitiveArgs(root: Node, node: SceneNode): CallArgs | null {
  const decomposed = decomposeNode(root, node);
  if (!decomposed) return null;
  let call = decomposed.primitiveNode;
  // Brace form with a single child, `translate(v) { cube(5); }`: the panel
  // edits that child's arguments, the same as for `translate(v) cube(5);`.
  if (call.type === 'block') {
    const statements = call.namedChildren.filter((c) => c?.type === 'statement');
    const only = statements.length === 1 ? statements[0]?.child(0) : null;
    if (only?.type !== 'module_instantiation') return null;
    call = only;
  }
  const callName = call.childForFieldName('name')?.text;
  if (!callName) return null;
  const argList = call.childForFieldName('arguments');
  if (!argList) return null;
  const argsNode = argList.namedChild(0); // `arguments` node, absent if call has zero args
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
  // The list's last child is its `)`; a missing one (mid-typing) has no
  // width, so fall back to the end of the list.
  const last = argList.child(argList.childCount - 1);
  const closeParen = last?.type === ')' && !last.isMissing ? last.startIndex : argList.endIndex;
  return { callName, args, closeParen };
}

// M8: adds `name = value` to the end of the selected call's arguments, for a
// module parameter the call doesn't pass yet (the panel lists those too).
export function addNamedArgument(source: string, tree: Tree, node: SceneNode, name: string, valueText: string): string {
  const call = primitiveArgs(tree.rootNode, node);
  if (!call) return source;
  if (call.args.some((a) => a.name === name)) return source;
  const lastArg = call.args[call.args.length - 1];
  const insertion = `${lastArg ? ', ' : ''}${name} = ${valueText}`;
  // After the last argument rather than at the `)`, so a trailing newline
  // or comment before the `)` stays where it is.
  const at = lastArg ? lastArg.valueEnd : call.closeParen;
  return source.slice(0, at) + insertion + source.slice(at);
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
// End of a comment that follows a statement on its own line
// (`cube(5); // base`), or `end` itself if there is none. A boolean wrap
// moves that comment along with its statement; before, the statement moved
// into the block and its comment stayed behind after the closing brace
// (QC audit L1).
function trailingCommentEnd(source: string, end: number): number {
  const m = /^[ \t]*(\/\/[^\n]*|\/\*[^\n]*?\*\/[ \t]*(?=\n|$))/.exec(source.slice(end));
  return m ? end + m[0].length : end;
}

export function wrapInBoolean(source: string, nodesInSelectionOrder: SceneNode[], op: BooleanOp): string {
  if (nodesInSelectionOrder.length < 2) return source;
  const byDocOrder = [...nodesInSelectionOrder].sort((a, b) => a.startIndex - b.startIndex);
  const first = byDocOrder[0];
  const endOf = (n: SceneNode) => trailingCommentEnd(source, n.endIndex);

  const body = nodesInSelectionOrder
    .map((n) => indent(source.slice(n.startIndex, endOf(n)).trim(), '    '))
    .join('\n');
  const block = `${op}() {\n${body}\n}`;

  let result = '';
  let cursor = 0;
  for (const node of byDocOrder) {
    result += source.slice(cursor, node.startIndex);
    result += node === first ? block : '';
    cursor = endOf(node);
    if (node !== first && source[cursor] === '\n') cursor++;
  }
  result += source.slice(cursor);
  return result;
}

export type ExtrudeOp = 'linear_extrude' | 'rotate_extrude';
// M7.5 richer sketch tools: offset() is OpenSCAD's native 2D inset/outset,
// a 2D→2D op that wraps a sketch exactly the way an extrude does, so it
// shares wrapInExtrude's codegen. r= rounds outer corners; the parameter
// panel can switch it to delta= for sharp ones, or make it negative to inset.
export type WrapOp = ExtrudeOp | 'offset';

const EXTRUDE_DEFAULT_ARGS: Record<WrapOp, string> = {
  linear_extrude: 'height=10',
  rotate_extrude: '$fn=48',
  offset: 'r=1',
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
export function wrapInExtrude(source: string, root: Node, node: SceneNode, op: WrapOp): string {
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
// ActiveSketchPlane), its loops, and the byte ranges of the points and
// paths vectors, so saving the edit rewrites just those vectors in place.
export interface SketchProfile {
  origin: [number, number, number];
  rotationDeg: [number, number, number];
  // One entry per path (a single entry when the polygon has no paths=).
  loops: [number, number][][];
  pointsStart: number;
  pointsEnd: number;
  // null when the polygon has no paths= argument.
  pathsRange: { start: number; end: number } | null;
  // What sits between the plane wrap and the polygon, so the toolbar knows
  // which follow-up ops make sense (no Offset on an extruded solid).
  extruded: boolean;
  offset: boolean;
}

// polygon(points, paths, convexity): a named argument, or the positional
// one at `position`.
function callArgValue(call: Node, name: string, position: number): Node | null {
  const argsNode = call.childForFieldName('arguments')?.namedChild(0);
  for (let i = 0; i < (argsNode?.namedChildCount ?? 0); i++) {
    const argument = argsNode!.namedChild(i);
    const argName = argument?.childForFieldName('name')?.text ?? null;
    if (argName === name || (argName === null && i === position)) {
      return argument?.childForFieldName('value') ?? argument?.child(0) ?? null;
    }
  }
  return null;
}

// The single child of a `op(...) { child; }` or `op(...) child;` — null for
// zero or several children, since "edit the extruded sketch" only has one
// honest meaning when there's exactly one profile underneath.
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

function readLiteralPoints(vec: Node): [number, number][] | null {
  const points: [number, number][] = [];
  for (const pointNode of vec.namedChildren) {
    if (!pointNode || pointNode.type !== 'vector_expression' || pointNode.namedChildCount !== 2) return null;
    const u = readNumber(pointNode.namedChild(0));
    const v = readNumber(pointNode.namedChild(1));
    if (u === null || v === null) return null;
    points.push([u, v]);
  }
  return points;
}

function readLiteralPaths(vec: Node): number[][] | null {
  const paths: number[][] = [];
  for (const pathNode of vec.namedChildren) {
    if (!pathNode || pathNode.type !== 'vector_expression') return null;
    const path: number[] = [];
    for (const indexNode of pathNode.namedChildren) {
      const i = readNumber(indexNode);
      if (i === null || !Number.isInteger(i)) return null;
      path.push(i);
    }
    paths.push(path);
  }
  return paths;
}

// Recognizes the shapes sketch mode itself produces: a bare
// `[translate(...)] [rotate(...)] polygon(points=[...][, paths=[...]]);`
// (Finish Sketch), optionally with an offset() (the Offset op) and/or a
// linear_extrude (Finish Sketch → Linear Extrude, see wrapInExtrude) between
// the wrap and the polygon. Deliberately strict — anything this can't
// round-trip exactly returns null, and the toolbar simply doesn't offer
// "Edit Sketch" for that node:
// - points and paths must be literal numbers (a vector built from variables
//   or expressions has no single position to drag; rewriting it as literals
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
  const extruded = call.childForFieldName('name')?.text === 'linear_extrude';
  if (extruded) call = soleChildCall(call);
  const offset = call?.childForFieldName('name')?.text === 'offset';
  if (call && offset) call = soleChildCall(call);
  if (!call || call.childForFieldName('name')?.text !== 'polygon') return null;
  const vec = callArgValue(call, 'points', 0);
  if (!vec || vec.type !== 'vector_expression') return null;
  const points = readLiteralPoints(vec);
  if (!points) return null;
  const pathsNode = callArgValue(call, 'paths', 1);
  // `paths=undef` is OpenSCAD's own default, same as leaving it out.
  const hasPaths = pathsNode !== null && pathsNode.text !== 'undef';
  if (hasPaths && pathsNode.type !== 'vector_expression') return null;
  const paths = hasPaths ? readLiteralPaths(pathsNode) : null;
  if (hasPaths && !paths) return null;
  const loops = loopsFromPolygon(points, paths);
  if (!loops) return null;
  return {
    origin: transform.translate,
    rotationDeg: transform.rotateDeg,
    loops,
    pointsStart: vec.startIndex,
    pointsEnd: vec.endIndex,
    pathsRange: hasPaths ? { start: pathsNode.startIndex, end: pathsNode.endIndex } : null,
    extruded,
    offset,
  };
}

// Kept local (rather than importing sketchEditing.ts) so this module stays
// free of renderer-state helpers; same rules as polygonToProfiles there.
function loopsFromPolygon(points: [number, number][], paths: number[][] | null): [number, number][][] | null {
  if (!paths) return points.length >= 3 ? [points] : null;
  const loops: [number, number][][] = [];
  for (const path of paths) {
    if (path.length < 3 || path.some((i) => i < 0 || i >= points.length)) return null;
    loops.push(path.map((i) => points[i]));
  }
  return loops.length > 0 ? loops : null;
}

export function formatSketchPoints(points: [number, number][]): string {
  return `[${points.map(([u, v]) => `[${formatNumber(u)}, ${formatNumber(v)}]`).join(', ')}]`;
}

function flattenLoops(loops: [number, number][][]): { points: [number, number][]; paths: number[][] } {
  const points: [number, number][] = [];
  const paths: number[][] = [];
  for (const loop of loops) {
    paths.push(loop.map((_, i) => points.length + i));
    points.push(...loop);
  }
  return { points, paths };
}

function formatPaths(paths: number[][]): string {
  return `[${paths.map((p) => `[${p.join(', ')}]`).join(', ')}]`;
}

// polygon()'s argument list for a sketch: points only for a single loop,
// points + paths for several.
export function formatSketchPolygonArgs(loops: [number, number][][]): string {
  const { points, paths } = flattenLoops(loops);
  const pointsArg = `points=${formatSketchPoints(points)}`;
  return loops.length > 1 ? `${pointsArg}, paths=${formatPaths(paths)}` : pointsArg;
}

// Saving an edited sketch: only the points vector's own bytes change (plus
// the paths vector, when the polygon has or now needs one) — the plane
// wrap, any extrude/offset around it, convexity, modifiers, color, comments
// and formatting all stay exactly as they were (same minimal-diff rule as
// patchArgument). A single loop saved into a polygon that never had paths=
// leaves the call exactly as before apart from the points.
export function patchSketchPoints(source: string, profile: SketchProfile, loops: [number, number][][]): string {
  const { points, paths } = flattenLoops(loops);
  const pointsText = formatSketchPoints(points);
  if (profile.pathsRange) {
    const { start, end } = profile.pathsRange;
    const pathsText = formatPaths(paths);
    // Two in-place replacements; do the later one first so the earlier
    // offsets stay valid.
    if (start > profile.pointsStart) {
      const withPaths = source.slice(0, start) + pathsText + source.slice(end);
      return withPaths.slice(0, profile.pointsStart) + pointsText + withPaths.slice(profile.pointsEnd);
    }
    const withPoints = source.slice(0, profile.pointsStart) + pointsText + source.slice(profile.pointsEnd);
    return withPoints.slice(0, start) + pathsText + withPoints.slice(end);
  }
  const insertPaths = loops.length > 1 ? `, paths=${formatPaths(paths)}` : '';
  return source.slice(0, profile.pointsStart) + pointsText + insertPaths + source.slice(profile.pointsEnd);
}
